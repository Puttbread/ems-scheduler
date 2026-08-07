-- =========================================================
-- Per-day vacation/education/other tagging on the availability
-- calendar. This is purely an organizational/visual aid for the
-- employee (distinct day-cell coloring) -- it does NOT feed into the
-- vacation_hours/ed_hours/other_hours totals on cycle_hours, which
-- remain the separate manually-entered numbers the scheduling algorithm
-- actually uses for FTE math. Checking a day here also forces that
-- day's availability option to 'not_available', since a vacation/
-- education/other day isn't one you'd be working.
-- =========================================================

alter table availability
  add column day_type text check (day_type in ('vacation', 'education', 'other'));
