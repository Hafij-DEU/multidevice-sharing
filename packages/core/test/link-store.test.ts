import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LINK_CHUNK, linkChunkCount, openChunk, openManifest } from '../src/links/crypto.ts';
import { LinkError, LinkStore } from '../src/links/store.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(now = () => Date.now(), quotaBytes?: number) {
  const d = mkdtempSync(join(tmpdir(), 'md-links-'));
  tmps.push(d);
  return { d, s: new LinkStore(join(d, 'links'), { now, ...(quotaBytes ? { quotaBytes } : {}) }) };
}
async function err(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LinkError) return `${e.status} ${e.code}`;
    throw e;
  }
  return 'ok';
}
const walk = (d: string): string[] => readdirSync(d, { recursive: true, encoding: 'utf8' }).map((p) => join(d, p));

describe('LinkStore', () => {
  it('seals files so only the key opens them; no plaintext name or content in the store', async () => {
    const { d, s } = setup();
    const big = Buffer.alloc(LINK_CHUNK + 1000, 3);
    writeFileSync(join(d, 'secret-name.bin'), big);
    writeFileSync(join(d, 'empty.txt'), '');
    const { id, key } = await s.create({ files: [join(d, 'secret-name.bin'), join(d, 'empty.txt')], text: 'hi there' });
    const { session } = await s.open(id);
    const m = openManifest(key, id, await s.manifest(id, session));
    expect(m).toEqual({ v: 1, files: [{ name: 'secret-name.bin', size: big.length }, { name: 'empty.txt', size: 0 }], text: 'hi there' });
    const parts: Buffer[] = [];
    const n = linkChunkCount(big.length);
    for (let i = 0; i < n; i++) parts.push(openChunk(key, id, 0, i, i === n - 1, await s.chunk(id, session, 0, i)));
    expect(Buffer.concat(parts).equals(big)).toBe(true);
    expect(openChunk(key, id, 1, 0, true, await s.chunk(id, session, 1, 0)).length).toBe(0);
    expect(await err(s.chunk(id, session, 0, n))).toBe('404 not-found');
    expect(await err(s.chunk(id, 'nope', 0, 0))).toBe('401 session');
    for (const f of walk(join(d, 'links'))) {
      if (!f.endsWith('link.json')) continue;
      const txt = readFileSync(f, 'utf8');
      expect(txt).not.toContain('hi there');
      expect(txt).not.toContain(key.toString('base64url'));
    }
    expect(walk(join(d, 'links')).some((f) => f.includes('secret-name'))).toBe(false);
    expect(readFileSync(join(d, 'links', id, 'f0')).includes(Buffer.alloc(64, 3))).toBe(false);
  });

  it('checks the password and slows down guessing', async () => {
    const { d, s } = setup();
    writeFileSync(join(d, 'a.txt'), 'a');
    const { id } = await s.create({ files: [join(d, 'a.txt')], password: 'correct horse' });
    expect(await s.needsPassword(id)).toBe(true);
    expect(await err(s.open(id))).toBe('401 password');
    for (let i = 0; i < 5; i++) expect(await err(s.open(id, 'wrong'))).toBe('401 bad-password');
    expect(await err(s.open(id, 'correct horse'))).toBe('429 throttled');
  }, 60_000);

  it('never exceeds the download cap, even with concurrent opens', async () => {
    const { d, s } = setup();
    writeFileSync(join(d, 'a.txt'), 'a');
    const { id } = await s.create({ files: [join(d, 'a.txt')], maxDownloads: 2 });
    const r = await Promise.all(Array.from({ length: 5 }, () => err(s.open(id))));
    expect(r.filter((x) => x === 'ok')).toHaveLength(2);
    expect(r.filter((x) => x === '410 used-up')).toHaveLength(3);
    expect((await s.list())[0]).toMatchObject({ downloads: 2, maxDownloads: 2 });
  });

  it('expires, revokes, prunes, and keeps to its quota', async () => {
    let now = 1_000_000;
    const { d, s } = setup(() => now, 4096);
    writeFileSync(join(d, 'a.txt'), 'a');
    const a = await s.create({ files: [join(d, 'a.txt')], expiresInMs: 3_600_000 });
    const b = await s.create({ files: [join(d, 'a.txt')] });
    expect(await err(s.create({ files: [join(d, 'a.txt')], expiresInMs: 60_000 }))).toBe('400 bad-expiry');
    writeFileSync(join(d, 'big.bin'), Buffer.alloc(5000));
    expect(await err(s.create({ files: [join(d, 'big.bin')] }))).toBe('507 quota');
    now += 3_600_000;
    expect(await err(s.open(a.id))).toBe('410 expired');
    await s.prune();
    expect((await s.list()).map((l) => l.id)).toEqual([b.id]);
    const { session } = await s.open(b.id);
    await s.revoke(b.id);
    expect(await err(s.chunk(b.id, session, 0, 0))).toBe('401 session');
    expect(await err(s.open(b.id))).toBe('404 not-found');
  });
});
