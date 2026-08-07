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
  preferClusteredShifts: boolean; // prefer continuing an existing streak over starting fresh, up to maxConsecutiveShifts
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
  maxConsecutiveShifts: number;
  // Every shift assigned so far this cycle, used to derive rest gaps,
  // streaks, and the 10-day rolling window -- NOT assumed to be in
  // chronological insertion order, since the two-pass algorithm (full_24
  // pass across the whole cycle, then a 12hr pass for what's left) can
  // insert an earlier-dated shift after a later-dated one.
  shifts: { date: string; type: ShiftType }[];
  // SCH Employee weekly cap support
  isSchEmployee: boolean;
  scheduleStartDate: string; // needed to bucket a date into a cycle week index
  hoursByWeek: number[]; // length 6, index = week number (0-5) within the cycle
}
