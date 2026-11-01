import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script, no types
import { keys, locale } from '../scripts/i18n-keys.mjs';

const KEYS: string[] = keys();
const CODES = readdirSync(new URL('../src/renderer/locales', import.meta.url))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5));
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('interface translations', () => {
  it('has every shipped language', () => {
    expect(CODES.sort()).toEqual(['bn', 'de', 'es', 'fr', 'hi', 'it', 'tr', 'ur', 'zh']);
  });

  for (const code of CODES) {
    it(`${code}: translates every string, keeps its {placeholders}, has no stale ones`, () => {
      const table: Record<string, string> = locale(code);
      expect(KEYS.filter((k) => !table[k]?.trim())).toEqual([]);
      expect(Object.keys(table).filter((k) => !KEYS.includes(k))).toEqual([]);
      expect(KEYS.filter((k) => holes(k).join() !== holes(table[k] ?? '').join())).toEqual([]);
    });
  }
});
