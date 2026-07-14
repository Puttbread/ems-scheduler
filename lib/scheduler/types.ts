// Core types for the scheduling engine. Kept separate from the DB schema
// types so the algorithm can be reasoned about (and unit tested) without
// a live Supabase connection.

export type AvailabilityOption =
  | 'available_24'
  | 'available_12_day'
  | 'available_12_night'
  | 'available_last_resort'
  | 'not_available';

export type ShiftType = 'day_12' | 'night_12' | 'full_24';

export interface EmployeeInput {
  id: string;
  fullName: string;
  fte: number; // 0 < fte <= 1. 1.0 FTE = 240 hours per 6-week cycle (40hr/week basis).
  isSchEmployee: boolean; // if true, additionally capped at (fte * 40) hours per calendar week
}

export interface AvailabilityInput {
  employeeId: string;
  date: string; // ISO yyyy-mm-dd
  option: AvailabilityOption;
}

export interface PreferencesInput {
  employeeId: string;
  preferFriSunSameWeekend: boolean;
  maxConsecutiveShifts: number; // 1-5
  preferredDaysOfWeek: number[]; // 0=Sun..6=Sat
  noDayPreference: boolean;
  preferredPartnerIds: string[];
}

export interface CycleHoursInput {
  employeeId: string;
  vacationHours: number;
  edHours: number;
  otherHours: number;
}

export interface OverrideInput {
  date: string; // ISO yyyy-mm-dd
  slotNumber: 1 | 2;
  portion: ShiftType; // 'full_24' covers both halves; 'day_12'/'night_12' cover just that half
  overrideType: 'exempt' | 'fixed';
  employeeId?: string; // required when overrideType is 'fixed'
}

export interface GenerateScheduleInput {
  startDate: string; // ISO yyyy-mm-dd, first day of the 6-week cycle
  employees: EmployeeInput[];
  availability: AvailabilityInput[];
  preferences: PreferencesInput[];
  cycleHours: CycleHoursInput[];
  overrides: OverrideInput[];
}

export interface ShiftAssignmentResult {
  date: string;
  slotNumber: 1 | 2;
  shiftType: ShiftType;
  employeeId: string;
  score: number;
}

export interface GenerateScheduleResult {
  assignments: ShiftAssignmentResult[];
  unfilledSlots: { date: string; slotNumber: 1 | 2; shiftType: ShiftType }[];
  shortfallDays: number;
  employeeHoursSummary: Record<
    string,
    {
      targetHours: number;
      effectiveTargetHours: number;
      assignedHours: number;
      weekendDays: number;
      fridays: number;
    }
  >;
}

// Internal mutable tracking state per employee while the greedy pass runs.
export interface EmployeeState {
  id: string;
  fte: number;
  targetHours: number; // after FTE proportioning and any shortfall reduction
  effectiveTargetHours: number; // targetHours minus reported vacation/ED/other hours
  assignedHours: number;
  weekendDaysWorked: number; // Sat/Sun count, hard cap 2
  fridaysWorked: number; // hard cap 1
  currentConsecutiveDays: number;
  lastWorkedDate: string | null; // ISO date of most recent assigned day
  lastShiftEndsAt: number | null; // epoch ms, for the 10hr rest check
  maxConsecutiveShifts: number;
  // rolling 10-day hours: list of {date, hours} for the 10-day window check
  recentShifts: { date: string; hours: number }[];
  // SCH Employee weekly cap support
  isSchEmployee: boolean;
  scheduleStartDate: string; // needed to bucket a date into a cycle week index
  hoursByWeek: number[]; // length 6, index = week number (0-5) within the cycle
}
