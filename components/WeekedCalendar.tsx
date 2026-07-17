'use client';

import type { ReactNode } from 'react';

function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Renders a 6-week (42-day) cycle as 6 labeled week blocks -- "Week 1
 * (Oct 12 - Oct 18)" etc -- each containing a 7-column grid of days.
 * `renderDay` is called once per date and should return that day's cell
 * content; this component only owns the week grouping/labeling.
 */
export function WeekedCalendar({
  startDate,
  renderDay,
}: {
  startDate: string;
  renderDay: (date: string) => ReactNode;
}) {
  const weeks = Array.from({ length: 6 }, (_, w) => {
    const weekStart = addDays(startDate, w * 7);
    const weekEnd = addDays(startDate, w * 7 + 6);
    const days = Array.from({ length: 7 }, (_, d) => addDays(startDate, w * 7 + d));
    return { weekStart, weekEnd, days };
  });

  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <>
      {weeks.map((wk, i) => (
        <div key={i} style={{ marginBottom: 22 }}>
          <h3 style={{ fontSize: '0.92rem', marginBottom: 8, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ color: 'var(--amber)' }}>Week {i + 1}</span>
            <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: '0.8rem' }}>
              {fmt(wk.weekStart)} – {fmt(wk.weekEnd)}
            </span>
          </h3>
          <div className="calendar-grid">{wk.days.map((date) => renderDay(date))}</div>
        </div>
      ))}
    </>
  );
}
