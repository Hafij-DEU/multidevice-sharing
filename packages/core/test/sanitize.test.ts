import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnsafePathError, safeRelPath, uniqueName } from '../src/sanitize.ts';

describe('safeRelPath', () => {
  it('keeps normal paths and normalizes separators', () => {
    expect(safeRelPath('a/b.txt')).toBe('a/b.txt');
    expect(safeRelPath('a\\b.txt')).toBe('a/b.txt');
    expect(safeRelPath('./a//b/./c.txt')).toBe('a/b/c.txt');
  });
  it('rejects traversal, absolute, drive letters, NUL, depth', () => {
    for (const bad of ['../x', '/etc/x', '\\\\server\\share', 'C:\\x', 'c:/x', 'C:', 'a/../../b', 'a/..', 'a\u0000b']) {
      expect(() => safeRelPath(bad), bad).toThrow(UnsafePathError);
    }
    expect(() => safeRelPath(Array(33).fill('d').join('/'))).toThrow(UnsafePathError);
    expect(safeRelPath(Array(32).fill('d').join('/'))).toBe(Array(32).fill('d').join('/'));
  });
  it('replaces reserved characters and prefixes reserved Windows names', () => {
    expect(safeRelPath('CON.txt')).toBe('_CON.txt');
    expect(safeRelPath('a/lpt1.tar.gz')).toBe('a/_lpt1.tar.gz');
    expect(safeRelPath('a:b?.txt')).toBe('a_b_.txt');
    expect(safeRelPath('x<y>"z|*\u0001\u007f')).toBe('x_y__z____');
    expect(safeRelPath('console.txt')).toBe('console.txt');
  });
});

describe('safeRelPath length limits', () => {
  const bl = (s: string) => Buffer.byteLength(s, 'utf8');
  it('truncates a long segment to <= 240 bytes, keeping a short extension', () => {
    const out = safeRelPath('a/' + 'x'.repeat(300) + '.txt');
    const seg = out.split('/')[1]!;
    expect(bl(seg)).toBe(240);
    expect(seg.endsWith('.txt')).toBe(true);
    expect(seg.startsWith('x'.repeat(236))).toBe(true);
  });
  it('truncates the whole segment when the extension is long or absent', () => {
    expect(bl(safeRelPath('y'.repeat(304)))).toBe(240);
    const out = safeRelPath('z'.repeat(250) + '.' + 'e'.repeat(20));
    expect(bl(out)).toBe(240);
  });
  it('never splits multi-byte characters or surrogate pairs; lone surrogates are replaced', () => {
    for (const ch of ['\u00e9', '\u20ac', '\u{1F600}']) {
      const out = safeRelPath(ch.repeat(200) + '.jpg');
      expect(bl(out)).toBeLessThanOrEqual(240);
      expect(out.endsWith('.jpg')).toBe(true);
      expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
      expect(out).not.toContain('\ufffd');
    }
    const lone = safeRelPath('a\ud800b');
    expect(lone).toBe('a_b');
  });
  it('rejects a relative path over 3072 bytes', () => {
    const seg = 'p'.repeat(240);
    expect(() => safeRelPath(Array(13).fill(seg).join('/'))).toThrow(UnsafePathError); // 13*240+12 = 3132
    expect(safeRelPath(Array(12).fill(seg).join('/')).length).toBe(12 * 240 + 11); // 2891, fine
  });
});

describe('uniqueName', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it('follows the stem (n).ext pattern', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-uniq-'));
    dirs.push(d);
    expect(await uniqueName(d, 'photo.jpg')).toBe('photo.jpg');
    writeFileSync(join(d, 'photo.jpg'), 'x');
    expect(await uniqueName(d, 'photo.jpg')).toBe('photo (1).jpg');
    writeFileSync(join(d, 'photo (1).jpg'), 'x');
    expect(await uniqueName(d, 'photo.jpg')).toBe('photo (2).jpg');
    writeFileSync(join(d, '.bashrc'), 'x');
    expect(await uniqueName(d, '.bashrc')).toBe('.bashrc (1)');
    writeFileSync(join(d, 'a.tar.gz'), 'x');
    expect(await uniqueName(d, 'a.tar.gz')).toBe('a.tar (1).gz');
  });
});
