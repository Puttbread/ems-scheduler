'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TopBar } from '@/components/TopBar';
import { WeekedCalendar } from '@/components/WeekedCalendar';

type AvailOption =
  | 'available_24'
  | 'available_12_day'
  | 'available_12_night'
  | 'available_last_resort'
  | 'not_available';

const OPTION_LABELS: Record<AvailOption, string> = {
  available_24: 'Available 24 hours',
  available_12_day: 'Available 12 hours Day',
  available_12_night: 'Available 12 hours Night',
  available_last_resort: 'Available last resort',
  not_available: 'Not available',
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function EmployeePage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string>('');
  const [schedule, setSchedule] = useState<any | null>(null);
  const [availability, setAvailability] = useState<Record<string, AvailOption>>({});
  const [hours, setHours] = useState({
    vacation_hours: 0,
    ed_hours: 0,
    other_hours: 0,
    is_ready: false,
    ready_at: null as string | null,
  });
  const [assignments, setAssignments] = useState<any[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .single();
    setFullName(profile?.full_name ?? '');

    // Prefer an in-progress ("collecting") cycle; otherwise show the most
    // recently published one.
    const { data: collecting } = await supabase
      .from('schedules')
      .select('*')
      .eq('status', 'collecting')
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    let current = collecting;
    if (!current) {
      const { data: published } = await supabase
        .from('schedules')
        .select('*')
        .eq('status', 'published')
        .order('start_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      current = published;
    }
    setSchedule(current);

    if (current) {
      const { data: avail } = await supabase
        .from('availability')
        .select('work_date, option')
        .eq('schedule_id', current.id)
        .eq('employee_id', user.id);
      const map: Record<string, AvailOption> = {};
      (avail ?? []).forEach((a) => (map[a.work_date] = a.option as AvailOption));
      setAvailability(map);

      const { data: ch } = await supabase
        .from('cycle_hours')
        .select('vacation_hours, ed_hours, other_hours, is_ready, ready_at')
        .eq('schedule_id', current.id)
        .eq('employee_id', user.id)
        .maybeSingle();
      if (ch) setHours(ch as any);

      if (current.status === 'published') {
        const { data: a } = await supabase
          .from('assignments')
          .select('employee_id, profiles(full_name), shift_slots(work_date, shift_type, slot_number)')
          .eq('schedule_id', current.id);
        setAssignments(a ?? []);
      }
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const [bulkOption, setBulkOption] = useState<AvailOption>('available_24');
  const [bulkApplying, setBulkApplying] = useState(false);

  async function applyToAllDays() {
    if (!schedule || !userId) return;
    const confirmed = window.confirm(
      `Set all 42 days to "${OPTION_LABELS[bulkOption]}"? This overwrites any days you've already filled in.`
    );
    if (!confirmed) return;

    setBulkApplying(true);
    setSaveError(null);
    const allDays = Array.from({ length: 42 }, (_, i) => addDays(schedule.start_date, i));
    const rows = allDays.map((date) => ({
      employee_id: userId,
      schedule_id: schedule.id,
      work_date: date,
      option: bulkOption,
    }));

    const { error } = await supabase
      .from('availability')
      .upsert(rows, { onConflict: 'employee_id,schedule_id,work_date' });

    setBulkApplying(false);
    if (error) {
      setSaveError(`Couldn't apply to all days: ${error.message}`);
      return;
    }
    setAvailability(Object.fromEntries(allDays.map((d) => [d, bulkOption])));
  }

  const [saveError, setSaveError] = useState<string | null>(null);

  async function updateAvailability(date: string, option: AvailOption) {
    if (!schedule || !userId) return;
    setSaving(date);
    setSaveError(null);
    const { error } = await supabase.from('availability').upsert(
      {
        employee_id: userId,
        schedule_id: schedule.id,
        work_date: date,
        option,
      },
      { onConflict: 'employee_id,schedule_id,work_date' }
    );
    setSaving(null);
    if (error) {
      setSaveError(`Couldn't save ${date}: ${error.message}`);
      return; // don't update local display if the write actually failed
    }
    setAvailability((prev) => ({ ...prev, [date]: option }));
  }

  async function saveHours() {
    if (!schedule || !userId) return;
    await supabase.from('cycle_hours').upsert(
      {
        employee_id: userId,
        schedule_id: schedule.id,
        vacation_hours: hours.vacation_hours,
        ed_hours: hours.ed_hours,
        other_hours: hours.other_hours,
        is_ready: hours.is_ready,
        ready_at: hours.ready_at,
      },
      { onConflict: 'employee_id,schedule_id' }
    );
  }

  const [readyError, setReadyError] = useState<string | null>(null);

  async function toggleReady() {
    if (!schedule || !userId) return;
    setReadyError(null);
    const nextReady = !hours.is_ready;
    const nextReadyAt = nextReady ? new Date().toISOString() : null;
    const { error } = await supabase.from('cycle_hours').upsert(
      {
        employee_id: userId,
        schedule_id: schedule.id,
        vacation_hours: hours.vacation_hours,
        ed_hours: hours.ed_hours,
        other_hours: hours.other_hours,
        is_ready: nextReady,
        ready_at: nextReadyAt,
      },
      { onConflict: 'employee_id,schedule_id' }
    );
    if (error) {
      setReadyError(`Couldn't save: ${error.message}`);
      return; // don't update local state if the write actually failed
    }
    setHours((h) => ({ ...h, is_ready: nextReady, ready_at: nextReadyAt }));
  }

  if (loading) {
    return (
      <div className="shell">
        <TopBar role="employee" />
        <div className="main">Loading…</div>
      </div>
    );
  }

  if (!schedule) {
    return (
      <div className="shell">
        <TopBar role="employee" />
        <div className="main">
          <h2 style={{ fontSize: '1.3rem', marginBottom: 20 }}>Welcome, {fullName}</h2>
          <div className="card">
            <h2>No active schedule</h2>
            <p style={{ color: 'var(--muted)' }}>
              There's no schedule currently collecting availability or published. Check back once
              your administrator opens a new 6-week cycle.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const days = Array.from({ length: 42 }, (_, i) => addDays(schedule.start_date, i));
  const isCollecting = schedule.status === 'collecting';

  return (
    <div className="shell">
      <TopBar role="employee" />
      <div className="main">
        <h2 style={{ fontSize: '1.3rem', marginBottom: 20 }}>Welcome, {fullName}</h2>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="eyebrow">6-week cycle</div>
            <h1>
              {schedule.start_date} → {schedule.end_date}
            </h1>
          </div>
          <span className={`status-pill ${schedule.status}`}>{schedule.status}</span>
        </div>

        {!isCollecting && (
          <div className="warn-note">
            This schedule is <strong>{schedule.status}</strong>, not collecting availability.
            Your view below is read-only. If you need to make changes, ask your administrator to
            unlock the schedule for editing.
          </div>
        )}
        {saveError && <div className="warn-note" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{saveError}</div>}

        {isCollecting ? (
          <>
            <div
              className="card"
              style={{
                borderColor: hours.is_ready ? 'var(--green)' : 'var(--amber-dim)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <div>
                <h2 style={{ marginBottom: 4 }}>
                  {hours.is_ready ? '✓ Marked ready' : 'Availability not yet marked ready'}
                </h2>
                <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: 0 }}>
                  {hours.is_ready
                    ? `Your administrator can see you're done. Marked ready ${
                        hours.ready_at ? new Date(hours.ready_at).toLocaleString() : ''
                      }. You can still make changes below -- just re-mark ready if you do.`
                    : "Once you've filled out every day below and your hours, mark yourself ready so your administrator knows you're done."}
                </p>
              </div>
              <button
                className={hours.is_ready ? 'btn secondary' : 'btn'}
                onClick={toggleReady}
              >
                {hours.is_ready ? 'Mark not ready' : "I'm ready"}
              </button>
              {readyError && (
                <p style={{ color: 'var(--red)', fontSize: '0.8rem', width: '100%', margin: 0 }}>
                  {readyError}
                </p>
              )}
            </div>

            <div className="card">
              <h2>Your availability</h2>
              <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
                Set your availability for each day. This locks once the administrator runs the
                schedule.
              </p>

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                  padding: '10px 12px',
                  marginBottom: 16,
                }}
              >
                <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>Quick fill:</span>
                <select
                  value={bulkOption}
                  onChange={(e) => setBulkOption(e.target.value as AvailOption)}
                  style={{ fontSize: '0.82rem' }}
                >
                  {Object.entries(OPTION_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>
                <button className="btn secondary" onClick={applyToAllDays} disabled={bulkApplying}>
                  {bulkApplying ? 'Applying…' : 'Apply to all 42 days'}
                </button>
                <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
                  You can still adjust individual days below afterward.
                </span>
              </div>

              <div style={{ marginTop: 16 }}>
                <WeekedCalendar
                  startDate={schedule.start_date}
                  renderDay={(date) => {
                    const d = new Date(date + 'T00:00:00Z');
                    return (
                      <div className="day-cell" key={date}>
                        <div className="date-label">
                          {DOW[d.getUTCDay()]} {date.slice(5)}
                        </div>
                        <select
                          value={availability[date] ?? 'not_available'}
                          onChange={(e) => updateAvailability(date, e.target.value as AvailOption)}
                          style={{ fontSize: '0.72rem', padding: '4px 6px' }}
                        >
                          {Object.entries(OPTION_LABELS).map(([val, label]) => (
                            <option key={val} value={val}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {saving === date && (
                          <span style={{ fontSize: '0.65rem', color: 'var(--amber)' }}>saving…</span>
                        )}
                      </div>
                    );
                  }}
                />
              </div>
            </div>

            <div className="card">
              <h2>Hours used this cycle</h2>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <div className="form-row">
                  <label>Vacation hours</label>
                  <input
                    type="number"
                    min={0}
                    value={hours.vacation_hours}
                    onChange={(e) =>
                      setHours((h) => ({ ...h, vacation_hours: Number(e.target.value) }))
                    }
                    onBlur={saveHours}
                  />
                </div>
                <div className="form-row">
                  <label>ED (education) hours</label>
                  <input
                    type="number"
                    min={0}
                    value={hours.ed_hours}
                    onChange={(e) => setHours((h) => ({ ...h, ed_hours: Number(e.target.value) }))}
                    onBlur={saveHours}
                  />
                </div>
                <div className="form-row">
                  <label>Other hours</label>
                  <input
                    type="number"
                    min={0}
                    value={hours.other_hours}
                    onChange={(e) =>
                      setHours((h) => ({ ...h, other_hours: Number(e.target.value) }))
                    }
                    onBlur={saveHours}
                  />
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="card">
            <h2>Assigned schedule</h2>
            <div style={{ marginTop: 16 }}>
              <WeekedCalendar
                startDate={schedule.start_date}
                renderDay={(date) => {
                  const d = new Date(date + 'T00:00:00Z');
                  const dayShifts = assignments.filter((a) => a.shift_slots?.work_date === date);
                  return (
                    <div className="day-cell" key={date}>
                      <div className="date-label">
                        {DOW[d.getUTCDay()]} {date.slice(5)}
                      </div>
                      {dayShifts.map((a, i) => {
                        const type = a.shift_slots.shift_type;
                        const mine = a.employee_id === userId;
                        const cls = type === 'full_24' ? 'full24' : type === 'day_12' ? 'day' : 'night';
                        return (
                          <span
                            key={i}
                            className={`badge ${cls}`}
                            style={mine ? { boxShadow: '0 0 0 1.5px var(--amber)' } : undefined}
                          >
                            {a.profiles?.full_name ?? '—'}
                          </span>
                        );
                      })}
                    </div>
                  );
                }}
              />
            </div>
            <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: 12 }}>
              Your shifts are outlined in amber.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
