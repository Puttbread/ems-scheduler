import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateSchedule } from '@/lib/scheduler/engine';
import type {
  AvailabilityInput,
  CycleHoursInput,
  EmployeeInput,
  PreferencesInput,
} from '@/lib/scheduler/types';

/**
 * POST /api/schedule/generate
 * Body: { scheduleId: string }
 *
 * Full regeneration, per confirmed design: clears any existing shift_slots
 * (assignments cascade-delete with them) for this schedule and rebuilds
 * from current availability/preferences/cycle_hours. Safe to call
 * repeatedly -- that's how "admin can re-run" is supported.
 */
export async function POST(request: Request) {
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

  const { scheduleId } = await request.json();
  if (!scheduleId) {
    return NextResponse.json({ error: 'scheduleId is required' }, { status: 400 });
  }

  const { data: schedule, error: schedErr } = await supabase
    .from('schedules')
    .select('id, start_date')
    .eq('id', scheduleId)
    .single();
  if (schedErr || !schedule) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  }

  // Mark as processing while we work -- gives the UI something to show
  // and (via RLS's schedule_is_collecting check) immediately locks
  // employee availability edits for the duration.
  await supabase.from('schedules').update({ status: 'processing' }).eq('id', scheduleId);

  const [{ data: employees }, { data: availability }, { data: preferences }, { data: partners }, { data: cycleHours }, { data: overrides }] =
    await Promise.all([
      supabase.from('profiles').select('id, full_name, fte, is_sch_employee').eq('active', true).eq('role', 'employee'),
      supabase.from('availability').select('employee_id, work_date, option').eq('schedule_id', scheduleId),
      supabase.from('preferences').select('*').eq('schedule_id', scheduleId),
      supabase.from('preferred_partners').select('employee_id, partner_id').eq('schedule_id', scheduleId),
      supabase.from('cycle_hours').select('*').eq('schedule_id', scheduleId),
      supabase.from('schedule_overrides').select('*').eq('schedule_id', scheduleId),
    ]);

  const employeeInputs: EmployeeInput[] = (employees ?? []).map((e) => ({
    id: e.id,
    fullName: e.full_name,
    fte: Number(e.fte),
    isSchEmployee: e.is_sch_employee,
  }));

  const availabilityInputs: AvailabilityInput[] = (availability ?? []).map((a) => ({
    employeeId: a.employee_id,
    date: a.work_date,
    option: a.option,
  }));

  const partnersByEmployee = new Map<string, string[]>();
  (partners ?? []).forEach((p) => {
    if (!partnersByEmployee.has(p.employee_id)) partnersByEmployee.set(p.employee_id, []);
    partnersByEmployee.get(p.employee_id)!.push(p.partner_id);
  });

  const preferencesInputs: PreferencesInput[] = (preferences ?? []).map((p) => ({
    employeeId: p.employee_id,
    preferFriSunSameWeekend: p.prefer_fri_sun_same_weekend,
    maxConsecutiveShifts: p.max_consecutive_shifts,
    preferredDaysOfWeek: p.preferred_days_of_week ?? [],
    noDayPreference: p.no_day_preference,
    preferredPartnerIds: partnersByEmployee.get(p.employee_id) ?? [],
  }));

  const cycleHoursInputs: CycleHoursInput[] = (cycleHours ?? []).map((c) => ({
    employeeId: c.employee_id,
    vacationHours: Number(c.vacation_hours),
    edHours: Number(c.ed_hours),
    otherHours: Number(c.other_hours),
  }));

  const overrideInputs = (overrides ?? []).map((o) => ({
    date: o.work_date,
    slotNumber: o.slot_number as 1 | 2,
    portion: o.portion,
    overrideType: o.override_type as 'exempt' | 'fixed',
    employeeId: o.employee_id ?? undefined,
  }));

  const result = generateSchedule({
    startDate: schedule.start_date,
    employees: employeeInputs,
    availability: availabilityInputs,
    preferences: preferencesInputs,
    cycleHours: cycleHoursInputs,
    overrides: overrideInputs,
  });

  // Full regeneration: wipe existing slots (assignments cascade with them).
  await supabase.from('shift_slots').delete().eq('schedule_id', scheduleId);

  // Re-derive the (date, slotNumber) -> shift_slot rows needed, insert them,
  // then insert assignments referencing the new slot IDs.
  const slotKeyToId = new Map<string, string>();
  const slotRows = result.assignments.map((a) => ({
    schedule_id: scheduleId,
    work_date: a.date,
    shift_type: a.shiftType,
    slot_number: a.slotNumber,
  }));

  const { data: insertedSlots, error: slotErr } = await supabase
    .from('shift_slots')
    .insert(slotRows)
    .select('id, work_date, shift_type, slot_number');

  if (slotErr) {
    return NextResponse.json({ error: `Failed to write shift slots: ${slotErr.message}` }, { status: 500 });
  }

  (insertedSlots ?? []).forEach((s) => {
    slotKeyToId.set(`${s.work_date}|${s.shift_type}|${s.slot_number}`, s.id);
  });

  const assignmentRows = result.assignments.map((a) => ({
    shift_slot_id: slotKeyToId.get(`${a.date}|${a.shiftType}|${a.slotNumber}`)!,
    employee_id: a.employeeId,
    schedule_id: scheduleId,
    assignment_score: a.score,
  }));

  const { error: assignErr } = await supabase.from('assignments').insert(assignmentRows);
  if (assignErr) {
    return NextResponse.json({ error: `Failed to write assignments: ${assignErr.message}` }, { status: 500 });
  }

  await supabase
    .from('schedules')
    .update({
      status: 'published',
      shortfall_days: result.shortfallDays,
      generated_at: new Date().toISOString(),
      generated_by: user.id,
    })
    .eq('id', scheduleId);

  return NextResponse.json({
    success: true,
    shortfallDays: result.shortfallDays,
    unfilledSlotsCount: result.unfilledSlots.length,
    unfilledSlots: result.unfilledSlots,
    employeeHoursSummary: result.employeeHoursSummary,
  });
}
