import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, chunkCount } from '../src/chunk.ts';
import { loadOrCreateIdentity } from '../src/identity.ts';
import { serverTlsOptions } from '../src/tls.ts';
import { multiSend } from '../src/transfer/multisend.ts';
import { DEFAULT_RETRY_DELAYS_MS, Outbox, buildManifest, prepareItems, sendTo } from '../src/transfer/send.ts';
import { cleanupEngines, makeEngines, progressOf, tmpDir, writesOf } from './engines.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const FAST = [5, 5, 5];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  cleanupEngines();
});

describe('buildManifest', () => {
  it('walks dirs with / paths, records empty dirs, skips symlinks, hashes plaintext, keeps text', async () => {
    const src = tmpDir();
    const root = join(src, 'album');
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'a.txt'), 'alpha');
    writeFileSync(join(root, 'sub', 'deep', 'b.bin'), Buffer.alloc(3, 7));
    writeFileSync(join(root, 'zero'), '');
    symlinkSync(join(root, 'a.txt'), join(root, 'link-to-file'));
    symlinkSync(join(root, 'sub'), join(root, 'link-to-dir'));
    const single = join(src, 'single.json');
    writeFileSync(single, '{}');

    const from = 'a'.repeat(64);
    const to = 'b'.repeat(64);
    const { manifest, sources } = await buildManifest(
      [{ kind: 'dir', srcPath: root }, { kind: 'file', srcPath: single }, { kind: 'text', text: 'hi there' }],
      from,
      to,
    );
    expect(manifest.from).toBe(from);
    expect(manifest.to).toBe(to);
    expect(manifest.text).toBe('hi there');
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['album/a.txt', 'album/sub/deep/b.bin', 'album/zero', 'single.json']);
    expect(byPath['album/a.txt']!.sha256).toBe(sha(Buffer.from('alpha')));
    expect(byPath['album/zero']!.size).toBe(0);
    expect(chunkCount(byPath['album/zero']!.size)).toBe(0);
    expect(byPath['single.json']!.mime).toBe('application/json');
    expect(manifest.dirs).toEqual([{ path: 'album/empty' }]);
    expect(new Set(manifest.files.map((f) => f.fileId)).size).toBe(manifest.files.length);
    for (const f of manifest.files) expect(sources.get(f.fileId)).toBeTypeOf('string');
    expect(sources.get(byPath['single.json']!.fileId)).toBe(single);
  });

  it('an empty top-level dir becomes a dirs entry', async () => {
    const d = join(tmpDir(), 'nothing');
    mkdirSync(d);
    const { manifest } = await buildManifest([{ kind: 'dir', srcPath: d }], 'a'.repeat(64), 'b'.repeat(64));
    expect(manifest.files).toEqual([]);
    expect(manifest.dirs).toEqual([{ path: 'nothing' }]);
  });
});

describe('aborting while the items are hashed', () => {
  /** A sparse file big enough that hashing it takes far longer than the test waits. */
  function hugeSparse(): string {
    const f = join(tmpDir(), 'huge.bin');
    const fd = openSync(f, 'w');
    ftruncateSync(fd, 16 * 1024 * 1024 * 1024);
    closeSync(fd);
    return f;
  }

  it('prepareItems stops at once when the signal aborts mid-hash', async () => {
    const f = hugeSparse();
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 50);
    await expect(prepareItems([{ kind: 'file', srcPath: f }], ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('sendTo and multiSend report cancelled (nothing posted, no outbox entry) when aborted while hashing', async () => {
    const [a, b, c] = await makeEngines(3);
    const f = hugeSparse();
    const outbox = new Outbox(a!.outboxDir);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: f }], { outbox, signal: ac.signal });
    expect(r).toEqual({ deviceId: b!.id.deviceId, status: 'cancelled', sessionId: '' });
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 50);
    const rs = await multiSend(a!.id, [b!.target(), c!.target()], [{ kind: 'file', srcPath: f }], { outbox, signal: ac2.signal });
    expect(rs.map((x) => x.status)).toEqual(['cancelled', 'cancelled']);
    expect(b!.events).toEqual([]);
    expect(c!.events).toEqual([]);
    expect(existsSync(a!.outboxDir) ? readdirSync(a!.outboxDir) : []).toEqual([]);
  });
});

describe('local path precheck', () => {
  it('a path the receiver would refuse fails locally with local-path, before any request', async () => {
    const [a, b] = await makeEngines(2);
    let deep = join(tmpDir(), 'root');
    const top = deep;
    for (let i = 0; i < 33; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'f.txt'), 'x');
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'dir', srcPath: top }]);
    expect(r).toMatchObject({ status: 'failed', error: 'local-path' });
    expect(b!.events.length).toBe(0);
  });
});

describe('sendTo', () => {
  it('exact multiple: an 8 MiB file sends exactly 2 chunk PUTs', async () => {
    const [a, b] = await makeEngines(2);
    const data = randomBytes(2 * CHUNK_SIZE);
    const file = join(tmpDir(), 'eight.bin');
    writeFileSync(file, data);
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }]);
    expect(r).toMatchObject({ deviceId: b!.id.deviceId, status: 'done' });
    const prog = progressOf(b!, r.sessionId);
    expect(prog).toHaveLength(2);
    expect(prog.at(-1)).toMatchObject({ chunks: 2, total: 2 });
    expect(sha(readFileSync(join(b!.inboxRoot, 'eight.bin')))).toBe(sha(data));
  });

  it('boundary sizes: 0 B -> 0 PUTs, 4 MiB -> 1, 4 MiB + 1 -> 2; all arrive intact', async () => {
    const [a, b] = await makeEngines(2);
    const dir = tmpDir();
    const sizes = { 'zero.bin': 0, 'one.bin': CHUNK_SIZE, 'two.bin': CHUNK_SIZE + 1 };
    const datas: Record<string, Buffer> = {};
    for (const [name, size] of Object.entries(sizes)) writeFileSync(join(dir, name), (datas[name] = randomBytes(size)));
    const progress: { fileId: number; sent: number; total: number }[] = [];
    const r = await sendTo(a!.id, b!.target(), Object.keys(sizes).map((n) => ({ kind: 'file' as const, srcPath: join(dir, n) })), {
      onProgress: (p) => progress.push(p),
    });
    expect(r.status).toBe('done');
    const prog = progressOf(b!, r.sessionId);
    const perFile = (fid: number) => prog.filter((p) => p.fileId === fid).length;
    expect([perFile(0), perFile(1), perFile(2)]).toEqual([0, 1, 2]);
    for (const name of Object.keys(sizes)) expect(sha(readFileSync(join(b!.inboxRoot, name)))).toBe(sha(datas[name]!));
    // sender progress ends at sent === total for every file, including the empty one
    for (const fid of [0, 1, 2]) {
      const last = progress.filter((p) => p.fileId === fid).at(-1);
      expect(last && last.sent === last.total).toBe(true);
    }
  });

  it('retries a transient 507 and succeeds', async () => {
    let failures = 1;
    const flaky = {
      ...fsp,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        if (String(args[0]).endsWith('.part') && failures > 0) {
          failures--;
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return fsp.open(...args);
      }) as typeof fsp.open,
    } as typeof fsp;
    const [a, b] = await makeEngines(2, { fs: flaky });
    const file = join(tmpDir(), 'x.bin');
    writeFileSync(file, randomBytes(1000));
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { retryDelaysMs: FAST });
    expect(r.status).toBe('done');
    expect(b!.events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('default retry delays are 0.5 s, 1 s, 2 s', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([500, 1000, 2000]);
  });

  describe('against a fake receiver', () => {
    /** HTTPS server presenting a throwaway identity; `reply` picks the status and JSON body per request. */
    async function fakeWith(reply: (method: string, url: string) => [number, string]) {
      const fid = await loadOrCreateIdentity(tmpDir());
      const seen: string[] = [];
      const server = createServer(serverTlsOptions(fid), (req, res) => {
        seen.push(`${req.method} ${req.url}`);
        req.resume();
        req.on('end', () => {
          const [status, body] = reply(req.method ?? '', req.url ?? '');
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      closers.push(() => {
        server.closeAllConnections();
        server.close();
      });
      const target = { deviceId: fid.deviceId, host: '127.0.0.1', port: (server.address() as { port: number }).port, publicKey: fid.publicKey };
      return { target, seen, hits: () => seen.length };
    }
    const fake = (status: number, body = JSON.stringify({ error: 'nope' })) => fakeWith(() => [status, body]);

    it('422 integrity from complete is terminal source-changed (not retried)', async () => {
      const [a] = await makeEngines(1);
      const f = await fakeWith((_method, url) => {
        if (url.endsWith('/offer')) return [200, JSON.stringify({ have: {} })];
        if (url.includes('/chunk/')) return [204, ''];
        if (url.includes('/complete/')) return [422, JSON.stringify({ error: 'integrity' })];
        return [500, '{}'];
      });
      const file = join(tmpDir(), 'x.bin');
      writeFileSync(file, 'x');
      const r = await sendTo(a!.id, f.target, [{ kind: 'file', srcPath: file }], { retryDelaysMs: FAST });
      expect(r).toMatchObject({ status: 'failed', error: 'source-changed' });
      // terminal: the receiver is told once to drop the session
      expect(f.seen.map((x) => x.split(' ')[1]!.split('/')[3])).toEqual(['offer', 'chunk', 'complete', 'cancel']);
      expect(f.seen.at(-1)).toBe(`POST /mesh/v1/cancel/${r.sessionId}`);
    });

    it('5xx is retried 3 times, then the session fails and the outbox entry is kept', async () => {
      const [a] = await makeEngines(1);
      const f = await fake(503);
      const file = join(tmpDir(), 'x.bin');
      writeFileSync(file, 'x');
      const outbox = new Outbox(a!.outboxDir);
      const r = await sendTo(a!.id, f.target, [{ kind: 'file', srcPath: file }], { retryDelaysMs: FAST, outbox });
      expect(r.status).toBe('failed');
      expect(r.error).toBe('http-503 nope');
      expect(f.hits()).toBe(4);
      expect(f.seen.filter((x) => x.includes('/cancel/'))).toEqual([]); // transient: stays resumable
      expect(existsSync(join(a!.outboxDir, `${r.sessionId}.json`))).toBe(true);
    });

    it('a 2xx reply with invalid JSON is a protocol error and is not retried', async () => {
      const [a] = await makeEngines(1);
      const f = await fake(200, '{not json');
      const file = join(tmpDir(), 'x.bin');
      writeFileSync(file, 'x');
      const r = await sendTo(a!.id, f.target, [{ kind: 'file', srcPath: file }], { retryDelaysMs: FAST });
      expect(r).toMatchObject({ status: 'failed', error: 'bad-response' });
      expect(f.hits()).toBe(1);
    });

    it.each([403, 404, 409, 413, 422])('%i is not retried; one best-effort cancel is posted', async (status) => {
      const [a] = await makeEngines(1);
      const f = await fake(status);
      const file = join(tmpDir(), 'x.bin');
      writeFileSync(file, 'x');
      const r = await sendTo(a!.id, f.target, [{ kind: 'file', srcPath: file }], { retryDelaysMs: FAST });
      expect(r.status).toBe('failed');
      expect(r.error).toBe(`http-${status} nope`);
      // one offer, then exactly one cancel (its own failure is ignored)
      expect(f.seen).toEqual(['POST /mesh/v1/offer', `POST /mesh/v1/cancel/${r.sessionId}`]);
    });
  });

  it('outbox: entry is 0600 with the original offer while sending, removed on done', async () => {
    const [a, b] = await makeEngines(2);
    const file = join(tmpDir(), 'f.bin');
    writeFileSync(file, randomBytes(10));
    const outbox = new Outbox(a!.outboxDir);
    let seen: { mode: number; entry: Record<string, unknown> } | undefined;
    b!.listeners.push((e) => {
      if (e.type !== 'offer') return;
      const p = join(a!.outboxDir, `${e.sessionId}.json`);
      seen = { mode: statSync(p).mode & 0o777, entry: JSON.parse(readFileSync(p, 'utf8')) };
    });
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox });
    expect(r.status).toBe('done');
    expect(seen!.mode).toBe(0o600);
    expect(seen!.entry).toMatchObject({ sessionId: r.sessionId, offer: { sessionId: r.sessionId, from: a!.id.deviceId } });
    expect(typeof seen!.entry.ctxExport).toBe('string');
    expect(readdirSync(a!.outboxDir).filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it('abort -> cancelled (entry kept, no cancel posted); changed source -> resume fails source-changed', async () => {
    const [a, b] = await makeEngines(2);
    const file = join(tmpDir(), 'big.bin');
    writeFileSync(file, randomBytes(3 * CHUNK_SIZE));
    const outbox = new Outbox(a!.outboxDir);
    const ac = new AbortController();
    b!.listeners.push((e) => { if (e.type === 'progress') ac.abort(); });
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox, signal: ac.signal });
    expect(r.status).toBe('cancelled');
    expect(b!.events.some((e) => e.type === 'cancelled')).toBe(false);
    expect(existsSync(join(a!.outboxDir, `${r.sessionId}.json`))).toBe(true);

    const t = new Date(Date.now() + 5000);
    utimesSync(file, t, t);
    expect(existsSync(join(b!.inboxRoot, '.meshdrop-partial', r.sessionId))).toBe(true);
    const res = await new Outbox(a!.outboxDir).resumeAll(a!.id, () => b!.target());
    expect(res).toEqual([{ deviceId: b!.id.deviceId, status: 'failed', sessionId: r.sessionId, error: 'source-changed' }]);
    expect(existsSync(join(a!.outboxDir, `${r.sessionId}.json`))).toBe(true);
    // terminal failure: the receiver was told to drop its partial data
    expect(b!.events).toContainEqual({ type: 'cancelled', sessionId: r.sessionId, from: a!.id.deviceId });
    expect(existsSync(join(b!.inboxRoot, '.meshdrop-partial', r.sessionId))).toBe(false);

    // a fresh sendTo of the same (changed) items supersedes the stale entry with a new session
    const r2 = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox });
    expect(r2.status).toBe('done');
    expect(r2.sessionId).not.toBe(r.sessionId);
    expect(readdirSync(a!.outboxDir).filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it('a superseded outbox entry is cancelled on the receiver (its partial data is dropped)', async () => {
    const [a, b] = await makeEngines(2);
    const file = join(tmpDir(), 'sup.bin');
    writeFileSync(file, randomBytes(3 * CHUNK_SIZE));
    const outbox = new Outbox(a!.outboxDir);
    const ac = new AbortController();
    b!.listeners.push((e) => { if (e.type === 'progress') ac.abort(); });
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox, signal: ac.signal, concurrency: 1 });
    expect(r.status).toBe('cancelled');
    b!.listeners.length = 0;
    expect(existsSync(join(b!.inboxRoot, '.meshdrop-partial', r.sessionId))).toBe(true);
    writeFileSync(file, randomBytes(3 * CHUNK_SIZE)); // changed: the next sendTo supersedes the entry
    const r2 = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox });
    expect(r2.status).toBe('done');
    expect(r2.sessionId).not.toBe(r.sessionId);
    expect(b!.events).toContainEqual({ type: 'cancelled', sessionId: r.sessionId, from: a!.id.deviceId });
    expect(existsSync(join(b!.inboxRoot, '.meshdrop-partial', r.sessionId))).toBe(false);
  });

  describe('same-size rewrite with the mtime restored (cp -p, rsync -t, coarse timestamps)', () => {
    const T = 1_700_000_000; // whole seconds, so utimes restores mtimeMs exactly
    async function pausedAfterFirstChunk() {
      const [a, b] = await makeEngines(2);
      const file = join(tmpDir(), 'same-size.bin');
      writeFileSync(file, randomBytes(3 * CHUNK_SIZE));
      utimesSync(file, T, T);
      const mtimeMs = statSync(file).mtimeMs;
      const outbox = new Outbox(a!.outboxDir);
      const ac = new AbortController();
      b!.listeners.push((e) => { if (e.type === 'progress') ac.abort(); });
      // one chunk in flight, so exactly chunk 0 is stored when the abort lands
      const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox, signal: ac.signal, concurrency: 1 });
      expect(r.status).toBe('cancelled');
      b!.listeners.length = 0;
      expect(writesOf(b!, r.sessionId).map((w) => w.index)).toEqual([0]);
      const rewrite = (offset: number, len: number) => {
        const fd = openSync(file, 'r+');
        writeSync(fd, randomBytes(len), 0, len, offset);
        closeSync(fd);
        utimesSync(file, T, T);
        expect(statSync(file).mtimeMs).toBe(mtimeMs); // size + mtime cannot see the change
      };
      return { a: a!, b: b!, file, r, outbox, rewrite };
    }

    it('missing chunks rewritten: every resume fails source-changed before sealing anything', async () => {
      const { a, b, r, rewrite } = await pausedAfterFirstChunk();
      rewrite(CHUNK_SIZE, 2 * CHUNK_SIZE);
      const ob = new Outbox(a.outboxDir);
      for (let i = 0; i < 2; i++) {
        const res = await ob.resumeAll(a.id, () => b.target());
        expect(res).toEqual([{ deviceId: b.id.deviceId, status: 'failed', sessionId: r.sessionId, error: 'source-changed' }]);
        expect(writesOf(b, r.sessionId).map((w) => w.index)).toEqual([0]); // nothing resealed
      }
      expect(existsSync(join(a.outboxDir, `${r.sessionId}.json`))).toBe(true);
    });

    it('only an already-delivered chunk rewritten: the receiver keeps the original snapshot', async () => {
      const { a, b, file, r, rewrite } = await pausedAfterFirstChunk();
      const original = readFileSync(file);
      rewrite(0, CHUNK_SIZE);
      const res = await new Outbox(a.outboxDir).resumeAll(a.id, () => b.target());
      expect(res).toEqual([{ deviceId: b.id.deviceId, status: 'done', sessionId: r.sessionId }]);
      // chunks 1 and 2 go up concurrently (any order); chunk 0 is never resent
      expect(writesOf(b, r.sessionId).map((w) => w.index).sort()).toEqual([0, 1, 2]);
      expect(sha(readFileSync(join(b.inboxRoot, 'same-size.bin')))).toBe(sha(original));
    });
  });

  it('resumeAll: unresolvable targets are reported failed target-unresolved and kept', async () => {
    const [a, b] = await makeEngines(2);
    const file = join(tmpDir(), 'f.bin');
    writeFileSync(file, randomBytes(CHUNK_SIZE + 5));
    const outbox = new Outbox(a!.outboxDir);
    const ac = new AbortController();
    b!.listeners.push((e) => { if (e.type === 'offer') ac.abort(); }); // pause right after the offer
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox, signal: ac.signal });
    expect(r.status).toBe('cancelled');
    const res = await outbox.resumeAll(a!.id, async () => undefined);
    expect(res).toEqual([{ deviceId: b!.id.deviceId, status: 'failed', sessionId: r.sessionId, error: 'target-unresolved' }]);
    expect(existsSync(join(a!.outboxDir, `${r.sessionId}.json`))).toBe(true);
  });

  it('a re-offer of an already finished session (lost finish reply) is done without re-delivery', async () => {
    const [a, b] = await makeEngines(2);
    const file = join(tmpDir(), 'f.bin');
    writeFileSync(file, randomBytes(100));
    const outbox = new Outbox(a!.outboxDir);
    let saved: { name: string; body: Buffer } | undefined;
    b!.listeners.push((e) => {
      if (e.type !== 'received') return;
      const name = `${e.sessionId}.json`;
      saved = { name, body: readFileSync(join(a!.outboxDir, name)) };
    });
    const r = await sendTo(a!.id, b!.target(), [{ kind: 'file', srcPath: file }], { outbox });
    expect(r.status).toBe('done');
    writeFileSync(join(a!.outboxDir, saved!.name), saved!.body, { mode: 0o600 });
    const res = await new Outbox(a!.outboxDir).resumeAll(a!.id, () => b!.target());
    expect(res).toEqual([{ deviceId: b!.id.deviceId, status: 'done', sessionId: r.sessionId }]);
    expect(b!.events.filter((e) => e.type === 'received')).toHaveLength(1);
    expect(existsSync(join(a!.outboxDir, saved!.name))).toBe(false);
  });
});
