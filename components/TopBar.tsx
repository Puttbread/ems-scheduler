'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function TopBar({ role }: { role: 'employee' | 'admin' }) {
  const router = useRouter();
  const supabase = createClient();

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
