import type {
  AvailabilityInput,
  EmployeeState,
  GenerateScheduleInput,
  GenerateScheduleResult,
  PreferencesInput,
  ShiftAssignmentResult,
  ShiftType,
} from './types';
import { addDays, applyAssignment, checkHardConstraints } from './constraints';
import { availabilityWeight, computeScore } from './scoring';

const CYCLE_DAYS = 42;
const HOURS_PER_FTE = 240; // 1.0 FTE = 40hrs/week x 6 weeks, per clarified spec
const MAX_SHORTFALL_ITERATIONS = 15;

interface Candidate {
  employeeId: string;
  score: number;
}

type AvailabilityMap = Map<string, Map<string, AvailabilityInput['option']>>;

/**
 * Public entry point. Retries with progressively reduced per-employee
 * target hours ("one day removed" per iteration, per spec) until every
 * employee's assigned hours reach their own effective FTE target, or
 * until a safety iteration cap is hit (returns the best attempt so far
 * if so). Unfilled coverage slots do NOT trigger a retry on their own --
 * it's expected and acceptable that some shifts go uncovered when there
 * simply aren't enough available people; those are reported to the admin
 * via `unfilledSlots` rather than treated as a failure to fix.
 */
export function generateSchedule(input: GenerateScheduleInput): GenerateScheduleResult {
  let shortfallDays = 0;
  let last: Omit<GenerateScheduleResult, 'shortfallDays'> | null = null;
  const EPSILON = 0.01; // float tolerance for the hours comparison

  while (shortfallDays <= MAX_SHORTFALL_ITERATIONS) {
    last = attemptGeneration(input, shortfallDays);
    const anyoneShort = Object.values(last.employeeHoursSummary).some(
      (s) => s.assignedHours < s.effectiveTargetHours - EPSILON
    );
    if (!anyoneShort) break;
    shortfallDays += 1;
  }

  return { ...last!, shortfallDays };
}

function attemptGeneration(
  input: GenerateScheduleInput,
  shortfallDays: number
): Omit<GenerateScheduleResult, 'shortfallDays'> {
  const employeeIds = input.employees.map((e) => e.id);

  const prefsByEmployee = new Map<string, PreferencesInput>();
  input.preferences.forEach((p) => prefsByEmployee.set(p.employeeId, p));

  const cycleHoursByEmployee = new Map<
    string,
    { vacationHours: number; edHours: number; otherHours: number }
  >();
  input.cycleHours.forEach((c) => cycleHoursByEmployee.set(c.employeeId, c));

  const availability: AvailabilityMap = new Map();
  input.availability.forEach((a) => {
    if (!availability.has(a.employeeId)) availability.set(a.employeeId, new Map());
    availability.get(a.employeeId)!.set(a.date, a.option);
  });

  // key: `${date}|${slotNumber}|${portion}`
  const overrides = new Map<string, (typeof input.overrides)[number]>();
  input.overrides.forEach((o) => {
    overrides.set(`${o.date}|${o.slotNumber}|${o.portion}`, o);
  });

  const states = new Map<string, EmployeeState>();
  for (const emp of input.employees) {
    // Fixed 40hr/week basis: 1.0 FTE = 240 hours per 6-week cycle.
    // Shortfall retries subtract 24hrs (one day) per iteration, uniformly.
    const rawTarget = Math.max(0, emp.fte * HOURS_PER_FTE - shortfallDays * 24);
    const ch = cycleHoursByEmployee.get(emp.id);
    const takenHours = (ch?.vacationHours ?? 0) + (ch?.edHours ?? 0) + (ch?.otherHours ?? 0);
    const prefs = prefsByEmployee.get(emp.id);

    states.set(emp.id, {
      id: emp.id,
      fte: emp.fte,
      targetHours: rawTarget,
      effectiveTargetHours: Math.max(0, rawTarget - takenHours),
      assignedHours: 0,
      weekendDaysWorked: 0,
      fridaysWorked: 0,
      currentConsecutiveDays: 0,
      lastWorkedDate: null,
      lastShiftEndsAt: null,
      maxConsecutiveShifts: prefs?.maxConsecutiveShifts ?? 3,
      recentShifts: [],
      isSchEmployee: emp.isSchEmployee,
      scheduleStartDate: input.startDate,
      hoursByWeek: new Array(6).fill(0),
    });
  }

  const assignments: ShiftAssignmentResult[] = [];
  const unfilledSlots: { date: string; slotNumber: 1 | 2; shiftType: ShiftType }[] = [];

  // Tracks, per (date, shiftType), which employee IDs are already assigned --
  // used for the "preferred partner already on this shift" bonus when
  // filling slot 2 after slot 1 is decided for that day/shiftType.
  const sameShiftOccupants = new Map<string, string[]>(); // key: `${date}|${shiftType}`

  function scoreCandidate(employeeId: string, date: string, type: ShiftType): number {
    const option = availability.get(employeeId)?.get(date) ?? 'not_available';
    const w = availabilityWeight(option, type);
    if (w === null) return 0;
    return computeScore({
      baseWeight: w,
      date,
      prefs: prefsByEmployee.get(employeeId),
      alreadyAssignedThisWeekendCounterpart: hasWeekendCounterpart(employeeId, date, states),
      partnersAlreadyOnThisShift: sameShiftOccupants.get(`${date}|${type}`) ?? [],
    });
  }

  function pickBest(
    candidateIds: string[],
    date: string,
    type: ShiftType
  ): Candidate | null {
    let best: Candidate | null = null;
    for (const employeeId of candidateIds) {
      const option = availability.get(employeeId)?.get(date) ?? 'not_available';
      if (availabilityWeight(option, type) === null) continue;
      const state = states.get(employeeId)!;
      if (checkHardConstraints(state, date, type)) continue;
      const score = scoreCandidate(employeeId, date, type);
      if (!best || score > best.score) best = { employeeId, score };
    }
    return best;
  }

  function commit(employeeId: string, date: string, slotNumber: 1 | 2, type: ShiftType) {
    const score = scoreCandidate(employeeId, date, type);
    applyAssignment(states.get(employeeId)!, date, type);
    assignments.push({ date, slotNumber, shiftType: type, employeeId, score });
    const key = `${date}|${type}`;
    sameShiftOccupants.set(key, [...(sameShiftOccupants.get(key) ?? []), employeeId]);
  }

  function resolveHalf(date: string, slotNumber: 1 | 2, type: 'day_12' | 'night_12') {
    const override = overrides.get(`${date}|${slotNumber}|${type}`);
    if (override) {
      if (override.overrideType === 'exempt') return; // no coverage needed, no unfilled flag
      commit(override.employeeId!, date, slotNumber, type); // fixed: bypass scoring/constraints
      return;
    }
    const candidate = pickBest(employeeIds, date, type);
    if (candidate) {
      commit(candidate.employeeId, date, slotNumber, type);
    } else {
      unfilledSlots.push({ date, slotNumber, shiftType: type });
    }
  }

  for (let dayOffset = 0; dayOffset < CYCLE_DAYS; dayOffset++) {
    const date = addDays(input.startDate, dayOffset);

    for (const slotNumber of [1, 2] as const) {
      const fullOverride = overrides.get(`${date}|${slotNumber}|full_24`);
      if (fullOverride) {
        if (fullOverride.overrideType === 'fixed') {
          commit(fullOverride.employeeId!, date, slotNumber, 'full_24');
        }
        // exempt: skip entirely, no unfilled flag
        continue;
      }

      const dayOverride = overrides.get(`${date}|${slotNumber}|day_12`);
      const nightOverride = overrides.get(`${date}|${slotNumber}|night_12`);

      if (dayOverride || nightOverride) {
        // One half is admin-controlled -- full_24 is no longer a valid
        // option for this slot, since it can't span a portion that's
        // separately exempted/fixed. Resolve each half independently.
        resolveHalf(date, slotNumber, 'day_12');
        resolveHalf(date, slotNumber, 'night_12');
        continue;
      }

      // No overrides for this slot -- normal algorithm as before.
      const dayCandidate = pickBest(employeeIds, date, 'day_12');
      const nightCandidate = pickBest(
        employeeIds.filter((id) => id !== dayCandidate?.employeeId),
        date,
        'night_12'
      );
      const full24Candidate = pickBest(employeeIds, date, 'full_24');

      const splitScore =
        dayCandidate && nightCandidate ? dayCandidate.score + nightCandidate.score : -Infinity;
      const fullScore = full24Candidate ? full24Candidate.score : -Infinity;

      if (splitScore === -Infinity && fullScore === -Infinity) {
        // Neither a full split nor a full_24 works as a complete pair --
        // fall back to filling whichever half we can independently, and
        // record the other half as unfilled so it surfaces to the admin.
        if (dayCandidate) {
          commit(dayCandidate.employeeId, date, slotNumber, 'day_12');
        } else {
          unfilledSlots.push({ date, slotNumber, shiftType: 'day_12' });
        }
        const nightFallback = pickBest(
          employeeIds.filter((id) => id !== dayCandidate?.employeeId),
          date,
          'night_12'
        );
        if (nightFallback) {
          commit(nightFallback.employeeId, date, slotNumber, 'night_12');
        } else {
          unfilledSlots.push({ date, slotNumber, shiftType: 'night_12' });
        }
        continue;
      }

      if (splitScore >= fullScore) {
        commit(dayCandidate!.employeeId, date, slotNumber, 'day_12');
        commit(nightCandidate!.employeeId, date, slotNumber, 'night_12');
      } else {
        commit(full24Candidate!.employeeId, date, slotNumber, 'full_24');
      }
    }
  }

  const employeeHoursSummary: GenerateScheduleResult['employeeHoursSummary'] = {};
  states.forEach((s, id) => {
    employeeHoursSummary[id] = {
      targetHours: s.targetHours,
      effectiveTargetHours: s.effectiveTargetHours,
      assignedHours: s.assignedHours,
      weekendDays: s.weekendDaysWorked,
      fridays: s.fridaysWorked,
    };
  });

  return { assignments, unfilledSlots, employeeHoursSummary };
}

function hasWeekendCounterpart(
  employeeId: string,
  date: string,
  states: Map<string, EmployeeState>
): boolean {
  // Directional simplification: we can only reliably detect the Fri+Sun
  // pairing when evaluating the Sunday (looking back at an already-decided
  // Friday), since Friday is decided first chronologically and Sunday's
  // assignment isn't known yet at Friday-selection time. This still
  // produces the intended pairing behavior in practice -- once Friday is
  // set for someone with this preference, Sunday scoring favors them.
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (dow !== 0) return false;
  const fridayDate = addDays(date, -2);
  return states.get(employeeId)?.lastWorkedDate === fridayDate;
}
