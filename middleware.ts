import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runs on every request. Two jobs:
 *  1. Refresh the Supabase session cookie so it doesn't expire mid-use.
 *  2. Gate /admin/* and /employee/* by auth state and role, so someone
 *     can't reach an admin page just by typing the URL -- the page itself
 *     would also be protected by RLS on data, but redirecting here gives
 *     a clean UX instead of a page full of empty/denied queries.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isAuthRoute = path === '/login';
  const isAdminRoute = path.startsWith('/admin');
  const isEmployeeRoute = path.startsWith('/employee') || path.startsWith('/preferences');

  if (!user && (isAdminRoute || isEmployeeRoute)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (user && isAuthRoute) {
    // Already logged in -- send to the right home page.
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    const dest = profile?.role === 'admin' ? '/admin' : '/employee';
    return NextResponse.redirect(new URL(dest, request.url));
  }

  if (user && isAdminRoute) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role !== 'admin') {
      return NextResponse.redirect(new URL('/employee', request.url));
    }
  }

  if (user && isEmployeeRoute) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role === 'admin') {
      // An admin account has no business submitting availability/preferences
      // under its own ID -- that data would silently be excluded from the
      // schedulable employee pool, which is confusing to debug. Send them
      // back to the admin dashboard instead.
      return NextResponse.redirect(new URL('/admin', request.url));
    }
  }

  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/employee/:path*', '/preferences/:path*', '/login', '/login/:path*'],
};
