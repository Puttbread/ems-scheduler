import type { SupabaseClient } from '@supabase/supabase-js';

export type ThemePreference = 'dark' | 'light';

/** Applies a theme to the current page immediately and caches it for the
 * next page load's blocking inline script (see app/layout.tsx). */
export function applyTheme(theme: ThemePreference) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // localStorage can throw in some privacy modes -- fine to skip caching.
  }
}

/** Fetches the logged-in user's saved theme preference from their profile
 * and applies it -- the database is always the source of truth; the
 * inline script in layout.tsx just avoids a flash before this resolves. */
export async function syncThemeFromProfile(supabase: SupabaseClient) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('theme_preference')
    .eq('id', user.id)
    .single();

  if (profile?.theme_preference) {
    applyTheme(profile.theme_preference as ThemePreference);
  }
}
