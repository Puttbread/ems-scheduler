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
  const [readiness, setReadiness] = useState<
    { id: string; full_name: string; is_ready: boolean; ready_at: string | null }[]
  >([]);
  const [readinessSchedule, setReadinessSchedule] = useState<any | null>(null);

  const [debugInfo, setDebugInfo] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('schedules')
      .select('*')
      .order('start_date', { ascending: false });
    setSchedules(data ?? []);

    const collecting = (data ?? []).find((s) => s.status === 'collecting');
    setReadinessSchedule(collecting ?? null);
    const openCount = (data ?? []).filter((s) => s.status === 'collecting' || s.status === 'processing').length;
    if (openCount > 1) {
      setActionError(
        `Warning: ${openCount} schedules are currently open (collecting/processing) at once. ` +
          `The readiness panel and "Run schedule" only ever apply to one specific cycle at a time -- ` +
          `double-check you're looking at the same one you intend to run, or unlock/delete the extra cycle.`
      );
    }
    if (collecting) {
      const [
        { data: employees, error: employeesError },
        { data: hoursRows, error: hoursError },
      ] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, full_name')
          .eq('active', true)
          .eq('role', 'employee')
          .order('full_name'),
        supabase
          .from('cycle_hours')
          .select('employee_id, is_ready, ready_at')
          .eq('schedule_id', collecting.id),
      ]);
      setDebugInfo({
        queriedScheduleId: collecting.id,
        employees,
        employeesError: employeesError?.message ?? null,
        hoursRows,
        hoursError: hoursError?.message ?? null,
      });
      const readyMap = new Map((hoursRows ?? []).map((h) => [h.employee_id, h]));
      setReadiness(
        (employees ?? []).map((e) => ({
          id: e.id,
          full_name: e.full_name,
          is_ready: readyMap.get(e.id)?.is_ready ?? false,
          ready_at: readyMap.get(e.id)?.ready_at ?? null,
        }))
      );
    } else {
      setReadiness([]);
      setDebugInfo(null);
    }

    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function createSchedule() {
    if (!newStart) return;

    const openSchedule = schedules.find((s) => s.status === 'collecting' || s.status === 'processing');
    if (openSchedule) {
      const proceed = window.confirm(
        `There's already an open cycle (${openSchedule.start_date} → ${openSchedule.end_date}, status: ${openSchedule.status}). ` +
          `Having two open cycles at once is a common source of confusion -- employee availability and the "ready" panel ` +
          `will only ever reflect ONE of them. Are you sure you want to create another?`
      );
      if (!proceed) return;
    }

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

  const [actionError, setActionError] = useState<string | null>(null);

  async function deleteSchedule(id: string, label: string) {
    const confirmed = window.confirm(
      `Permanently delete the schedule ${label}? This removes all availability, preferences, and assignments for this cycle. This cannot be undone.`
    );
    if (!confirmed) return;
    const doubleConfirmed = window.confirm('Really delete it? This is permanent.');
    if (!doubleConfirmed) return;

    setActionError(null);
    const { error } = await supabase.from('schedules').delete().eq('id', id);
    if (error) {
      setActionError(`Couldn't delete: ${error.message}`);
      return;
    }
    load();
  }

  async function unlockSchedule(id: string) {
    const confirmed = window.confirm(
      'Reopen this schedule for editing? Employees will be able to change their availability again, and you can re-run the schedule once they\'re done.'
    );
    if (!confirmed) return;
    setActionError(null);
    const { error } = await supabase.from('schedules').update({ status: 'collecting' }).eq('id', id);
    if (error) {
      setActionError(`Couldn't unlock: ${error.message}`);
      return;
    }
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

        {actionError && (
          <div className="warn-note" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
            {actionError}
          </div>
        )}

        {debugInfo && (
          <details className="card" style={{ fontSize: '0.78rem' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--amber)' }}>
              Debug: raw readiness query data (temporary, click to expand)
            </summary>
            <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)', marginTop: 10 }}>
              {JSON.stringify(debugInfo, null, 2)}
            </pre>
          </details>
        )}

        {readiness.length > 0 ? (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ marginBottom: 0 }}>Availability status</h2>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
                  {readiness.filter((r) => r.is_ready).length} of {readiness.length} ready
                </span>
                <button className="btn secondary" onClick={load} style={{ padding: '4px 10px', fontSize: '0.75rem' }}>
                  Refresh
                </button>
              </div>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: 4 }}>
              For {readinessSchedule?.start_date} → {readinessSchedule?.end_date} (the cycle
              currently collecting availability).
            </p>
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Marked ready</th>
                </tr>
              </thead>
              <tbody>
                {readiness.map((r) => (
                  <tr key={r.id}>
                    <td>{r.full_name}</td>
                    <td>
                      <span
                        className="status-pill"
                        style={{
                          color: r.is_ready ? 'var(--green)' : 'var(--amber)',
                          borderColor: r.is_ready ? '#2c4a34' : 'var(--amber-dim)',
                        }}
                      >
                        {r.is_ready ? 'Ready' : 'Not ready'}
                      </span>
                    </td>
                    <td>{r.ready_at ? new Date(r.ready_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !loading && (
            <div className="card">
              <p style={{ color: 'var(--muted)', margin: 0 }}>
                No schedule is currently collecting availability, so there's nothing to show
                readiness for. If you expected to see one, check that the schedule you're working
                with is in "collecting" status below (use "Unlock for editing" if it was already
                run).
              </p>
            </div>
          )
        )}

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
                    <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                      {(s.status === 'published' || s.status === 'processing') && (
                        <button className="btn secondary" onClick={() => unlockSchedule(s.id)}>
                          Unlock for editing
                        </button>
                      )}
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
                      <button
                        className="btn danger"
                        onClick={() => deleteSchedule(s.id, `${s.start_date} → ${s.end_date}`)}
                      >
                        Delete
                      </button>
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
