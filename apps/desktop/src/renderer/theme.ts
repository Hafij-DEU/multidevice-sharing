// Light, dark, or the system's choice (the default). The resolved theme goes on <html data-theme>,
// which styles.css keys its colours on; the choice is kept per device.
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'md.theme';
const dark = matchMedia('(prefers-color-scheme: dark)');

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(): void {
  const c = themeChoice();
  document.documentElement.dataset.theme = c === 'system' ? (dark.matches ? 'dark' : 'light') : c;
}

export function setThemeChoice(c: ThemeChoice): void {
  try {
    if (c === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    // no storage: the choice lasts until the window closes
  }
  apply();
}

apply();
dark.addEventListener('change', apply);
