import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import * as XLSX from 'xlsx';

/**
 * GET /api/schedule/export?scheduleId=...&format=csv|xlsx
 *
 * Produces a flat table: one row per shift assignment, columns for date,
 * day of week, shift type, slot number, employee name. A trailing summary
 * section lists each employee's assigned vs. target hours, and -- if the
 * schedule was shortened -- a note stating how many days were shorted,
 * per spec ("a note should be added to the exported schedule").
 */
export async function GET(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const scheduleId = searchParams.get('scheduleId');
  const format = (searchParams.get('format') ?? 'xlsx') as 'csv' | 'xlsx';
  if (!scheduleId) {
    return NextResponse.json({ error: 'scheduleId is required' }, { status: 400 });
  }

  const { data: schedule } = await supabase
    .from('schedules')
    .select('id, start_date, end_date, shortfall_days, status')
    .eq('id', scheduleId)
    .single();
  if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });

  const { data: assignments } = await supabase
    .from('assignments')
    .select('employee_id, profiles(full_name), shift_slots(work_date, shift_type, slot_number)')
    .eq('schedule_id', scheduleId);

  const { data: employees } = await supabase
    .from('profiles')
    .select('id, full_name, fte')
    .eq('active', true)
    .eq('role', 'employee');

  type Row = {
    Date: string;
    Day: string;
    Slot: number;
    'Shift Type': string;
    Employee: string;
  };

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shiftLabel: Record<string, string> = {
    day_12: 'Day (12hr)',
    night_12: 'Night (12hr)',
    full_24: 'Full 24hr',
  };

  const rows: Row[] = (assignments ?? [])
    .map((a: any) => {
      const slot = a.shift_slots;
      const date = new Date(slot.work_date + 'T00:00:00Z');
      return {
        Date: slot.work_date,
        Day: dayNames[date.getUTCDay()],
        Slot: slot.slot_number,
        'Shift Type': shiftLabel[slot.shift_type] ?? slot.shift_type,
        Employee: a.profiles?.full_name ?? 'Unknown',
      };
    })
    .sort((a, b) => a.Date.localeCompare(b.Date) || a.Slot - b.Slot);

  // Hours summary section, recomputed from assignments for the export
  // (independent of the in-memory engine result, so the export always
  // reflects the current DB state even after manual admin edits).
  const hoursByEmployee = new Map<string, number>();
  const shiftHours: Record<string, number> = { day_12: 12, night_12: 12, full_24: 24 };
  (assignments ?? []).forEach((a: any) => {
    const h = shiftHours[a.shift_slots.shift_type] ?? 0;
    hoursByEmployee.set(a.employee_id, (hoursByEmployee.get(a.employee_id) ?? 0) + h);
  });

  const summaryRows = (employees ?? []).map((e) => ({
    Employee: e.full_name,
    FTE: e.fte,
    'Target Hours (approx)': Math.round(Number(e.fte) * 240),
    'Assigned Hours': hoursByEmployee.get(e.id) ?? 0,
  }));

  const wb = XLSX.utils.book_new();
  const scheduleSheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, scheduleSheet, 'Schedule');

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.sheet_add_aoa(
    summarySheet,
    [
      [],
      schedule.shortfall_days > 0
        ? [
            `NOTE: This schedule was shortened by ${schedule.shortfall_days} day(s) per employee ` +
              `to produce a workable schedule (not enough availability to meet everyone's full FTE).`,
          ]
        : ['Schedule met full FTE targets for all employees (subject to availability).'],
    ],
    { origin: -1 }
  );
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Hours Summary');

  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(scheduleSheet);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="schedule_${schedule.start_date}.csv"`,
      },
    });
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="schedule_${schedule.start_date}.xlsx"`,
    },
  });
}
