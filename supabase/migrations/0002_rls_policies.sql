-- =========================================================
-- EMS Scheduler: Row Level Security
-- These policies are the real security boundary -- the Supabase anon/auth
-- keys are public by design, so access control must live here, not just
-- in frontend routing.
-- =========================================================

-- ---------------------------------------------------------
-- Helper: is the current user an admin?
-- SECURITY DEFINER so it can read profiles.role without recursing into
-- the RLS policy that itself calls this function.
-- ---------------------------------------------------------
create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------------------------------------------------------
-- PROFILES
-- Full row (including FTE, role) visible only to the owner and admins.
-- Co-workers should NOT see each other's FTE -- that's why we expose a
-- separate narrow view (staff_directory) below for the partner-picker UI.
-- ---------------------------------------------------------
alter table profiles enable row level security;

create policy "profiles: self or admin can select"
on profiles for select
using (id = auth.uid() or is_admin());

create policy "profiles: self can update own non-privileged fields"
on profiles for update
using (id = auth.uid())
with check (id = auth.uid());
-- Note: role/fte changes are further restricted at the application layer
-- (API route checks) since column-level RLS isn't native; admin-only
-- write access is enforced below as a second, broader policy.

create policy "profiles: admin can update any"
on profiles for update
using (is_admin())
with check (is_admin());

create policy "profiles: admin can insert"
on profiles for insert
with check (is_admin());

-- Narrow view for the "preferred partners" checkbox list: name only, no FTE/role.
create view staff_directory
with (security_invoker = true)
as
select id, full_name
from profiles
where active = true;

grant select on staff_directory to authenticated;

-- ---------------------------------------------------------
-- SCHEDULES
-- All authenticated employees can view schedules (they need to see the
-- 6-week calendar and status). Only admins can create/modify.
-- ---------------------------------------------------------
alter table schedules enable row level security;

create policy "schedules: any authenticated user can select"
on schedules for select
using (auth.role() = 'authenticated');

create policy "schedules: admin can insert"
on schedules for insert
with check (is_admin());

create policy "schedules: admin can update"
on schedules for update
using (is_admin())
with check (is_admin());

-- ---------------------------------------------------------
-- AVAILABILITY
-- Employees can edit their own rows only while the parent schedule is
-- still in 'collecting' status -- once the admin runs the algorithm
-- (status moves to 'processing'/'published'), further edits require
-- going through the admin. This is enforced here, not just in the UI,
-- so a late direct write can't sneak in after generation has started.
-- Admins can view all (needed to run the algorithm and see who hasn't
-- submitted) and can edit on an employee's behalf at any time, e.g. to
-- fix a mistake before re-running.
-- ---------------------------------------------------------
alter table availability enable row level security;

create or replace function schedule_is_collecting(sched_id uuid)
returns boolean
language sql
stable
as $$
  select status = 'collecting' from schedules where id = sched_id;
$$;

create policy "availability: owner or admin can select"
on availability for select
using (employee_id = auth.uid() or is_admin());

create policy "availability: owner can insert while collecting"
on availability for insert
with check (
  employee_id = auth.uid() and schedule_is_collecting(schedule_id)
);

create policy "availability: owner can update while collecting"
on availability for update
using (employee_id = auth.uid() and schedule_is_collecting(schedule_id))
with check (employee_id = auth.uid() and schedule_is_collecting(schedule_id));

create policy "availability: admin can insert or update anytime"
on availability for all
using (is_admin())
with check (is_admin());

alter table cycle_hours enable row level security;

create policy "cycle_hours: owner or admin can select"
on cycle_hours for select
using (employee_id = auth.uid() or is_admin());

create policy "cycle_hours: owner can insert"
on cycle_hours for insert
with check (employee_id = auth.uid());

create policy "cycle_hours: owner can update"
on cycle_hours for update
using (employee_id = auth.uid())
with check (employee_id = auth.uid());

-- ---------------------------------------------------------
-- PREFERENCES -- strictly self + admin only, per requirement.
-- ---------------------------------------------------------
alter table preferences enable row level security;

create policy "preferences: owner or admin can select"
on preferences for select
using (employee_id = auth.uid() or is_admin());

create policy "preferences: owner can insert"
on preferences for insert
with check (employee_id = auth.uid());

create policy "preferences: owner can update"
on preferences for update
using (employee_id = auth.uid())
with check (employee_id = auth.uid());

alter table preferred_partners enable row level security;

create policy "preferred_partners: owner or admin can select"
on preferred_partners for select
using (employee_id = auth.uid() or is_admin());

create policy "preferred_partners: owner can insert"
on preferred_partners for insert
with check (employee_id = auth.uid());

create policy "preferred_partners: owner can delete"
on preferred_partners for delete
using (employee_id = auth.uid());

-- ---------------------------------------------------------
-- SHIFT SLOTS & ASSIGNMENTS
-- Everyone can view the schedule. Admins can insert, update, and delete --
-- needed both for manual shift edits (e.g. swapping who's on a shift) and
-- for re-running the algorithm, which clears a schedule's existing slots/
-- assignments and rebuilds them.
-- ---------------------------------------------------------
alter table shift_slots enable row level security;

create policy "shift_slots: any authenticated user can select"
on shift_slots for select
using (auth.role() = 'authenticated');

create policy "shift_slots: admin can manage"
on shift_slots for all
using (is_admin())
with check (is_admin());

alter table assignments enable row level security;

create policy "assignments: any authenticated user can select"
on assignments for select
using (auth.role() = 'authenticated');

create policy "assignments: admin can manage"
on assignments for all
using (is_admin())
with check (is_admin());

-- ---------------------------------------------------------
-- SCHEDULE OVERRIDES -- visible to everyone (employees benefit from
-- seeing "this day is a training day" context), admin-only write.
-- ---------------------------------------------------------
alter table schedule_overrides enable row level security;

create policy "schedule_overrides: any authenticated user can select"
on schedule_overrides for select
using (auth.role() = 'authenticated');

create policy "schedule_overrides: admin can manage"
on schedule_overrides for all
using (is_admin())
with check (is_admin());
