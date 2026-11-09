import { createContext, useContext, useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'hth-theme';

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function readPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

const ThemeContext = createContext<{
  preference: ThemePreference;
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readPreference);
  const [system, setSystem] = useState(systemTheme);
  const theme = preference === 'system' ? system : preference;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const changed = () => setSystem(media?.matches ? 'dark' : 'light');
    changed();
    media?.addEventListener('change', changed);
    const stored = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setPreferenceState(readPreference());
    };
    window.addEventListener('storage', stored);
    setPreferenceState(readPreference());
    return () => {
      media?.removeEventListener('change', changed);
      window.removeEventListener('storage', stored);
    };
  }, []);

  function setPreference(value: ThemePreference) {
    const next = parseThemePreference(value);
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be disabled; the current tab still keeps the chosen theme.
    }
  }

  return <ThemeContext value={{ preference, theme, setPreference }}>{children}</ThemeContext>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is required');
  return value;
}
