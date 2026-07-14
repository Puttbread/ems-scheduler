-- =========================================================
-- Employee "ready" indicator: lets an employee mark that they've
-- finished entering availability/preferences for a cycle, so the admin
-- dashboard can show at a glance who's still outstanding before running
-- the schedule. Lives on cycle_hours since that's already the one
-- per-employee-per-schedule row used for cycle-level (not per-day) data.
-- =========================================================

alter table cycle_hours
  add column is_ready boolean not null default false,
  add column ready_at timestamptz;
