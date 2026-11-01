// Tray, notification and window text in the interface language. The page loads the language's table
// (the same renderer/locales/<code>.json) and hands it over with setLang; it is kept in lang.json so a
// hidden start (no page yet) speaks it too. English is the key and the fallback, as in the page.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

let table: Record<string, string> = {};
let file: string | null = null;

const strings = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length <= 4000))
    : {};

/** Loads the table kept by the last setLang (English when there is none). */
export function loadLangFile(path: string): void {
  file = path;
  try {
    table = strings(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    table = {};
  }
}

/** Takes the page's table and keeps it for the next start. */
export function setLangTable(v: unknown): void {
  table = strings(v);
  if (!file) return;
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(table));
    renameSync(`${file}.tmp`, file);
  } catch {
    // kept in memory for this run
  }
}

export function t(en: string, vars?: Record<string, string | number>): string {
  const s = table[en] || en;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
