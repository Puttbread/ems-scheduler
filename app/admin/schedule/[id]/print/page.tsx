'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { WeekedCalendar } from '@/components/WeekedCalendar';
import { computeCoverageGaps } from '@/lib/scheduler/coverage';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHIFT_LABELS: Record<string, string> = {
  day_12: 'Day',
  night_12: 'Night',
  full_24: '24hr',
};

export default function PrintableSchedulePage() {
  const { id } = useParams<{ id: string }>();
  const supabase = createClient();
  const [schedule, setSchedule] = useState<any | null>(null);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data: sched } = await supabase.from('schedules').select('*').eq('id', id).single();
    setSchedule(sched);
    const { data: a } = await supabase
      .from('assignments')
      .select('employee_id, profiles(full_name), shift_slots(work_date, shift_type, slot_number)')
      .eq('schedule_id', id);
    setAssignments(a ?? []);
    const { data: ov } = await supabase
      .from('schedule_overrides')
      .select('work_date, slot_number, portion, override_type')
      .eq('schedule_id', id);
    setOverrides(ov ?? []);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !schedule) {
    return <div style={{ padding: 24, fontFamily: 'sans-serif' }}>Loading…</div>;
  }

  const gaps = computeCoverageGaps({ startDate: schedule.start_date, assignments, overrides });
  const gapDates = new Set(gaps.map((g) => g.date));

  return (
    <div className="print-page">
      <style jsx global>{`
        body {
          background: white;
          color: black;
          font-family: -apple-system, sans-serif;
        }
        .print-page {
          max-width: 900px;
          margin: 0 auto;
          padding: 24px;
        }
        .print-week {
          margin-bottom: 24px;
          page-break-inside: avoid;
        }
        .print-week h3 {
          font-size: 1rem;
          border-bottom: 2px solid #333;
          padding-bottom: 4px;
          margin-bottom: 8px;
        }
        .print-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 6px;
        }
        .print-day {
          border: 1px solid #ccc;
          border-radius: 4px;
          padding: 6px;
          min-height: 80px;
          font-size: 0.75rem;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .print-day .label {
          font-weight: 600;
          font-size: 0.7rem;
          color: #555;
          margin-bottom: 4px;
        }
        .print-shift {
          display: block;
          margin-bottom: 2px;
        }
        .no-print {
          margin-bottom: 20px;
        }
        .print-page h3 {
          color: #111 !important;
        }
        .print-page h3 span {
          color: #111 !important;
        }
        @media print {
          .no-print {
            display: none;
          }
          .print-page {
            padding: 0;
          }
        }
      `}</style>

      <div className="no-print">
        <button
          onClick={() => window.print()}
          style={{
            padding: '10px 18px',
            background: '#f2a33d',
            border: 'none',
            borderRadius: 4,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Print
        </button>
      </div>

      <h1 style={{ marginBottom: 4 }}>
        Schedule: {schedule.start_date} – {schedule.end_date}
      </h1>
      {schedule.shortfall_days > 0 && (
        <p style={{ color: '#a15c00', fontSize: '0.85rem', marginBottom: 4 }}>
          Note: shortened by {schedule.shortfall_days} day(s) per employee to reach a workable
          schedule.
        </p>
      )}
      {gaps.length > 0 && (
        <p style={{ color: '#b3261e', fontSize: '0.85rem', marginBottom: 20 }}>
          {gaps.length} unfilled slot{gaps.length === 1 ? '' : 's'} -- highlighted below.
        </p>
      )}

      <WeekedCalendar
        startDate={schedule.start_date}
        renderDay={(date) => {
          const dow = new Date(date + 'T00:00:00Z').getUTCDay();
          const dayShifts = assignments.filter((a) => a.shift_slots?.work_date === date);
          const hasGap = gapDates.has(date);
          return (
            <div
              className="print-day"
              key={date}
              style={
                hasGap
                  ? { background: '#fdecea', borderColor: '#b3261e', borderWidth: 2 }
                  : undefined
              }
            >
              <div className="label">
                {DOW[dow].slice(0, 3)} {date.slice(5)}
                {hasGap && <span style={{ color: '#b3261e' }}> ⚠</span>}
              </div>
              {dayShifts.length === 0 ? (
                <span style={{ color: '#999' }}>—</span>
              ) : (
                dayShifts
                  .sort((a, b) => a.shift_slots.slot_number - b.shift_slots.slot_number)
                  .map((a, i) => (
                    <span className="print-shift" key={i}>
                      {SHIFT_LABELS[a.shift_slots.shift_type]}: {a.profiles?.full_name ?? '—'}
                    </span>
                  ))
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
