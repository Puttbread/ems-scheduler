import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server client for use in Server Components, Route Handlers, and Server
 * Actions. Reads the user's session from cookies and still runs under
 * RLS (using the anon key + the user's JWT), so this is NOT a privilege
 * escalation -- it's the same access a browser client would have, just
 * usable during server-side rendering.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll called from a Server Component -- safe to ignore since
            // middleware refreshes the session on every request anyway.
          }
        },
      },
    }
  );
}
