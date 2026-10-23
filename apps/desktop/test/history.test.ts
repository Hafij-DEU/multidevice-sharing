import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/main/history.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('HistoryStore', () => {
  it('keeps the newest records up to the cap, newest first, and reloads them (0600)', () => {
    const d = mkdtempSync(join(tmpdir(), 'md-hist-'));
    tmps.push(d);
    const file = join(d, 'desktop-history.json');
    const h = new HistoryStore(file, 3);
    for (let i = 0; i < 5; i++) h.addReceived({ at: i, from: 'ab'.repeat(32), alias: `a${i}`, files: [`/x/${i}`] });
    expect(h.received().map((r) => r.at)).toEqual([4, 3, 2]);
    expect(new HistoryStore(file, 3).received().map((r) => r.alias)).toEqual(['a4', 'a3', 'a2']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('starts empty on a missing or corrupt file', () => {
    const d = mkdtempSync(join(tmpdir(), 'md-hist-'));
    tmps.push(d);
    expect(new HistoryStore(join(d, 'none.json')).received()).toEqual([]);
  });
});
