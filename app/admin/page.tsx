'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { TopBar } from '@/components/TopBar';

function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function AdminDashboard() {
  const supabase = createClient();
  const [schedules, setSchedules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newStart, setNewStart] = useState('');
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('schedules')
      .select('*')
      .order('start_date', { ascending: false });
    setSchedules(data ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function createSchedule() {
    if (!newStart) return;
    setCreating(true);

    const { data: created } = await supabase
      .from('schedules')
      .insert({
        start_date: newStart,
        end_date: addDays(newStart, 41),
        status: 'collecting',
      })
      .select('id, start_date')
      .single();

    if (created) {
      // Copy forward overrides from the most recent prior cycle, as
      // editable defaults -- translated by day-offset within the cycle
      // (e.g. "day 8 of the cycle") rather than literal date, so a
      // Monday pattern lands on the equivalent Monday of the new cycle.
      const { data: priorSchedule } = await supabase
        .from('schedules')
        .select('id, start_date')
        .neq('id', created.id)
        .order('start_date', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (priorSchedule) {
        const { data: priorOverrides } = await supabase
          .from('schedule_overrides')
          .select('work_date, slot_number, portion, override_type, employee_id, note')
          .eq('schedule_id', priorSchedule.id);

        if (priorOverrides && priorOverrides.length > 0) {
          const priorStart = new Date(priorSchedule.start_date + 'T00:00:00Z').getTime();
          const newStartMs = new Date(created.start_date + 'T00:00:00Z').getTime();

          const translated = priorOverrides.map((o) => {
            const dayOffset = Math.round(
              (new Date(o.work_date + 'T00:00:00Z').getTime() - priorStart) / 86_400_000
            );
            const newDate = new Date(newStartMs + dayOffset * 86_400_000)
              .toISOString()
              .slice(0, 10);
            return {
              schedule_id: created.id,
              work_date: newDate,
              slot_number: o.slot_number,
              portion: o.portion,
              override_type: o.override_type,
              employee_id: o.employee_id,
              note: o.note,
              carried_forward_from: priorSchedule.id,
            };
          });

          await supabase.from('schedule_overrides').insert(translated);
        }
      }
    }

    setNewStart('');
    setCreating(false);
    load();
  }

  async function runSchedule(id: string) {
    setRunningId(id);
    setRunResult(null);
    const res = await fetch('/api/schedule/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleId: id }),
    });
    const json = await res.json();
    setRunResult({ id, ...json });
    setRunningId(null);
    load();
  }

  function exportUrl(id: string, format: 'csv' | 'xlsx') {
    return `/api/schedule/export?scheduleId=${id}&format=${format}`;
  }

  return (
    <div className="shell">
      <TopBar role="admin" />
      <div className="main">
        <div className="eyebrow">Administrator</div>
        <h1>Schedules</h1>

        <div className="card">
          <h2>Open a new 6-week cycle</h2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Start date</label>
              <input type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
            </div>
            <button className="btn" onClick={createSchedule} disabled={!newStart || creating}>
              {creating ? 'Creating…' : 'Create schedule'}
            </button>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: 8 }}>
            Employees will be able to submit availability and preferences for this cycle
            immediately.
          </p>
        </div>

        {loading ? (
          <p>Loading…</p>
        ) : (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Status</th>
                  <th>Shortfall</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/admin/schedule/${s.id}`}>
                        {s.start_date} → {s.end_date}
                      </Link>
                    </td>
                    <td>
                      <span className={`status-pill ${s.status}`}>{s.status}</span>
                    </td>
                    <td>{s.shortfall_days > 0 ? `${s.shortfall_days} day(s)` : '—'}</td>
                    <td style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn secondary"
                        onClick={() => runSchedule(s.id)}
                        disabled={runningId === s.id}
                      >
                        {runningId === s.id
                          ? 'Running…'
                          : s.status === 'published'
                          ? 'Re-run'
                          : 'Run schedule'}
                      </button>
                      {s.status === 'published' && (
                        <>
                          <a className="btn secondary" href={exportUrl(s.id, 'xlsx')}>
                            Export XLS
                          </a>
                          <a className="btn secondary" href={exportUrl(s.id, 'csv')}>
                            Export CSV
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {runResult && (
          <div className="card">
            <h2>Run result</h2>
            {runResult.error ? (
              <p style={{ color: 'var(--red)' }}>{runResult.error}</p>
            ) : (
              <>
                <p>
                  Shortfall: <strong>{runResult.shortfallDays}</strong> day(s) removed per
                  employee.
                </p>
                <p>
                  Unfilled coverage slots: <strong>{runResult.unfilledSlotsCount}</strong>{' '}
                  {runResult.unfilledSlotsCount > 0 && '(shown on the schedule detail page)'}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
