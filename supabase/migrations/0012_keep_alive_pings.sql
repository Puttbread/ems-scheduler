-- =========================================================
-- Keep-alive pings, to prevent Supabase's free-tier 7-day inactivity
-- pause between real schedule-running activity. A daily cron job (see
-- app/api/cron/keep-alive/route.ts) writes one row here -- a genuine
-- database write is what resets Supabase's inactivity clock, so this
-- has to be a real insert, not just a read.
--
-- This table intentionally holds nothing sensitive -- it exists purely
-- to register activity. RLS is deliberately permissive (open insert/
-- delete) because the cron job runs on Vercel's schedule with no logged-
-- in user session, so there's no JWT to scope a normal RLS policy to;
-- and since a row here has zero business value if tampered with, an
-- open policy on this ONE table is a reasonable, low-stakes trade-off
-- rather than introducing a service-role key into the app.
-- =========================================================

create table keep_alive_pings (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now()
);

alter table keep_alive_pings enable row level security;

create policy "keep_alive_pings: anyone can insert"
on keep_alive_pings for insert
to anon, authenticated
with check (true);

create policy "keep_alive_pings: anyone can delete"
on keep_alive_pings for delete
to anon, authenticated
using (true);

create policy "keep_alive_pings: admin can select"
on keep_alive_pings for select
using (is_admin());
