-- =========================================================
-- "Prefer clustered shifts" preference: some employees want their
-- willing-to-work-in-a-row shifts pulled as close together as possible
-- (to maximize stretches of time off), others don't care either way.
-- This only ever adds a scoring bonus toward continuing an existing
-- streak (within the employee's own max_consecutive_shifts hard cap)
-- -- it never overrides or loosens that cap.
-- =========================================================

alter table preferences
  add column prefer_clustered_shifts boolean not null default false;
