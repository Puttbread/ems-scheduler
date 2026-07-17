'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TopBar } from '@/components/TopBar';

export default function EmployeesAdminPage() {
  const supabase = createClient();
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('profiles').select('*').order('full_name');
    setStaff(data ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function updateLocal(id: string, field: string, value: any) {
    setStaff((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }

  async function updateField(id: string, field: string, value: any) {
    updateLocal(id, field, value);
    const { error } = await supabase.from('profiles').update({ [field]: value }).eq('id', id);
    if (error) setInviteMsg(`Couldn't save ${field}: ${error.message}`);
  }

  async function sendReset(email: string) {
    setInviteMsg(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login/reset`,
    });
    setInviteMsg(error ? error.message : `Password reset email sent to ${email}.`);
  }

  async function inviteEmployee() {
    if (!newEmail || !newName || !newUsername) return;
    setInviteMsg(null);
    // Employees are created via Supabase Auth invite (magic link) -- new
    // accounts default to role 'employee' and fte 1.00 via the profiles
    // table default, then editable below. This requires email invites to
    // be enabled in the Supabase Auth settings for your project.
    const { error } = await supabase.auth.signInWithOtp({
      email: newEmail,
      options: { data: { full_name: newName, username: newUsername } },
    });
    setInviteMsg(
      error
        ? error.message
        : `Invite sent to ${newEmail}. They'll log in with the username "${newUsername}". Once they sign in, add their profile row with the correct name/FTE below if it doesn't appear automatically.`
    );
    setNewEmail('');
    setNewName('');
    setNewUsername('');
    load();
  }

  return (
    <div className="shell">
      <TopBar role="admin" />
      <div className="main">
        <div className="eyebrow">Administrator</div>
        <h1>Staff</h1>

        <div className="card">
          <h2>Invite a new employee</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Full name</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Username</label>
              <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label>Email</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <button className="btn" onClick={inviteEmployee}>
              Send invite
            </button>
          </div>
          {inviteMsg && (
            <p style={{ color: 'var(--amber)', fontSize: '0.82rem', marginTop: 8 }}>{inviteMsg}</p>
          )}
        </div>

        {loading ? (
          <p>Loading…</p>
        ) : (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>FTE</th>
                  <th>SCH Employee</th>
                  <th>Active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        value={s.full_name}
                        onChange={(e) => updateLocal(s.id, 'full_name', e.target.value)}
                        onBlur={(e) => updateField(s.id, 'full_name', e.target.value)}
                        style={{ width: 130 }}
                      />
                    </td>
                    <td>
                      <input
                        value={s.username}
                        onChange={(e) => updateLocal(s.id, 'username', e.target.value)}
                        onBlur={(e) => updateField(s.id, 'username', e.target.value)}
                        style={{ width: 110 }}
                      />
                    </td>
                    <td>
                      <select
                        value={s.role}
                        onChange={(e) => updateField(s.id, 'role', e.target.value)}
                      >
                        <option value="employee">employee</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0.1}
                        max={1}
                        step={0.05}
                        style={{ width: 70 }}
                        value={s.fte}
                        onChange={(e) => updateField(s.id, 'fte', Number(e.target.value))}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={s.is_sch_employee}
                        onChange={(e) => updateField(s.id, 'is_sch_employee', e.target.checked)}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={s.active}
                        onChange={(e) => updateField(s.id, 'active', e.target.checked)}
                      />
                    </td>
                    <td>
                      <button className="btn secondary" onClick={() => sendReset(s.email)}>
                        Reset password
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
