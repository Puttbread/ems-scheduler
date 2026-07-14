'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      return;
    }
    setDone(true);
    setTimeout(() => router.push('/'), 1500);
  }

  return (
    <div className="shell">
      <div className="main" style={{ maxWidth: 380, marginTop: '10vh' }}>
        <div className="card">
          <div className="eyebrow">Set a new password</div>
          {done ? (
            <p style={{ color: 'var(--green)' }}>Password updated. Redirecting…</p>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <label htmlFor="password">New password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              {error && <p style={{ color: 'var(--red)', fontSize: '0.85rem' }}>{error}</p>}
              <button className="btn" type="submit" style={{ width: '100%' }}>
                Update password
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
