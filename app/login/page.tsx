'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { data: email, error: lookupError } = await supabase.rpc('get_email_for_username', {
      p_username: username,
    });
    if (lookupError || !email) {
      setLoading(false);
      setError('Invalid username or password.');
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError('Invalid username or password.');
      return;
    }
    router.push('/');
    router.refresh();
  }

  async function handleResetRequest() {
    if (!username) {
      setError('Enter your username above first, then click "Forgot password".');
      return;
    }
    setError(null);
    const { data: email, error: lookupError } = await supabase.rpc('get_email_for_username', {
      p_username: username,
    });
    if (lookupError || !email) {
      setError('Invalid username or password.');
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login/reset`,
    });
    if (error) setError(error.message);
    else setResetSent(true);
  }

  return (
    <div className="shell">
      <div className="main" style={{ maxWidth: 380, marginTop: '10vh' }}>
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 28 }}>
          <span className="dot" />
          <span>EMS SCHEDULER</span>
        </div>
        <div className="card">
          <div className="eyebrow">Sign in</div>
          <form onSubmit={handleLogin}>
            <div className="form-row">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
            <div className="form-row">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: '0.85rem' }}>{error}</p>}
            {resetSent && (
              <p style={{ color: 'var(--green)', fontSize: '0.85rem' }}>
                Password reset email sent -- check your inbox.
              </p>
            )}
            <button className="btn" type="submit" disabled={loading} style={{ width: '100%', marginTop: 8 }}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <button
            onClick={handleResetRequest}
            className="btn secondary"
            style={{ width: '100%', marginTop: 10 }}
          >
            Forgot password
          </button>
        </div>
      </div>
    </div>
  );
}
