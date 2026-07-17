-- =========================================================
-- Fix: staff_directory was created with security_invoker = true, which
-- means it re-applies the profiles table's own RLS (self-or-admin-only)
-- to whoever queries the view -- defeating its entire purpose, which is
-- to expose just id+full_name of all active staff to any authenticated
-- user (for the "preferred partners" picker). It needs to run with the
-- view owner's permissions instead; safety comes from only exposing two
-- columns, not from re-checking the base table's RLS.
-- =========================================================

alter view staff_directory set (security_invoker = false);
