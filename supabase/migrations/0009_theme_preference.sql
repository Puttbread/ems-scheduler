-- =========================================================
-- Theme preference (light/dark). Lives on profiles, not on a per-cycle
-- table, since this is a standing personal display setting -- it
-- shouldn't reset or need re-confirming every 6-week cycle the way
-- availability/preferences do.
-- =========================================================

alter table profiles
  add column theme_preference text not null default 'dark'
  check (theme_preference in ('dark', 'light'));
