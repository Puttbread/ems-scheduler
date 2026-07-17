'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TopBar } from '@/components/TopBar';
import { WeekedCalendar } from '@/components/WeekedCalendar';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function EmployeeHistoryPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [pastSchedules, setPastSchedules] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [assignments, setAssignments] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const { data } = await supabase
      .from('schedules')
      .select('*')
      .in('status', ['published', 'archived'])
      .order('start_date', { ascending: false });
    setPastSchedules(data ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function viewSchedule(schedule: any) {
    setSelected(schedule);
    const { data } = await supabase
      .from('assignments')
      .select('employee_id, profiles(full_name), shift_slots(work_date, shift_type, slot_number)')
      .eq('schedule_id', schedule.id);
    setAssignments(data ?? []);
  }

  if (loading) {
    return (
      <div className="shell">
        <TopBar role="employee" />
        <div className="main">Loading…</div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar role="employee" />
      <div className="main">
        <div className="eyebrow">History</div>
        <h1>Previous schedules</h1>

        {pastSchedules.length === 0 ? (
          <div className="card">
            <p style={{ color: 'var(--muted)', margin: 0 }}>
              No past schedules yet -- locked/published cycles will show up here once your
              administrator runs one.
            </p>
          </div>
        ) : (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pastSchedules.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.start_date} → {s.end_date}
                    </td>
                    <td>
                      <span className={`status-pill ${s.status}`}>{s.status}</span>
                    </td>
                    <td>
                      <button className="btn secondary" onClick={() => viewSchedule(s)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected && (
          <div className="card">
            <h2>
              {selected.start_date} → {selected.end_date}
            </h2>
            <div style={{ marginTop: 16 }}>
              <WeekedCalendar
                startDate={selected.start_date}
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
