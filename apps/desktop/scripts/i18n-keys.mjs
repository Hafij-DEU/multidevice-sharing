// Lists every interface string: the first argument of each t('…') or mark('…') call in src/renderer and
// src/main (tray, notifications) and each Tr.t("…") in the Android app and engine, in source order without
// repeats. `node scripts/i18n-keys.mjs` prints them as a JSON array (the input for
// translating); `--missing <code>` prints only those locales/<code>.json lacks.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src/renderer', import.meta.url));
const MAIN = fileURLToPath(new URL('../src/main', import.meta.url));
const JAVA = ['app', 'engine'].map((m) => fileURLToPath(new URL(`../../android/${m}/src/main/java`, import.meta.url)));
const JAVA_CALL = /\bTr\.t\(\s*"((?:\\.|[^"\\])*)"/g;
const CALL = /\b(?:t|mark)\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;

function files(dir, ext = /\.tsx?$/) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) && e.name !== 'i18n.ts' ? [join(dir, e.name)] : [],
  );
}

const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);

export function keys() {
  const out = new Set();
  for (const f of [...files(ROOT), ...files(MAIN)].sort()) for (const m of readFileSync(f, 'utf8').matchAll(CALL)) out.add(unescape(m[1] ?? m[2]));
  for (const f of JAVA.flatMap((d) => files(d, /\.java$/)).sort()) for (const m of readFileSync(f, 'utf8').matchAll(JAVA_CALL)) out.add(unescape(m[1]));
  return [...out];
}

export function locale(code) {
  return JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--missing');
  const all = keys();
  const list = i > 0 ? all.filter((k) => !locale(process.argv[i + 1])[k]) : all;
  process.stdout.write(JSON.stringify(list, null, 2) + '\n');
}
