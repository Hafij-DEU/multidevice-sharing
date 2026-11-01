// Light, dark (plain, midnight blue or true black), or the system's choice (the default). The
// resolved theme goes on <html data-theme> and a dark shade on <html data-shade>, which styles.css
// keys its colours on; the choice is kept per device.
export type ThemeChoice = 'system' | 'light' | 'dark' | 'midnight' | 'black';
const CHOICES: ThemeChoice[] = ['light', 'dark', 'midnight', 'black'];

const KEY = 'md.theme';
const dark = matchMedia('(prefers-color-scheme: dark)');

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return (CHOICES as (string | null)[]).includes(v) ? (v as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

function apply(): void {
  const c = themeChoice();
  const root = document.documentElement;
  root.dataset.theme = c === 'system' ? (dark.matches ? 'dark' : 'light') : c === 'light' ? 'light' : 'dark';
  if (c === 'midnight' || c === 'black') root.dataset.shade = c;
  else delete root.dataset.shade;
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

// Colour palette: the accent and gradient colours, also kept per device (<html data-palette>).
export const PALETTES = ['aurora', 'ocean', 'sunset', 'forest', 'candy', 'neon', 'graphite'] as const;
export type Palette = (typeof PALETTES)[number];
const PKEY = 'md.palette';

export function palette(): Palette {
  try {
    const v = localStorage.getItem(PKEY);
    return (PALETTES as readonly string[]).includes(v ?? '') ? (v as Palette) : 'aurora';
  } catch {
    return 'aurora';
  }
}

export function setPalette(p: Palette): void {
  try {
    if (p === 'aurora') localStorage.removeItem(PKEY);
    else localStorage.setItem(PKEY, p);
  } catch {
    // no storage: the choice lasts until the window closes
  }
  document.documentElement.dataset.palette = p;
}

document.documentElement.dataset.palette = palette();
