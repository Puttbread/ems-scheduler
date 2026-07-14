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
   order** (0001, 0002, 0003, 0004, 0005).
3. In **Authentication > Providers**, ensure Email is enabled.
4. In **Authentication > URL Configuration**, set your site URL (e.g. your
   Vercel/Netlify deployment URL) and add `/login/reset` as an allowed
   redirect URL.
5. Copy your Project URL and anon/public key from **Project Settings > API**.

## 2. Create the first administrator

New signups default to `role = 'employee'` via the `profiles` table. To
create your first admin:

1. Have them sign in once (via an invite you send from **Authentication >
   Users > Invite user** in the Supabase dashboard, or via the app's staff
   invite once at least one admin exists).
2. In the SQL Editor, run:
   ```sql
   update profiles set role = 'admin' where email = 'admin@example.com';
   ```

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

## How scheduling works

See `lib/scheduler/engine.ts` for the full algorithm. In short: for every
day and every one of the two required coverage slots, it scores every
eligible employee (based on availability, weighted preferences, and hard
constraints like rest periods and consecutive-shift caps) and assigns the
best-scoring option, deciding per slot whether one 24-hour shift or a
day/night 12-hour pair works better. If any employee can't reach their FTE
target hours (240 x FTE per 6-week cycle, minus reported vacation/ED/other
hours), it reduces every employee's target by one day and retries, tracking
how many days were shorted for the export note.

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

