import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/cron/keep-alive
 *
 * Triggered once daily by Vercel Cron (see vercel.json). Performs a real
 * database write -- an insert, not just a read -- since that's what
 * resets Supabase's free-tier 7-day inactivity pause timer. Also rolls
 * off anything older than 14 days so the table never grows.
 *
 * Runs with no logged-in user (Vercel's scheduler, not a person), so it
 * can't use the app's normal cookie-based server client -- it talks to
 * Supabase directly with the anon key. See the 0012 migration for why
 * keep_alive_pings has an intentionally open RLS policy.
 */
export async function GET(request: Request) {
  // Vercel automatically sets CRON_SECRET and sends it as a bearer token
  // on every cron invocation -- checking it stops random internet
  // requests from hitting this route (harmless if they did, since all
  // it does is insert a throwaway row, but there's no reason not to gate it).
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('keep_alive_pings').delete().lt('created_at', cutoff);

  const { error } = await supabase.from('keep_alive_pings').insert({});
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, pinged_at: new Date().toISOString() });
}
