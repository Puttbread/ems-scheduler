import type { EmployeeState, ShiftType } from './types';

// Shift start/end are expressed as hour-offsets from 00:00 on `date` for
// simplicity -- day = 0..12, night = 12..24, full_24 = 0..24. No specific
// clock times are stored anywhere; these are just used to compute rest
// gaps and durations.
export function shiftHours(type: ShiftType): number {
  return type === 'full_24' ? 24 : 12;
}

function shiftWindow(date: string, type: ShiftType): { startMs: number; endMs: number } {
  const dayStart = new Date(date + 'T00:00:00Z').getTime();
  const HOUR = 3600_000;
  if (type === 'day_12') return { startMs: dayStart, endMs: dayStart + 12 * HOUR };
  if (type === 'night_12') return { startMs: dayStart + 12 * HOUR, endMs: dayStart + 24 * HOUR };
  return { startMs: dayStart, endMs: dayStart + 24 * HOUR }; // full_24
}

function isWeekendDay(date: string): boolean {
  const d = new Date(date + 'T00:00:00Z').getUTCDay();
  return d === 0 || d === 6; // Sun or Sat
}

function isFriday(date: string): boolean {
  return new Date(date + 'T00:00:00Z').getUTCDay() === 5;
}

/**
 * Checks every hard rule from the spec for a candidate (employee, date,
 * shiftType) assignment, given their current accumulated state. Returns
 * a reason string if disqualified, or null if eligible.
 *
 * These are HARD constraints -- unlike preferences, none of these are
 * weighted or negotiable. A candidate that fails any of these is simply
 * not eligible for this slot, full stop.
 */
export function checkHardConstraints(
  state: EmployeeState,
  date: string,
  type: ShiftType
): string | null {
  const { startMs, endMs } = shiftWindow(date, type);
  const hours = shiftHours(type);

  // Already working this day in the other slot / overlapping window.
  if (state.lastWorkedDate === date) {
    // A same-day second assignment would only make sense as the other
    // half of a day_12/night_12 pair for a DIFFERENT slot number, but
    // slot filling is handled per-slot-number by the caller, which never
    // reuses a candidate across slot numbers on the same day. If we get
    // here it means the same slot's day and night halves are both being
    // considered for one person as a full_24 -- that's handled by the
    // caller choosing full_24 directly, not by two calls. So a repeat
    // same-day call here is always a conflict.
    return 'already assigned this day';
  }

  // 10 hours minimum rest between shifts.
  if (state.lastShiftEndsAt !== null) {
    const gapHours = (startMs - state.lastShiftEndsAt) / 3_600_000;
    if (gapHours < 10) return 'insufficient rest (<10hrs)';
  }

  // No more than 24 hours without a break -- automatically satisfied
  // since max single shift is 24hrs and the rest check above prevents
  // immediate continuation into another shift. No separate check needed.

  // Weekend cap: must work exactly 2 weekend days, never more than 2.
  if (isWeekendDay(date) && state.weekendDaysWorked >= 2) {
    return 'weekend day cap reached (2)';
  }

  // Friday cap: must work exactly 1 Friday, never more than 1.
  if (isFriday(date) && state.fridaysWorked >= 1) {
    return 'Friday cap reached (1)';
  }

  // Consecutive-shifts-worked cap. Per clarified spec: the streak
  // continues as long as the gap since the last shift ended is 24 hours
  // or less; a gap longer than 24 hours breaks the cycle. This is a
  // duration check against lastShiftEndsAt, not calendar-day adjacency --
  // e.g. a night shift ending at hour 24 followed by a shift starting
  // exactly 24 hours later still counts as consecutive.
  const gapHoursSinceLast =
    state.lastShiftEndsAt !== null ? (startMs - state.lastShiftEndsAt) / 3_600_000 : null;
  const wouldBeStreak =
    gapHoursSinceLast !== null && gapHoursSinceLast <= 24 ? state.currentConsecutiveDays + 1 : 1;
  if (wouldBeStreak > state.maxConsecutiveShifts) {
    return `exceeds max consecutive shifts (${state.maxConsecutiveShifts})`;
  }

  // 110 hours per rolling 10-day window (window ends at this shift's date).
  const windowStart = addDays(date, -9);
  const hoursInWindow =
    state.recentShifts
      .filter((s) => s.date >= windowStart && s.date <= date)
      .reduce((sum, s) => sum + s.hours, 0) + hours;
  if (hoursInWindow > 110) return 'exceeds 110hrs/10-day cap';

  // SCH Employee weekly cap: fte * 40 hours in any single calendar week
  // of the 6-week cycle (only applies if the employee opted into this).
  if (state.isSchEmployee) {
    const weekIndex = Math.floor(daysBetween(state.scheduleStartDate, date) / 7);
    const currentWeekHours = state.hoursByWeek[weekIndex] ?? 0;
    if (currentWeekHours + hours > state.fte * 40) {
      return 'exceeds SCH weekly cap (fte * 40hrs)';
    }
  }

  // Effective target (FTE-based, minus vacation/ED/other hours already
  // taken this cycle) -- don't over-assign someone past what they're
  // supposed to work.
  if (state.assignedHours + hours > state.effectiveTargetHours) {
    return 'would exceed effective target hours';
  }

  return null;
}

export function isNextCalendarDay(prev: string, next: string): boolean {
  return addDays(prev, 1) === next;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Mutates state to reflect a newly made assignment. */
export function applyAssignment(state: EmployeeState, date: string, type: ShiftType): void {
  const { startMs, endMs } = shiftWindow(date, type);
  const hours = shiftHours(type);

  state.assignedHours += hours;
  state.recentShifts.push({ date, hours });

  if (isWeekendDay(date)) state.weekendDaysWorked += 1;
  if (isFriday(date)) state.fridaysWorked += 1;

  const gapHoursSinceLast =
    state.lastShiftEndsAt !== null ? (startMs - state.lastShiftEndsAt) / 3_600_000 : null;
  state.currentConsecutiveDays =
    gapHoursSinceLast !== null && gapHoursSinceLast <= 24 ? state.currentConsecutiveDays + 1 : 1;
  state.lastWorkedDate = date;
  state.lastShiftEndsAt = endMs;

  if (state.isSchEmployee) {
    const weekIndex = Math.floor(daysBetween(state.scheduleStartDate, date) / 7);
    state.hoursByWeek[weekIndex] = (state.hoursByWeek[weekIndex] ?? 0) + hours;
  }
}
