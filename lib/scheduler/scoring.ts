import type { AvailabilityOption, PreferencesInput, ShiftType } from './types';

/**
 * Availability -> base eligibility & weight for a given shift type.
 * Each day an employee picks exactly ONE of the 5 dropdown options (not
 * one per shift type), which determines both what shift types they're
 * eligible for that day and the base weight of that eligibility:
 *   - available_24         -> eligible for full_24 ONLY @ 1.0. Someone who
 *     said they're available all day is reserved for a 24hr shift, not
 *     pulled into a 12hr half -- if they specifically wanted a 12hr shift
 *     they'd have picked available_12_day/night instead.
 *   - available_12_day     -> eligible for day_12 only @ 1.0
 *   - available_12_night   -> eligible for night_12 only @ 1.0
 *   - available_last_resort -> eligible for any shift type @ 0.5 (the
 *     deliberate fallback category, so it stays broad)
 *   - not_available        -> ineligible for everything
 */
export function availabilityWeight(option: AvailabilityOption, type: ShiftType): number | null {
  switch (option) {
    case 'available_24':
      return type === 'full_24' ? 1.0 : null;
    case 'available_12_day':
      return type === 'day_12' ? 1.0 : null;
    case 'available_12_night':
      return type === 'night_12' ? 1.0 : null;
    case 'available_last_resort':
      return 0.5;
    case 'not_available':
    default:
      return null;
  }
}

const FRI_SUN_WEIGHT = 0.75;
const DAY_OF_WEEK_WEIGHT = 0.75;
const PARTNER_WEIGHT = 0.3; // lowest priority per spec: "should not stop a full schedule"

/**
 * Composite score for a candidate covering a given date/shift. Preference
 * bonuses are additive on top of the availability base weight, each worth
 * up to their stated weight (0.75) when satisfied -- so someone at full
 * availability (1.0) who also matches both preferences could score up to
 * 2.5 before the partner bonus, while a last-resort availability (0.5)
 * candidate scores lower even with matching preferences. This keeps
 * availability as the dominant signal, which matches the spec's framing
 * of preferences as secondary to availability.
 */
export function computeScore(params: {
  baseWeight: number;
  date: string;
  prefs: PreferencesInput | undefined;
  alreadyAssignedThisWeekendCounterpart: boolean; // true if this employee is already
  // slated to work the Fri (checking Sun) or Sun (checking Fri) of the same weekend
  partnersAlreadyOnThisShift: string[]; // employee IDs already assigned to this exact slot
}): number {
  let score = params.baseWeight;

  if (!params.prefs) return score;

  const dow = new Date(params.date + 'T00:00:00Z').getUTCDay();

  if (
    params.prefs.preferFriSunSameWeekend &&
    (dow === 5 || dow === 0) &&
    params.alreadyAssignedThisWeekendCounterpart
  ) {
    score += FRI_SUN_WEIGHT;
  }

  if (
    !params.prefs.noDayPreference &&
    params.prefs.preferredDaysOfWeek.includes(dow)
  ) {
    score += DAY_OF_WEEK_WEIGHT;
  }

  if (params.prefs.preferredPartnerIds.some((id) => params.partnersAlreadyOnThisShift.includes(id))) {
    score += PARTNER_WEIGHT;
  }

  return score;
}
