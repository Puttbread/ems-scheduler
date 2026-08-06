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
const ATTEMPTS_PER_LEVEL = 75; // random-shuffle retries at each shortfall level before escalating
const TIME_BUDGET_MS = 20_000; // hard wall-clock cutoff, well under typical serverless timeouts

interface Candidate {
  employeeId: string;
  score: number;
}

type AvailabilityMap = Map<string, Map<string, AvailabilityInput['option']>>;

/** Fisher-Yates shuffle -- returns a new shuffled copy, doesn't mutate input. */
function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Public entry point. Uniformly reduces every employee's target by one
 * more day (24hrs) per level -- per spec. At EACH level, tries up to
 * ATTEMPTS_PER_LEVEL random fill orderings (since fill order is
 * shuffled) and looks for one where every employee genuinely reaches
 * their equally-reduced target -- a single unlucky shuffle shouldn't
 * cause the algorithm to give up on a level that a different shuffle
 * could have satisfied. Among multiple fair results at the same level,
 * prefers whichever left the fewest slots totally uncovered. Returns the
 * lowest level with ANY fair result found.
 *
 * If no level ever achieves full fairness (e.g. one structurally-
 * constrained employee can never be satisfied no matter how far targets
 * are reduced), falls back to whichever single attempt (across every
 * level and every shuffle tried) produced the most total hours actually
 * worked -- this avoids the collapse failure mode where blindly
 * continuing to reduce shrinks the eligible pool and makes things worse.
 *
 * A wall-clock budget guarantees this always returns well within a
 * typical serverless function timeout, even in a pathological case that
 * never converges.
 */
export function generateSchedule(input: GenerateScheduleInput): GenerateScheduleResult {
  const EPSILON = 0.01; // float tolerance for the hours comparison
  const startedAt = Date.now();

  let fallback: Omit<GenerateScheduleResult, 'shortfallDays'> | null = null;
  let fallbackShortfallDays = 0;
  let fallbackScore = -Infinity; // total hours actually assigned, higher is better

  for (let shortfallDays = 0; shortfallDays <= MAX_SHORTFALL_ITERATIONS; shortfallDays++) {
    let levelBest: Omit<GenerateScheduleResult, 'shortfallDays'> | null = null;
    let levelBestUnfilled = Infinity;

    for (let attemptNum = 0; attemptNum < ATTEMPTS_PER_LEVEL; attemptNum++) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // Time budget hit -- return whatever we've got rather than risk
        // exceeding a platform function timeout.
        if (levelBest) return { ...levelBest, shortfallDays };
        return { ...fallback!, shortfallDays: fallbackShortfallDays };
      }

      const attempt = attemptGeneration(input, shortfallDays);

      const totalAssignedHours = Object.values(attempt.employeeHoursSummary).reduce(
        (sum, s) => sum + s.assignedHours,
        0
      );
      if (totalAssignedHours > fallbackScore + EPSILON) {
        fallback = attempt;
        fallbackScore = totalAssignedHours;
        fallbackShortfallDays = shortfallDays;
      }

      const anyoneShort = Object.values(attempt.employeeHoursSummary).some(
        (s) => s.assignedHours < s.effectiveTargetHours - EPSILON
      );
      // A result only counts as genuinely "fair" if it also has real
      // utilization (totalAssignedHours > 0). Without this guard, once
      // uniform reduction drives EVERY employee's target down to 0 (which
      // happens once shortfallDays*24 exceeds even the largest individual
      // target), a completely empty schedule trivially satisfies
      // "nobody is short of their target" -- 0 assigned >= 0 target for
      // everyone -- and would otherwise be wrongly accepted as a win,
      // even though earlier, lower-reduction levels had far more real
      // coverage. Rejecting zero-utilization "fairness" forces the
      // search to keep going and eventually fall through to the
      // best-effort fallback (by total hours) instead of settling on a
      // useless empty result.
      if (!anyoneShort && totalAssignedHours > EPSILON) {
        if (attempt.unfilledSlots.length < levelBestUnfilled) {
          levelBest = attempt;
          levelBestUnfilled = attempt.unfilledSlots.length;
        }
        if (levelBestUnfilled === 0) break; // perfect coverage at this level, stop searching it
      }
    }

    if (levelBest) {
      // Found at least one fully-fair result at this level -- use the
      // best one found and don't escalate to a worse (more-reduced) level.
      return { ...levelBest, shortfallDays };
    }
  }

  // No level ever achieved full fairness within the cap -- best-effort fallback.
  return { ...fallback!, shortfallDays: fallbackShortfallDays };
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
  //
  // Processing order is SHUFFLED (not chronological) before this pass.
  // Processing strictly in calendar order means people run out of
  // remaining target hours disproportionately toward the end of the
  // cycle, which structurally clusters unfilled slots there. Shuffling
  // spreads any unavoidable gaps randomly across the whole 6 weeks
  // instead. This is safe -- the hard-constraint checks (rest, streak,
  // rolling windows) compare against each shift's nearest neighbor IN
  // TIME, not insertion order, so they're correct regardless of the
  // order slots are processed in.
  const shuffledFullPass = shuffle(pendingForFullPass);
  const pendingForSplitPass: { date: string; slotNumber: 1 | 2 }[] = [];
  for (const { date, slotNumber } of shuffledFullPass) {
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
  // pass 1 and won't be pulled into a 12hr shift here. Also shuffled for
  // the same distribution reason as pass 1.
  for (const { date, slotNumber } of shuffle(pendingForSplitPass)) {
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
