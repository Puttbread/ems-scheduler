-- =========================================================
-- Auto-create a profiles row whenever a new auth.users row appears --
-- covers both the admin's "invite employee" flow (signInWithOtp) and
-- any direct signup. full_name is pulled from the auth metadata the
-- invite call attaches; falls back to the email local-part if absent.
-- =========================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
