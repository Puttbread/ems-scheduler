export interface CoverageGap {
  date: string;
  slotNumber: 1 | 2;
  portion: 'day_12' | 'night_12';
}

function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Determines which portions of the 6-week cycle have no coverage at all,
 * computed live from current assignments + overrides rather than a
 * stored snapshot -- so it stays accurate even after an admin manually
 * edits a shift or adds an override after the last run.
 */
export function computeCoverageGaps(params: {
  startDate: string;
  assignments: { shift_slots: { work_date: string; shift_type: string; slot_number: number } | null }[];
  overrides: { work_date: string; slot_number: number; portion: string; override_type: string }[];
}): CoverageGap[] {
  const covered = new Set<string>(); // `${date}|${slotNumber}|${portion}` -- has an assignment
  params.assignments.forEach((a) => {
    const s = a.shift_slots;
    if (!s) return;
    covered.add(`${s.work_date}|${s.slot_number}|${s.shift_type}`);
  });

  const exempt = new Set<string>(); // covered by an exempt or fixed override
  params.overrides.forEach((o) => {
    exempt.add(`${o.work_date}|${o.slot_number}|${o.portion}`);
  });

  const isCovered = (date: string, slotNumber: 1 | 2, portion: string) =>
    covered.has(`${date}|${slotNumber}|${portion}`) || exempt.has(`${date}|${slotNumber}|${portion}`);

  const gaps: CoverageGap[] = [];
  for (let i = 0; i < 42; i++) {
    const date = addDays(params.startDate, i);
    for (const slotNumber of [1, 2] as const) {
      if (isCovered(date, slotNumber, 'full_24')) continue; // whole day covered by one 24hr shift/override
      if (!isCovered(date, slotNumber, 'day_12')) gaps.push({ date, slotNumber, portion: 'day_12' });
      if (!isCovered(date, slotNumber, 'night_12')) gaps.push({ date, slotNumber, portion: 'night_12' });
    }
  }
  return gaps;
}
