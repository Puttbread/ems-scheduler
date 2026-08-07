# EMS Scheduler

A 6-week, 24/7 shift scheduling tool for a small EMS crew. Employees submit
availability and preferences; an administrator runs a weighted scheduling
algorithm and exports the result.

## Stack

- **Frontend/backend:** Next.js 14 (App Router), deployable to Vercel or
  Netlify.
- **Database/auth:** Supabase (Postgres + Auth + Row Level Security).

## 1. Set up Supabase

1. Create a project at https://supabase.com.
2. In the SQL Editor, run the migrations in `supabase/migrations/` **in
   order** (0001 through 0012).
3. In **Authentication > Providers**, ensure Email is enabled.
4. In **Authentication > URL Configuration**, set your site URL (e.g. your
   Vercel/Netlify deployment URL) and add `/login/reset` as an allowed
   redirect URL.
5. Copy your Project URL and anon/public key from **Project Settings > API**.

## 2. Create the first administrator

New signups default to `role = 'employee'` via the `profiles` table, and
get a `username` (used to log in) either from the invite form or, if none
was given, derived from their email. To create your first admin:

1. Have them sign in once (via an invite you send from **Authentication >
   Users > Invite user** in the Supabase dashboard, or via the app's staff
   invite once at least one admin exists).
2. In the SQL Editor, run:
   ```sql
   update profiles set role = 'admin' where email = 'admin@example.com';
   ```
3. Optionally set a nicer username for them too:
   ```sql
   update profiles set username = 'admin' where email = 'admin@example.com';
   ```

Login is username-based, not email-based -- the login page resolves the
typed username to the account's real email behind the scenes before
authenticating.

## 3. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your Supabase URL and anon
key. Set the same two variables in your Vercel/Netlify project settings for
deployment.

## 4. Install and run locally

```bash
npm install
npm run dev
```

## 5. Deploy

- **Vercel:** import the repo, set the two env vars, deploy -- Next.js is
  natively supported.
- **Netlify:** import the repo, set the two env vars, and add the
  `@netlify/plugin-nextjs` plugin (Netlify will usually prompt for this
  automatically when it detects Next.js).

## Keeping the free Supabase project from pausing

Supabase pauses free-tier projects after 7 days with no real database
activity, and only recovers once someone manually un-pauses it from the
dashboard. Since this app is realistically only used in bursts around
each 6-week schedule, a daily cron job (`vercel.json` + `app/api/cron/
keep-alive/route.ts`) writes one throwaway row to a small
`keep_alive_pings` table every day, which is enough to keep the project
active indefinitely -- no manual attention needed. Old rows are cleaned
up automatically (nothing older than 14 days is kept), so the table
never grows.

**This only works if you deploy on Vercel** -- `vercel.json`'s `crons`
key is Vercel-specific and does nothing on Netlify or elsewhere. If you
deploy somewhere else, you'd need an equivalent scheduled trigger for
that platform (or an external scheduler like GitHub Actions or a free
uptime-monitor service) hitting `/api/cron/keep-alive` once a day, with a
`CRON_SECRET` environment variable set to match what the route checks
for.

**Setup is automatic on Vercel** -- once `vercel.json` is present in the
repo and you deploy, Vercel detects the `crons` entry, registers the
schedule, and automatically provisions the `CRON_SECRET` environment
variable used to authenticate the request. No manual secret setup is
needed. You can confirm it's running under your Vercel project's
**Settings → Cron Jobs** tab, and check `keep_alive_pings` in the SQL
Editor to see a growing (and self-trimming) list of daily timestamps.

## How scheduling works

See `lib/scheduler/engine.ts` for the full algorithm. It runs in two
passes: first, across the entire 6-week cycle, it fills as many slots as
possible with a single 24-hour shift (using only employees who marked
`available_24` that day). Whatever's left after that pass is filled with
12-hour day/night shifts in a second pass, pulling only from employees who
specifically marked 12-hour availability for that half (or "available last
resort," which applies broadly). This ordering means a 24-hour
availability pick is never edged out by two 12-hour picks scoring higher
in combination -- it's used as a 24hr shift wherever the rules allow.

Within each pass, every eligible employee for a slot is scored (based on
availability weight and preference bonuses) and the highest-scoring
eligible option wins, subject to hard constraints (rest periods --
checked against the nearest neighboring shift in time, not simply "the
last one assigned," so the two-pass ordering can't produce an unsafe
gap -- consecutive-shift caps, weekend/Friday limits, the 110hr/10-day
cap, and FTE targets).

Unfilled coverage slots are allowed (not every shift will always have
someone available) and are surfaced to the admin after a run, though they
aren't persisted between page loads -- check the result right after running.

## Overrides (exemptions & fixed/recurring assignments)

From a schedule's detail page, an admin can add an **override** for a
specific date/slot/portion (full day, day-half, or night-half):

- **Exempt** -- excludes that portion from the coverage requirement
  entirely (e.g. a mandatory all-staff training day). No assignment is
  attempted and it's never flagged as unfilled.
- **Fixed** -- locks a specific employee into that portion (e.g. a
  standing recurring shift pattern), bypassing the normal scoring/hard
  constraint checks for that one assignment. Its hours still count toward
  that employee's tracking, so the rest of the algorithm's picks for them
  stay consistent.

When a new 6-week cycle is created, overrides from the most recent prior
cycle are copied forward automatically (translated to the equivalent day
within the new cycle, e.g. "day 8 of the cycle"), the same way preferences
carry forward -- so a standing pattern only needs to be set up once, and
can be edited or removed each cycle without affecting past cycles.

