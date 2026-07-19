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
 * until a safety iteration cap is hit. Unfilled coverage slots do NOT
 * trigger a retry on their own -- it's expected and acceptable that some
 * shifts go uncovered when there simply aren't enough available people;
 * those are reported to the admin via `unfilledSlots` rather than
 * treated as a failure to fix.
 *
 * IMPORTANT: tracks and returns the BEST attempt seen across all
 * iterations (by total shortfall hours), not simply the last one. Later
 * iterations are not guaranteed to be better -- once a low-FTE employee's
 * target is reduced to 0, they become ineligible for any shift at all,
 * shrinking the pool of people available to cover each other's rest-period
 * gaps. With uneven FTEs, later iterations can end up WORSE than earlier
 * ones, so blindly using the final iteration risks handing back a badly
 * collapsed schedule even when an earlier attempt was much better.
 */
export function generateSchedule(input: GenerateScheduleInput): GenerateScheduleResult {
  let shortfallDays = 0;
  const EPSILON = 0.01; // float tolerance for the hours comparison

  let best: Omit<GenerateScheduleResult, 'shortfallDays'> | null = null;
  let bestShortfallDays = 0;
  // Maximize total hours actually assigned across everyone. This is
  // deliberately NOT "minimize shortfall relative to each attempt's own
  // target" -- that comparison is unfair across iterations, since the
  // target itself shrinks each round. A later round can look "fully
  // satisfied" simply because its target got small enough to trivially
  // meet, even though strictly fewer real hours were worked overall.
  // Maximizing actual hours worked directly favors the least-aggressive
  // reduction that gets the job done, matching what you'd actually want.
  let bestScore = -Infinity;
  let iterationsSinceImprovement = 0;

  while (shortfallDays <= MAX_SHORTFALL_ITERATIONS) {
    const attempt = attemptGeneration(input, shortfallDays);
    const totalAssignedHours = Object.values(attempt.employeeHoursSummary).reduce(
      (sum, s) => sum + s.assignedHours,
      0
    );

    if (totalAssignedHours > bestScore + EPSILON) {
      best = attempt;
      bestScore = totalAssignedHours;
      bestShortfallDays = shortfallDays;
      iterationsSinceImprovement = 0;
    } else {
      iterationsSinceImprovement += 1;
    }

    const anyoneShort = Object.values(attempt.employeeHoursSummary).some(
      (s) => s.assignedHours < s.effectiveTargetHours - EPSILON
    );
    if (!anyoneShort) break;
    // Stop early if reducing further hasn't helped in a while -- once low-FTE
    // employees' targets hit 0, more reduction only shrinks the eligible
    // pool without addressing the actual shortfall, so continuing is
    // pointless and wastes computation.
    if (iterationsSinceImprovement >= 3) break;
    shortfallDays += 1;
  }

  return { ...best!, shortfallDays: bestShortfallDays };
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
      maxConsecutiveShifts: prefs?.maxConsecutiveShifts ?? 3,
      shifts: [],
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
    let bestRatio = Infinity; // assignedHours / effectiveTargetHours of the current leader
    for (const employeeId of candidateIds) {
      const option = availability.get(employeeId)?.get(date) ?? 'not_available';
      if (availabilityWeight(option, type) === null) continue;
      const state = states.get(employeeId)!;
      if (checkHardConstraints(state, date, type)) continue;
      const score = scoreCandidate(employeeId, date, type);
      // Load-balancing ratio: how far along this employee already is
      // toward their own target. Lower = further behind = more deserving
      // on a tie. An employee with 0 target (fully covered by vacation
      // etc.) is treated as "already full" so they don't wrongly win ties.
      const ratio = state.effectiveTargetHours > 0 ? state.assignedHours / state.effectiveTargetHours : 1;
      if (!best || score > best.score || (score === best.score && ratio < bestRatio)) {
        best = { employeeId, score };
        bestRatio = ratio;
      }
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

  // Build the full list of (date, slotNumber) pairs for the cycle, in
  // chronological order.
  const allSlots: { date: string; slotNumber: 1 | 2 }[] = [];
  for (let dayOffset = 0; dayOffset < CYCLE_DAYS; dayOffset++) {
    const date = addDays(input.startDate, dayOffset);
    allSlots.push({ date, slotNumber: 1 }, { date, slotNumber: 2 });
  }

  // Pre-pass: resolve every slot that has an override first. A slot with
  // a full_24 override is fully handled here. A slot with a day_12 and/or
  // night_12 override can never use full_24 (it can't span a portion
  // that's separately controlled), so both halves are resolved as plain
  // 12hr shifts here too, independent of the two-pass split below.
  const pendingForFullPass: { date: string; slotNumber: 1 | 2 }[] = [];
  for (const { date, slotNumber } of allSlots) {
    const fullOverride = overrides.get(`${date}|${slotNumber}|full_24`);
    if (fullOverride) {
      if (fullOverride.overrideType === 'fixed') {
        commit(fullOverride.employeeId!, date, slotNumber, 'full_24');
      }
      continue; // exempt or fixed, either way this slot is done
    }
    const dayOverride = overrides.get(`${date}|${slotNumber}|day_12`);
    const nightOverride = overrides.get(`${date}|${slotNumber}|night_12`);
    if (dayOverride || nightOverride) {
      resolveHalf(date, slotNumber, 'day_12');
      resolveHalf(date, slotNumber, 'night_12');
      continue;
    }
    pendingForFullPass.push({ date, slotNumber });
  }

  // Pass 1: across the ENTIRE cycle, fill as many slots as possible with
  // a single full_24 assignment before considering any 12hr split. This
  // is a deliberate ordering choice -- per spec, a 24hr availability
  // pick should be used as a 24hr shift wherever the rules allow it,
  // rather than being outscored by two 12hr picks summing higher.
  const pendingForSplitPass: { date: string; slotNumber: 1 | 2 }[] = [];
  for (const { date, slotNumber } of pendingForFullPass) {
    const full24Candidate = pickBest(employeeIds, date, 'full_24');
    if (full24Candidate) {
      commit(full24Candidate.employeeId, date, slotNumber, 'full_24');
    } else {
      pendingForSplitPass.push({ date, slotNumber });
    }
  }

  // Pass 2: whatever's left after pass 1 gets filled with 12hr day/night
  // shifts, each half resolved independently and only from employees who
  // specifically indicated 12hr availability for that half (or last
  // resort) -- someone who only marked available_24 was reserved for
  // pass 1 and won't be pulled into a 12hr shift here.
  for (const { date, slotNumber } of pendingForSplitPass) {
    resolveHalf(date, slotNumber, 'day_12');
    resolveHalf(date, slotNumber, 'night_12');
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
  return states.get(employeeId)?.shifts.some((s) => s.date === fridayDate) ?? false;
}
