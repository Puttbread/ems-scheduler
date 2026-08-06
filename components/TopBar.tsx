'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { syncThemeFromProfile } from '@/lib/theme';

export function TopBar({ role }: { role: 'employee' | 'admin' }) {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    syncThemeFromProfile(supabase);
    // Only needs to run once per mount -- TopBar is present on every
    // authenticated page, so this effectively syncs on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="topbar">
      <div className="brand">
        <span className="dot" />
        <span>EMS SCHEDULER</span>
      </div>
      <nav style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
        {role === 'employee' ? (
          <>
            <Link href="/employee">Schedule</Link>
            <Link href="/employee/history">History</Link>
            <Link href="/preferences">Preferences</Link>
            <Link href="/employee/account">Account</Link>
          </>
        ) : (
          <>
            <Link href="/admin">Dashboard</Link>
            <Link href="/admin/employees">Staff</Link>
          </>
        )}
        <button className="btn secondary" onClick={signOut}>
          Sign out
        </button>
      </nav>
    </div>
  );
}
