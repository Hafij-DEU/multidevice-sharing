// Interface language: the system's (the default) or one picked in Settings, kept per device. The
// English text is the key: t('Send to') looks it up in the language's table (locales/<code>.json)
// and falls back to the English while a string has no translation. {name} placeholders take vars.
export const LANGS = {
  en: 'English',
  tr: 'Türkçe',
  bn: 'বাংলা',
  it: 'Italiano',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  zh: '中文',
  hi: 'हिन्दी',
  ur: 'اردو',
} as const;
export type Lang = keyof typeof LANGS;
export type LangChoice = Lang | 'system';

const KEY = 'md.lang';
const RTL: Lang[] = ['ur'];
// One chunk per language, loaded only when picked.
const TABLES = import.meta.glob<Record<string, string>>('./locales/*.json', { import: 'default' });

let table: Record<string, string> = {};
let current: Lang = 'en';
const listeners = new Set<() => void>();

const isLang = (v: string | null | undefined): v is Lang => !!v && Object.hasOwn(LANGS, v);

export function langChoice(): LangChoice {
  try {
    const v = localStorage.getItem(KEY);
    return isLang(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The first system language MeshDrop has (zh-CN → zh), else English. */
function systemLang(): Lang {
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = l?.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

export function lang(): Lang {
  return current;
}

/** Loads the chosen language's table and sets <html lang dir>; call once before the first render. */
export async function loadLang(): Promise<void> {
  const c = langChoice();
  current = c === 'system' ? systemLang() : c;
  const load = TABLES[`./locales/${current}.json`];
  table = load ? await load().catch(() => ({})) : {};
  const root = document.documentElement;
  root.lang = current;
  root.dir = RTL.includes(current) ? 'rtl' : 'ltr';
  // the tray and notifications speak it too (older native sides lack setLang)
  void window.meshdrop?.setLang?.(table).catch(() => {});
}

export async function setLangChoice(c: LangChoice): Promise<void> {
  try {
    if (c === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    // no storage: the choice lasts until the window closes
  }
  await loadLang();
  for (const f of listeners) f();
}

// Another window (the clipboard picker, the main window) changed the language: follow it.
window.addEventListener('storage', (e) => {
  if (e.key === KEY || e.key === null) void loadLang().then(() => listeners.forEach((f) => f()));
});

/** Called after the language changes (the root re-renders the whole app). */
export function onLangChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function t(en: string, vars?: Record<string, string | number>): string {
  const s = table[en] || en;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Marks a string kept in a module-level table so it is listed for translation; show it with t(). */
export const mark = (en: string): string => en;
