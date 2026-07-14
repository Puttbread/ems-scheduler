-- =========================================================
-- EMS Scheduler: Core Schema
-- =========================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------
-- PROFILES (extends Supabase auth.users)
-- ---------------------------------------------------------
create type user_role as enum ('employee', 'admin');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null,
  role user_role not null default 'employee',
  fte numeric(3,2) not null default 1.00 check (fte > 0 and fte <= 1),
  -- FTE is defined on a 40hr/week basis: 1.0 FTE = 240 hours per 6-week
  -- schedule (40 * 6). See lib/scheduler for how this translates to
  -- per-cycle target hours.
  is_sch_employee boolean not null default false,
  -- When true, this employee additionally may not work more than
  -- (fte * 40) hours in any single calendar week of the schedule --
  -- a per-person rule on top of the normal cycle-total FTE target.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- SCHEDULE CYCLES (6-week blocks)
-- ---------------------------------------------------------
create type schedule_status as enum ('collecting', 'processing', 'published', 'archived');

create table schedules (
  id uuid primary key default uuid_generate_v4(),
  start_date date not null,          -- must be a Monday or admin-chosen anchor; validated in app
  end_date date not null,            -- start_date + 41 days (6 weeks)
  status schedule_status not null default 'collecting',
  -- Coverage for each day is split into a "day" shift and a "night" shift
  -- (no specific clock times stored -- day_12/night_12/full_24 are just
  -- labels). Whether a given day/slot is covered by one full_24 assignment
  -- or a day_12 + night_12 pair is decided per-day by the scheduling
  -- algorithm based on availability, and can be manually adjusted by an
  -- admin afterward.
  shortfall_days integer not null default 0,  -- days-per-employee removed to reach feasibility
  generated_at timestamptz,
  generated_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index idx_schedules_status on schedules(status);
create index idx_schedules_dates on schedules(start_date, end_date);

-- ---------------------------------------------------------
-- AVAILABILITY (per employee, per schedule, per day)
-- ---------------------------------------------------------
create type availability_option as enum (
  'available_24',
  'available_12_day',
  'available_12_night',
  'available_last_resort',
  'not_available'
);

create table availability (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references profiles(id) on delete cascade,
  schedule_id uuid not null references schedules(id) on delete cascade,
  work_date date not null,
  option availability_option not null default 'not_available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, schedule_id, work_date)
);

create index idx_availability_schedule on availability(schedule_id);
create index idx_availability_employee on availability(employee_id, schedule_id);

-- Hours reported once per employee per cycle (vacation / ED / other)
create table cycle_hours (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references profiles(id) on delete cascade,
  schedule_id uuid not null references schedules(id) on delete cascade,
  vacation_hours numeric(6,2) not null default 0,
  ed_hours numeric(6,2) not null default 0,
  other_hours numeric(6,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (employee_id, schedule_id)
);

-- ---------------------------------------------------------
-- PREFERENCES (per employee, per schedule -- carried forward)
-- ---------------------------------------------------------
create table preferences (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references profiles(id) on delete cascade,
  schedule_id uuid not null references schedules(id) on delete cascade,
  prefer_fri_sun_same_weekend boolean not null default false,
  max_consecutive_shifts integer not null default 3 check (max_consecutive_shifts between 1 and 5),
  preferred_days_of_week integer[] not null default '{}',  -- 0=Sun..6=Sat, empty = no preference
  no_day_preference boolean not null default true,
  carried_forward_from uuid references schedules(id),  -- null if manually set this cycle
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, schedule_id)
);

create table preferred_partners (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references profiles(id) on delete cascade,
  partner_id uuid not null references profiles(id) on delete cascade,
  schedule_id uuid not null references schedules(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (employee_id, partner_id, schedule_id),
  check (employee_id <> partner_id)
);

-- ---------------------------------------------------------
-- SHIFT SLOTS & ASSIGNMENTS
-- Populated by the scheduling algorithm at generation time (see
-- /lib/scheduler): for each work_date and slot_number (1 or 2), the
-- algorithm decides whether that slot is best covered by one full_24
-- assignment or a day_12 + night_12 pair, based on that day's availability.
-- Admins can subsequently edit individual assignments by hand, and can
-- re-run generation, which performs a FULL regeneration -- it deletes and
-- rebuilds all of a schedule's slots/assignments from current availability
-- and preferences. Manual edits made before a re-run are NOT preserved by
-- design (kept simple deliberately); manual editing is meant as a final
-- tweak step after the last run, not something to interleave with re-runs.
-- ---------------------------------------------------------
create type shift_type as enum ('day_12', 'night_12', 'full_24');

create table shift_slots (
  id uuid primary key default uuid_generate_v4(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  work_date date not null,
  shift_type shift_type not null,
  slot_number integer not null check (slot_number in (1,2)), -- 2 people required per shift
  created_at timestamptz not null default now(),
  unique (schedule_id, work_date, shift_type, slot_number)
);

create index idx_shift_slots_schedule on shift_slots(schedule_id, work_date);

create table assignments (
  id uuid primary key default uuid_generate_v4(),
  shift_slot_id uuid not null references shift_slots(id) on delete cascade,
  employee_id uuid not null references profiles(id) on delete cascade,
  schedule_id uuid not null references schedules(id) on delete cascade,
  assignment_score numeric(6,3), -- composite weighted score at time of assignment, for audit/explainability
  created_at timestamptz not null default now(),
  unique (shift_slot_id)
);

create index idx_assignments_employee on assignments(employee_id, schedule_id);
create index idx_assignments_schedule on assignments(schedule_id);

-- ---------------------------------------------------------
-- SCHEDULE OVERRIDES
-- Admin-defined exceptions the algorithm consults BEFORE its normal
-- scoring pass for a given (work_date, slot_number, portion):
--   - 'exempt': that portion is excluded from the coverage requirement
--     entirely (e.g. a mandatory all-staff training day) -- no
--     assignment is attempted and it never shows up as an unfilled slot.
--   - 'fixed': a specific employee is locked into that portion (e.g. a
--     standing recurring pattern), bypassing normal scoring. The fixed
--     assignment still counts toward that employee's hours/rest/streak
--     tracking so the rest of their schedule stays consistent.
-- portion = 'full_24' means the whole slot_number's day (both halves);
-- 'day_12'/'night_12' apply to just that half, in which case full_24
-- is no longer a valid option for the other half that day (it must
-- also be resolved as a plain 12hr shift).
-- ---------------------------------------------------------
create type override_type as enum ('exempt', 'fixed');

create table schedule_overrides (
  id uuid primary key default uuid_generate_v4(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  work_date date not null,
  slot_number integer not null check (slot_number in (1,2)),
  portion shift_type not null,
  override_type override_type not null,
  employee_id uuid references profiles(id), -- required if override_type = 'fixed', null if 'exempt'
  note text,
  created_at timestamptz not null default now(),
  unique (schedule_id, work_date, slot_number, portion),
  check (
    (override_type = 'fixed' and employee_id is not null) or
    (override_type = 'exempt' and employee_id is null)
  )
);

create index idx_overrides_schedule on schedule_overrides(schedule_id);

-- ---------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();
create trigger trg_availability_updated before update on availability
  for each row execute function set_updated_at();
create trigger trg_preferences_updated before update on preferences
  for each row execute function set_updated_at();
create trigger trg_cycle_hours_updated before update on cycle_hours
  for each row execute function set_updated_at();
