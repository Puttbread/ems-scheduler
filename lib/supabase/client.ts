import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser client -- uses the public anon key. Every request from this
 * client carries the logged-in user's JWT, so all the RLS policies from
 * 0002_rls_policies.sql apply automatically. This is safe to use in any
 * client component; it can never see more than RLS allows regardless of
 * what code asks for.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
