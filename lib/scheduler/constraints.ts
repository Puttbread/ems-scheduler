import type { EmployeeState, ShiftType } from './types';

// Shift start/end are expressed as hour-offsets from 00:00 on `date` for
// simplicity -- day = 0..12, night = 12..24, full_24 = 0..24. No specific
// clock times are stored anywhere; these are just used to compute rest
// gaps and durations.
export function shiftHours(type: ShiftType): number {
  return type === 'full_24' ? 24 : 12;
}

export function shiftWindow(date: string, type: ShiftType): { startMs: number; endMs: number } {
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

export function daysBetween(from: string, to: string): number {
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Checks every hard rule from the spec for a candidate (employee, date,
 * shiftType) assignment, given their current accumulated state. Returns
 * a reason string if disqualified, or null if eligible.
 *
 * These are HARD constraints -- unlike preferences, none of these are
 * weighted or negotiable. A candidate that fails any of these is simply
 * not eligible for this slot, full stop.
 *
 * Rest/streak checks work by finding this candidate shift's nearest
 * neighbors IN TIME among the employee's already-assigned shifts (not
 * "the most recently assigned shift"), since the two-pass algorithm can
 * insert an earlier-dated shift after a later-dated one has already been
 * committed.
 */
export function checkHardConstraints(
  state: EmployeeState,
  date: string,
  type: ShiftType
): string | null {
  const { startMs, endMs } = shiftWindow(date, type);
  const hours = shiftHours(type);

  const windows = state.shifts.map((s) => ({ ...shiftWindow(s.date, s.type), date: s.date }));

  // Overlap / same-day conflict check.
  if (windows.some((w) => w.startMs < endMs && startMs < w.endMs)) {
    return 'overlaps an existing shift';
  }

  // Nearest neighbor before and after this candidate, by time.
  let prevEnd: number | null = null;
  let nextStart: number | null = null;
  for (const w of windows) {
    if (w.endMs <= startMs && (prevEnd === null || w.endMs > prevEnd)) prevEnd = w.endMs;
    if (w.startMs >= endMs && (nextStart === null || w.startMs < nextStart)) nextStart = w.startMs;
  }

  // 10 hours minimum rest between shifts, checked on both sides.
  if (prevEnd !== null && (startMs - prevEnd) / 3_600_000 < 10) {
    return 'insufficient rest before this shift (<10hrs)';
  }
  if (nextStart !== null && (nextStart - endMs) / 3_600_000 < 10) {
    return 'insufficient rest after this shift (<10hrs)';
  }
  // No more than 24 hours without a break -- automatically satisfied
  // since max single shift is 24hrs and the 10hr rest checks above
  // prevent immediate continuation into another shift.

  // Weekend cap: must work exactly 2 weekend days, never more than 2.
  if (isWeekendDay(date) && state.weekendDaysWorked >= 2) {
    return 'weekend day cap reached (2)';
  }

  // Friday cap: must work exactly 1 Friday, never more than 1.
  if (isFriday(date) && state.fridaysWorked >= 1) {
    return 'Friday cap reached (1)';
  }

  // Consecutive-shifts-worked cap. Per clarified spec: the streak
  // continues as long as the gap since the adjoining shift is 24 hours
  // or less. Computed by walking outward from the candidate through its
  // sorted neighbors in both directions, counting how many are chained
  // by <=24hr gaps.
  const sorted = [...windows, { startMs, endMs, date }].sort((a, b) => a.startMs - b.startMs);
  const candidateIndex = sorted.findIndex((w) => w.startMs === startMs && w.endMs === endMs);
  let streak = 1;
  for (let i = candidateIndex - 1; i >= 0; i--) {
    const gap = (sorted[i + 1].startMs - sorted[i].endMs) / 3_600_000;
    if (gap <= 24) streak++;
    else break;
  }
  for (let i = candidateIndex + 1; i < sorted.length; i++) {
    const gap = (sorted[i].startMs - sorted[i - 1].endMs) / 3_600_000;
    if (gap <= 24) streak++;
    else break;
  }
  if (streak > state.maxConsecutiveShifts) {
    return `exceeds max consecutive shifts (${state.maxConsecutiveShifts})`;
  }

  // 110 hours per rolling 10-day window (window ends at this shift's date).
  const windowStart = addDays(date, -9);
  const hoursInWindow =
    state.shifts
      .filter((s) => s.date >= windowStart && s.date <= date)
      .reduce((sum, s) => sum + shiftHours(s.type), 0) + hours;
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

/**
 * True if assigning this candidate shift would sit within a 24hr gap of
 * an existing shift for this employee (before or after) -- i.e. it would
 * continue a streak rather than start a fresh one. Used only for the
 * "prefer clustered shifts" scoring bonus; the actual streak-length hard
 * cap is still enforced separately in checkHardConstraints regardless of
 * this preference.
 */
export function wouldContinueStreak(state: EmployeeState, date: string, type: ShiftType): boolean {
  const { startMs, endMs } = shiftWindow(date, type);
  for (const s of state.shifts) {
    const w = shiftWindow(s.date, s.type);
    const gapBefore = (startMs - w.endMs) / 3_600_000; // candidate starts after this shift ends
    const gapAfter = (w.startMs - endMs) / 3_600_000; // this shift starts after candidate ends
    if ((gapBefore >= 0 && gapBefore <= 24) || (gapAfter >= 0 && gapAfter <= 24)) return true;
  }
  return false;
}

/** Mutates state to reflect a newly made assignment. */
export function applyAssignment(state: EmployeeState, date: string, type: ShiftType): void {
  const hours = shiftHours(type);

  state.assignedHours += hours;
  state.shifts.push({ date, type });

  if (isWeekendDay(date)) state.weekendDaysWorked += 1;
  if (isFriday(date)) state.fridaysWorked += 1;

  if (state.isSchEmployee) {
    const weekIndex = Math.floor(daysBetween(state.scheduleStartDate, date) / 7);
    state.hoursByWeek[weekIndex] = (state.hoursByWeek[weekIndex] ?? 0) + hours;
  }
}
