-- =========================================================
-- Copy-forward support for schedule_overrides, matching how preferences
-- already carry forward: track which prior schedule an override was
-- copied from, so the UI can distinguish "carried from last cycle" vs.
-- "set fresh this cycle" and so it's clear these are editable defaults,
-- not a permanently locked rule.
-- =========================================================

alter table schedule_overrides
  add column carried_forward_from uuid references schedules(id);
