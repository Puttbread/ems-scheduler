'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TopBar } from '@/components/TopBar';
import { applyTheme, type ThemePreference } from '@/lib/theme';

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function PreferencesPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<any | null>(null);
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([]);
  const [theme, setTheme] = useState<ThemePreference>('dark');
  const [themeSaving, setThemeSaving] = useState(false);
  const [prefs, setPrefs] = useState({
    prefer_fri_sun_same_weekend: false,
    max_consecutive_shifts: 3,
    prefer_clustered_shifts: false,
    preferred_days_of_week: [] as number[],
    no_day_preference: true,
    carried_forward_from: null as string | null,
    updated_at: null as string | null,
  });
  const [partnerIds, setPartnerIds] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    // Theme is a standing personal setting, independent of any schedule
    // cycle -- fetched regardless of whether one is currently open.
    const { data: profile } = await supabase
      .from('profiles')
      .select('theme_preference')
      .eq('id', user.id)
      .single();
    if (profile?.theme_preference) setTheme(profile.theme_preference as ThemePreference);

    const { data: current } = await supabase
      .from('schedules')
      .select('*')
      .in('status', ['collecting', 'processing'])
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!current) {
      setLoading(false);
      return;
    }
    setSchedule(current);

    const { data: dir } = await supabase.from('staff_directory').select('id, full_name');
    setStaff((dir ?? []).filter((s) => s.id !== user.id));

    let { data: existing } = await supabase
      .from('preferences')
      .select('*')
      .eq('schedule_id', current.id)
      .eq('employee_id', user.id)
      .maybeSingle();

    if (!existing) {
      // Carry forward the most recent prior preferences, if any, as
      // editable defaults -- per the agreed design, these rarely change.
      const { data: prior } = await supabase
        .from('preferences')
        .select('*')
        .eq('employee_id', user.id)
        .neq('schedule_id', current.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (prior) {
        existing = {
          ...prior,
          schedule_id: current.id,
          carried_forward_from: prior.schedule_id,
        };
      }
    }

    if (existing) {
      setPrefs({
        prefer_fri_sun_same_weekend: existing.prefer_fri_sun_same_weekend,
        max_consecutive_shifts: existing.max_consecutive_shifts,
        prefer_clustered_shifts: existing.prefer_clustered_shifts ?? false,
        preferred_days_of_week: existing.preferred_days_of_week ?? [],
        no_day_preference: existing.no_day_preference,
        carried_forward_from: existing.carried_forward_from,
        updated_at: existing.updated_at ?? null,
      });

      const sourceScheduleId = existing.carried_forward_from ?? current.id;
      const { data: partners } = await supabase
        .from('preferred_partners')
        .select('partner_id')
        .eq('employee_id', user.id)
        .eq('schedule_id', sourceScheduleId);
      setPartnerIds((partners ?? []).map((p) => p.partner_id));
    }

    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeTheme(next: ThemePreference) {
    if (!userId || next === theme) return;
    setTheme(next);
    applyTheme(next); // instant visual feedback, no reload needed
    setThemeSaving(true);
    await supabase.from('profiles').update({ theme_preference: next }).eq('id', userId);
    setThemeSaving(false);
  }

  function toggleDay(dow: number) {
    setPrefs((p) => ({
      ...p,
      preferred_days_of_week: p.preferred_days_of_week.includes(dow)
        ? p.preferred_days_of_week.filter((d) => d !== dow)
        : [...p.preferred_days_of_week, dow],
    }));
  }

  function togglePartner(id: string) {
    setPartnerIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  async function save() {
    if (!schedule || !userId) return;
    setSaved(false);

    await supabase.from('preferences').upsert(
      {
        employee_id: userId,
        schedule_id: schedule.id,
        prefer_fri_sun_same_weekend: prefs.prefer_fri_sun_same_weekend,
        max_consecutive_shifts: prefs.max_consecutive_shifts,
        prefer_clustered_shifts: prefs.prefer_clustered_shifts,
        preferred_days_of_week: prefs.no_day_preference ? [] : prefs.preferred_days_of_week,
        no_day_preference: prefs.no_day_preference,
        carried_forward_from: null, // once explicitly saved, no longer just a carried-forward default
      },
      { onConflict: 'employee_id,schedule_id' }
    );

    await supabase
      .from('preferred_partners')
      .delete()
      .eq('employee_id', userId)
      .eq('schedule_id', schedule.id);
    if (partnerIds.length > 0) {
      await supabase.from('preferred_partners').insert(
        partnerIds.map((partner_id) => ({
          employee_id: userId,
          partner_id,
          schedule_id: schedule.id,
        }))
      );
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  if (loading) {
    return (
      <div className="shell">
        <TopBar role="employee" />
        <div className="main">Loading…</div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar role="employee" />
      <div className="main">
        <div className="eyebrow">Preferences</div>
        <h1>Display</h1>

        <div className="card">
          <h2>Theme</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            Applies immediately and everywhere you're logged in.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={theme === 'dark' ? 'btn' : 'btn secondary'}
              onClick={() => changeTheme('dark')}
              disabled={themeSaving}
            >
              Dark
            </button>
            <button
              className={theme === 'light' ? 'btn' : 'btn secondary'}
              onClick={() => changeTheme('light')}
              disabled={themeSaving}
            >
              Light
            </button>
          </div>
        </div>

        {!schedule ? (
          <div className="card">
            <h2>No open cycle</h2>
            <p style={{ color: 'var(--muted)' }}>
              Availability preferences can be set once your administrator opens a new 6-week
              cycle.
            </p>
          </div>
        ) : (
          <>
            <h1 style={{ marginTop: 28 }}>
              {schedule.start_date} → {schedule.end_date}
            </h1>

            {prefs.carried_forward_from && (
              <div className="warn-note">
                Showing preferences carried forward from a prior cycle. Review and save to
                confirm, or adjust anything that's changed.
              </div>
            )}
            {prefs.updated_at && !prefs.carried_forward_from && (
              <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                Last updated {new Date(prefs.updated_at).toLocaleDateString()}
              </p>
            )}

            <div className="card">
              <h2>Weekend pairing</h2>
              <div className="checkbox-row">
                <input
                  type="checkbox"
                  id="frisun"
                  checked={prefs.prefer_fri_sun_same_weekend}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, prefer_fri_sun_same_weekend: e.target.checked }))
                  }
                />
                <label htmlFor="frisun">Prefer to work Friday and Sunday in the same weekend</label>
              </div>
            </div>

            <div className="card">
              <h2>Willing to work back-to-back</h2>
              <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
                Maximum number of shifts you're willing to work in a row (with less than 24 hours
                off between them) before needing a longer break. This is strictly enforced.
              </p>
              <select
                value={prefs.max_consecutive_shifts}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, max_consecutive_shifts: Number(e.target.value) }))
                }
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} shift{n > 1 ? 's' : ''}
                  </option>
                ))}
              </select>

              <div className="checkbox-row" style={{ marginTop: 14 }}>
                <input
                  type="checkbox"
                  id="cluster"
                  checked={prefs.prefer_clustered_shifts}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, prefer_clustered_shifts: e.target.checked }))
                  }
                />
                <label htmlFor="cluster">
                  Prefer to cluster my shifts together (up to the limit above) rather than spread
                  out, to maximize stretches of time off
                </label>
              </div>
            </div>

            <div className="card">
              <h2>Preferred days of the week</h2>
              <div className="checkbox-row">
                <input
                  type="checkbox"
                  id="nopref"
                  checked={prefs.no_day_preference}
                  onChange={(e) => setPrefs((p) => ({ ...p, no_day_preference: e.target.checked }))}
                />
                <label htmlFor="nopref">No preference</label>
              </div>
              {!prefs.no_day_preference && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                  {DOW_LABELS.map((label, dow) => (
                    <div className="checkbox-row" key={dow}>
                      <input
                        type="checkbox"
                        id={`dow-${dow}`}
                        checked={prefs.preferred_days_of_week.includes(dow)}
                        onChange={() => toggleDay(dow)}
                      />
                      <label htmlFor={`dow-${dow}`}>{label}</label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <h2>Preferred partners</h2>
              <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
                The scheduler will try to pair you with these coworkers, but a full schedule
                always comes first.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                {staff.map((s) => (
                  <div className="checkbox-row" key={s.id}>
                    <input
                      type="checkbox"
                      id={`partner-${s.id}`}
                      checked={partnerIds.includes(s.id)}
                      onChange={() => togglePartner(s.id)}
                    />
                    <label htmlFor={`partner-${s.id}`}>{s.full_name}</label>
                  </div>
                ))}
              </div>
            </div>

            <button className="btn" onClick={save}>
              Save preferences
            </button>
            {saved && <span style={{ marginLeft: 12, color: 'var(--green)' }}>Saved.</span>}
          </>
        )}
      </div>
    </div>
  );
}
