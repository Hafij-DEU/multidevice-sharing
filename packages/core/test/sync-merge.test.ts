import { describe, expect, it } from 'vitest';
import { conflictName, decide } from '../src/sync/merge.ts';
import { ignored } from '../src/sync/ignore.ts';

const ids = { local: 'aa', remote: 'bb' };
const f = (hash: string | null, mtime = 0) => ({ hash, mtime });

describe('sync merge', () => {
  it('agrees when both sides are the same (including both gone)', () => {
    expect(decide(f('h1'), f('h1'), null, ids)).toEqual({ kind: 'agree', base: 'h1' });
    expect(decide(f(null), f(null), 'h0', ids)).toEqual({ kind: 'agree', base: null });
  });
  it('takes the remote change when the local side is still the base', () => {
    expect(decide(f(null), f('h1'), null, ids)).toEqual({ kind: 'take', base: 'h1' }); // new on the partner
    expect(decide(f('h0'), f('h1'), 'h0', ids)).toEqual({ kind: 'take', base: 'h1' }); // edited there
    expect(decide(f('h0'), f(null), 'h0', ids)).toEqual({ kind: 'take', base: null }); // deleted there
  });
  it('keeps a local change the partner has not seen', () => {
    expect(decide(f('h1'), f('h0'), 'h0', ids)).toEqual({ kind: 'keep' });
    expect(decide(f(null), f('h0'), 'h0', ids)).toEqual({ kind: 'keep' }); // the partner deletes it on its pull
  });
  it('a change beats a delete, from either side', () => {
    expect(decide(f(null), f('h2'), 'h0', ids)).toEqual({ kind: 'take', base: 'h2' });
    expect(decide(f('h1'), f(null), 'h0', ids)).toEqual({ kind: 'keep' });
  });
  it('two changes: the newer wins, ties go to the larger device id, and only the loser acts', () => {
    expect(decide(f('h1', 100), f('h2', 200), 'h0', ids)).toEqual({ kind: 'conflict-take', base: 'h2' });
    expect(decide(f('h1', 300), f('h2', 200), 'h0', ids)).toEqual({ kind: 'keep' });
    expect(decide(f('h1', 100), f('h2', 100), null, ids)).toEqual({ kind: 'conflict-take', base: 'h2' });
    expect(decide(f('h1', 100), f('h2', 100), null, { local: 'bb', remote: 'aa' })).toEqual({ kind: 'keep' });
  });
  it('names conflict copies after the device and the time', () => {
    const at = new Date(2026, 9, 24, 9, 5);
    expect(conflictName('photo.jpg', 'Phone', at)).toBe('photo (conflict from Phone 2026-10-24 09-05).jpg');
    expect(conflictName('README', 'a/b', at)).toBe('README (conflict from a_b 2026-10-24 09-05)');
  });
});

describe('sync ignore', () => {
  it('skips our work areas, lock and temp files', () => {
    for (const p of ['.meshdrop-trash/x', 'a/.meshdrop-partial/y', 'f.part', '~$doc.docx', 'd/.~lock.a.odt#', '.DS_Store', 'x/Thumbs.db']) expect(ignored(p)).toBe(true);
    for (const p of ['photo.jpg', 'docs/report.pdf', 'part.txt', 'docs/Deleted/x.txt', 'Deleted stuff/a']) expect(ignored(p)).toBe(false);
    for (const p of ['Deleted', 'Deleted/a.txt', 'Deleted/docs/b']) expect(ignored(p)).toBe(true); // the top-level Deleted folder
  });
});
