/** The page theme: follow the system, or a choice remembered in this browser. The graph is dark in both. */
export type ThemeChoice = 'system' | 'light' | 'dark';

const THEME_KEY = 'memnest.theme';

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Stamps the choice on <html>, where styles.css reads it; "system" leaves it to prefers-color-scheme. */
export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Private windows and blocked storage: the choice lasts for this page only.
  }
}
