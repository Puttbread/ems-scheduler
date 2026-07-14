-- =========================================================
-- Admin can delete a schedule outright. All child rows (availability,
-- preferences, cycle_hours, preferred_partners, shift_slots,
-- assignments, schedule_overrides) already cascade-delete via their
-- existing foreign keys to schedules(id) -- see 0001_core_schema.sql --
-- so this single policy is all that's needed to support full schedule
-- deletion, useful while testing or cleaning up a mistaken cycle.
-- =========================================================

create policy "schedules: admin can delete"
on schedules for delete
using (is_admin());
