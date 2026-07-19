'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { TopBar } from '@/components/TopBar';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHIFT_LABELS: Record<string, string> = {
  day_12: 'Day (12hr)',
  night_12: 'Night (12hr)',
  full_24: 'Full 24hr',
};

function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = createClient();
  const [schedule, setSchedule] = useState<any | null>(null);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingFor, setAddingFor] = useState<string | null>(null); // `${date}|${slotNumber}`
  const [newShiftType, setNewShiftType] = useState('day_12');
  const [newEmployee, setNewEmployee] = useState('');

  // New override form state
  const [ovDate, setOvDate] = useState('');
  const [ovSlot, setOvSlot] = useState<1 | 2>(1);
  const [ovPortion, setOvPortion] = useState<'day_12' | 'night_12' | 'full_24'>('full_24');
  const [ovType, setOvType] = useState<'exempt' | 'fixed'>('exempt');
  const [ovEmployee, setOvEmployee] = useState('');
  const [ovNote, setOvNote] = useState('');

  const [allEmployees, setAllEmployees] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: sched } = await supabase.from('schedules').select('*').eq('id', id).single();
    setSchedule(sched);

    const { data: a } = await supabase
      .from('assignments')
      .select('id, employee_id, shift_slot_id, profiles(full_name), shift_slots(id, work_date, shift_type, slot_number)')
      .eq('schedule_id', id);
    setAssignments(a ?? []);

    const { data: dir } = await supabase.from('staff_directory').select('id, full_name');
    setStaff(dir ?? []);

    const { data: emps } = await supabase
      .from('profiles')
      .select('id, full_name, fte')
      .eq('active', true)
      .eq('role', 'employee')
      .order('full_name');
    setAllEmployees(emps ?? []);

    const { data: ov } = await supabase
      .from('schedule_overrides')
      .select('*, profiles(full_name)')
      .eq('schedule_id', id)
      .order('work_date');
    setOverrides(ov ?? []);

    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    load();
  }, [load]);

  async function addOverride() {
    if (!ovDate) return;
    if (ovType === 'fixed' && !ovEmployee) return;
    await supabase.from('schedule_overrides').insert({
      schedule_id: id,
      work_date: ovDate,
      slot_number: ovSlot,
      portion: ovPortion,
      override_type: ovType,
      employee_id: ovType === 'fixed' ? ovEmployee : null,
      note: ovNote || null,
    });
    setOvDate('');
    setOvNote('');
    setOvEmployee('');
    load();
  }

  async function removeOverride(overrideId: string) {
    await supabase.from('schedule_overrides').delete().eq('id', overrideId);
    load();
  }

  async function reassign(assignmentId: string, employeeId: string) {
    await supabase.from('assignments').update({ employee_id: employeeId }).eq('id', assignmentId);
    load();
  }

  async function removeAssignment(assignmentId: string, shiftSlotId: string) {
    // Deleting the shift_slot cascades to the assignment.
    await supabase.from('shift_slots').delete().eq('id', shiftSlotId);
    load();
  }

  async function addShift(date: string, slotNumber: 1 | 2) {
    if (!newEmployee) return;
    const { data: slot, error } = await supabase
      .from('shift_slots')
      .insert({ schedule_id: id, work_date: date, shift_type: newShiftType, slot_number: slotNumber })
      .select('id')
      .single();
    if (!error && slot) {
      await supabase.from('assignments').insert({
        shift_slot_id: slot.id,
        employee_id: newEmployee,
        schedule_id: id,
      });
    }
    setAddingFor(null);
    setNewEmployee('');
    load();
  }

  if (loading || !schedule) {
    return (
      <div className="shell">
        <TopBar role="admin" />
        <div className="main">Loading…</div>
      </div>
    );
  }

  const days = Array.from({ length: 42 }, (_, i) => addDays(schedule.start_date, i));

  return (
    <div className="shell">
      <TopBar role="admin" />
      <div className="main">
        <div className="eyebrow">Schedule detail</div>
        <h1>
          {schedule.start_date} → {schedule.end_date}
        </h1>
        <span className={`status-pill ${schedule.status}`}>{schedule.status}</span>
        {schedule.shortfall_days > 0 && (
          <div className="warn-note" style={{ marginTop: 12 }}>
            This schedule was shortened by {schedule.shortfall_days} day(s) per employee to reach a
            workable result.
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <a className="btn secondary" href={`/admin/schedule/${id}/print`} target="_blank" rel="noreferrer">
            Printable view
          </a>
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <h2>Staffing summary</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            Target hours are FTE x 240, minus this schedule's shortfall reduction. Use this to
            check whether the shortfall is landing evenly across everyone.
          </p>
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>FTE</th>
                <th>Target hours</th>
                <th>Assigned hours</th>
                <th>Shifts</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {allEmployees.map((e) => {
                const theirs = assignments.filter((a) => a.employee_id === e.id);
                const assignedHours = theirs.reduce(
                  (sum, a) => sum + (a.shift_slots?.shift_type === 'full_24' ? 24 : 12),
                  0
                );
                const rawTarget = Number(e.fte) * 240 - (schedule.shortfall_days ?? 0) * 24;
                const targetHours = Math.max(0, rawTarget);
                const diff = assignedHours - targetHours;
                return (
                  <tr key={e.id}>
                    <td>{e.full_name}</td>
                    <td>{e.fte}</td>
                    <td>{targetHours}</td>
                    <td>{assignedHours}</td>
                    <td>{theirs.length}</td>
                    <td style={{ color: diff < -0.01 ? 'var(--red)' : 'var(--green)' }}>
                      {diff > 0 ? '+' : ''}
                      {diff}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <h2>Overrides</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            Exempt a day/portion from the coverage requirement (e.g. a mandatory training day), or
            fix a specific employee into a day/portion (e.g. a standing recurring pattern) --
            these are respected the next time you run or re-run the schedule.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Date</label>
              <input type="date" value={ovDate} onChange={(e) => setOvDate(e.target.value)} />
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Slot</label>
              <select value={ovSlot} onChange={(e) => setOvSlot(Number(e.target.value) as 1 | 2)}>
                <option value={1}>Slot 1</option>
                <option value={2}>Slot 2</option>
              </select>
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Portion</label>
              <select value={ovPortion} onChange={(e) => setOvPortion(e.target.value as any)}>
                <option value="full_24">Full day</option>
                <option value="day_12">Day half</option>
                <option value="night_12">Night half</option>
              </select>
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Type</label>
              <select value={ovType} onChange={(e) => setOvType(e.target.value as any)}>
                <option value="exempt">Exempt (no coverage needed)</option>
                <option value="fixed">Fixed (lock in an employee)</option>
              </select>
            </div>
            {ovType === 'fixed' && (
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Employee</label>
                <select value={ovEmployee} onChange={(e) => setOvEmployee(e.target.value)}>
                  <option value="">Select…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Note (optional)</label>
              <input value={ovNote} onChange={(e) => setOvNote(e.target.value)} placeholder="e.g. All-staff training" />
            </div>
            <button className="btn" onClick={addOverride}>
              Add override
            </button>
          </div>

          {overrides.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Slot</th>
                  <th>Portion</th>
                  <th>Type</th>
                  <th>Employee</th>
                  <th>Note</th>
                  <th>Origin</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id}>
                    <td>{o.work_date}</td>
                    <td>{o.slot_number}</td>
                    <td>{SHIFT_LABELS[o.portion]}</td>
                    <td>{o.override_type}</td>
                    <td>{o.profiles?.full_name ?? '—'}</td>
                    <td>{o.note ?? '—'}</td>
                    <td style={{ color: o.carried_forward_from ? 'var(--amber)' : 'var(--muted)' }}>
                      {o.carried_forward_from ? 'Carried forward' : 'Set this cycle'}
                    </td>
                    <td>
                      <button
                        className="btn danger"
                        style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                        onClick={() => removeOverride(o.id)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Slot 1</th>
                <th>Slot 2</th>
              </tr>
            </thead>
            <tbody>
              {days.map((date) => {
                const d = new Date(date + 'T00:00:00Z');
                const forSlot = (n: 1 | 2) =>
                  assignments.filter((a) => a.shift_slots?.work_date === date && a.shift_slots?.slot_number === n);
                const overridesFor = (n: 1 | 2) =>
                  overrides.filter((o) => o.work_date === date && o.slot_number === n);
                return (
                  <tr key={date}>
                    <td>
                      {DOW[d.getUTCDay()]} {date}
                    </td>
                    {[1, 2].map((n) => (
                      <td key={n}>
                        {overridesFor(n as 1 | 2).map((o) => (
                          <div
                            key={o.id}
                            style={{ fontSize: '0.7rem', color: 'var(--amber)', marginBottom: 4 }}
                          >
                            {o.override_type === 'exempt' ? '⊘ Exempt' : '📌 Fixed'} ·{' '}
                            {SHIFT_LABELS[o.portion]}
                            {o.note ? ` — ${o.note}` : ''}
                          </div>
                        ))}
                        {forSlot(n as 1 | 2).map((a) => (
                          <div key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                            <span style={{ fontSize: '0.7rem', color: 'var(--muted)', width: 70 }}>
                              {SHIFT_LABELS[a.shift_slots.shift_type]}
                            </span>
                            <select
                              value={a.employee_id}
                              onChange={(e) => reassign(a.id, e.target.value)}
                              style={{ fontSize: '0.75rem' }}
                            >
                              {staff.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.full_name}
                                </option>
                              ))}
                            </select>
                            <button
                              className="btn danger"
                              style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                              onClick={() => removeAssignment(a.id, a.shift_slots.id)}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        {addingFor === `${date}|${n}` ? (
                          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                            <select
                              value={newShiftType}
                              onChange={(e) => setNewShiftType(e.target.value)}
                              style={{ fontSize: '0.7rem' }}
                            >
                              <option value="day_12">Day</option>
                              <option value="night_12">Night</option>
                              <option value="full_24">24hr</option>
                            </select>
                            <select
                              value={newEmployee}
                              onChange={(e) => setNewEmployee(e.target.value)}
                              style={{ fontSize: '0.7rem' }}
                            >
                              <option value="">Select…</option>
                              {staff.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.full_name}
                                </option>
                              ))}
                            </select>
                            <button
                              className="btn"
                              style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                              onClick={() => addShift(date, n as 1 | 2)}
                            >
                              Add
                            </button>
                          </div>
                        ) : (
                          <button
                            className="btn secondary"
                            style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                            onClick={() => setAddingFor(`${date}|${n}`)}
                          >
                            + shift
                          </button>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
