-- =========================================================
-- Username-based login. Supabase Auth is email-based under the hood, so
-- this adds a separate username the person actually types to log in,
-- resolved to their real email via a SECURITY DEFINER function callable
-- before authentication (the login page calls this first, then signs in
-- with the resolved email + password).
-- =========================================================

alter table profiles add column username text;

-- Backfill existing rows with their full email as a safe, guaranteed-
-- unique starting username (emails are already unique via auth.users).
-- Admins can then set something nicer per employee afterward.
update profiles set username = email where username is null;

alter table profiles alter column username set not null;
alter table profiles add constraint profiles_username_key unique (username);

-- Callable by anyone (including logged-out users) so the login page can
-- resolve "username" -> "email" before calling signInWithPassword. Only
-- returns an email string; reveals nothing else about the account.
create or replace function get_email_for_username(p_username text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select email from profiles where username = p_username limit 1;
$$;

grant execute on function get_email_for_username(text) to anon, authenticated;

-- Update the signup trigger to also set username from invite metadata,
-- falling back to the email local-part if none was supplied.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, username)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
