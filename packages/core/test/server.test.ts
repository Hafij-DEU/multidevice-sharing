import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  createOffer,
  exportCtx,
  newSessionId,
  sealChunk,
  type Manifest,
  type Offer,
} from '../src/chunk.ts';
import type { HpkeContext } from '../src/crypto/hpke.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { Inbox } from '../src/inbox.ts';
import { createMeshServer, type ReceiverEvent } from '../src/api/server.ts';
import { connectPinned, pinnedRequest } from '../src/tls.ts';
import { TrustStore } from '../src/trust.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmps: string[] = [];
const closers: (() => void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-server-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

let A: Identity; // receiver
let B: Identity; // trusted sender
let C: Identity; // untrusted
let D: Identity; // trusted, but not a session owner
beforeAll(async () => {
  [A, B, C, D] = await Promise.all([1, 2, 3, 4].map(() => loadOrCreateIdentity(tmpDir()))) as [Identity, Identity, Identity, Identity];
});

interface Harness {
  server: Server;
  port: number;
  inbox: Inbox;
  root: string;
  events: ReceiverEvent[];
  trust: TrustStore;
}

async function startServer(opts: { inbox?: Inbox; root?: string; trust?: TrustStore; fs?: typeof fsp } = {}): Promise<Harness> {
  const root = opts.root ?? tmpDir();
  const trust = opts.trust ?? new TrustStore(join(tmpDir(), 'trust.json'));
  if (!opts.trust) {
    for (const [id, alias] of [[B, 'b'], [D, 'd']] as const) {
      trust.add({
        deviceId: id.deviceId,
        alias,
        publicKeyPem: id.publicKey.export({ type: 'spki', format: 'pem' }) as string,
        addedAt: 1,
      });
    }
  }
  const inbox = opts.inbox ?? new Inbox(root, opts.fs ? { fs: opts.fs } : {});
  const events: ReceiverEvent[] = [];
  const server = createMeshServer({ id: A, trust, inbox, onEvent: (e) => events.push(e) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, port: (server.address() as { port: number }).port, inbox, root, events, trust };
}

async function call(
  h: Harness,
  id: Identity,
  method: string,
  path: string,
  body?: Buffer | Readable | object,
  headers: Record<string, string | number> = {},
) {
  const sock = await connectPinned('127.0.0.1', h.port, id, A.deviceId);
  let payload: Buffer | Readable | undefined;
  const hdr = { ...headers };
  if (body !== undefined && !Buffer.isBuffer(body) && !(body instanceof Readable)) {
    payload = Buffer.from(JSON.stringify(body));
    hdr['content-type'] = 'application/json';
  } else {
    payload = body as Buffer | Readable | undefined;
  }
  return pinnedRequest(sock, method, `/mesh/v1/${path}`, payload, hdr);
}

function mk(sid: string, files: { path: string; data: Buffer }[], extra: Partial<Manifest> = {}): Manifest {
  return {
    v: 1, sessionId: sid, from: B.deviceId, to: A.deviceId, createdAt: 1,
    files: files.map((f, i) => ({ fileId: i, path: f.path, size: f.data.length, mime: 'application/octet-stream', sha256: sha(f.data) })),
    dirs: [],
    ...extra,
  };
}

function mkOffer(m: Manifest, sender: Identity = B): { offer: Offer; ctx: HpkeContext } {
  return createOffer(sender, A.publicKey, m);
}

const putChunk = (h: Harness, sid: string, fileId: number, index: number, ct: Buffer, id: Identity = B) =>
  call(h, id, 'PUT', `chunk/${sid}/${fileId}/${index}`, ct);

describe('receiver API', () => {
  it('info is open to anyone; every other route is 403 untrusted for an untrusted peer', async () => {
    const h = await startServer();
    const info = await call(h, C, 'GET', 'info');
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({ v: 1, deviceId: A.deviceId });
    expect(typeof (info.json as { alias: unknown }).alias).toBe('string');
    expect(typeof (info.json as { deviceType: unknown }).deviceType).toBe('string');

    const sid = newSessionId();
    const { offer } = mkOffer(mk(sid, [{ path: 'x', data: Buffer.from('x') }]));
    const routes: [string, string, Buffer | object | undefined][] = [
      ['POST', 'offer', offer],
      ['PUT', `chunk/${sid}/0/0`, Buffer.alloc(17)],
      ['POST', `complete/${sid}/0`, undefined],
      ['POST', `finish/${sid}`, undefined],
      ['POST', `cancel/${sid}`, undefined],
      ['GET', 'nonsense', undefined],
    ];
    for (const [m, p, b] of routes) {
      const r = await call(h, C, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json).toEqual({ error: 'untrusted' });
    }
    expect(h.events).toEqual([]);
  });

  it('full upload: offer, 2 chunks, complete, finish -> byte-equal file, ordered events', async () => {
    const h = await startServer();
    const data = randomBytes(CHUNK_SIZE + 1234);
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'sub/big.bin', data }]));

    const o = await call(h, B, 'POST', 'offer', offer);
    expect(o.status).toBe(200);
    expect(o.json).toEqual({ have: {} });

    for (const i of [0, 1]) {
      const pt = data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const r = await putChunk(h, sid, 0, i, sealChunk(ctx, sid, 0, i, pt));
      expect(r.status).toBe(204);
    }
    const c = await call(h, B, 'POST', `complete/${sid}/0`);
    expect(c.status).toBe(200);
    // the wire carries inbox-relative paths ('/'-separated); local events carry absolute ones
    const path = (c.json as { path: string }).path;
    expect(path).toBe('sub/big.bin');
    const abs = join(h.root, 'sub/big.bin');
    expect(readFileSync(abs).equals(data)).toBe(true);

    const f = await call(h, B, 'POST', `finish/${sid}`);
    expect(f.status).toBe(200);
    expect(h.events.map((e) => e.type)).toEqual(['offer', 'progress', 'progress', 'file', 'received']);
    expect(h.events[1]).toMatchObject({ type: 'progress', sessionId: sid, from: B.deviceId, fileId: 0, chunks: 1, total: 2 });
    expect(h.events[2]).toMatchObject({ type: 'progress', fileId: 0, chunks: 2, total: 2 });
    expect(f.json).toEqual({ files: ['sub/big.bin'] });
    expect(h.events[3]).toMatchObject({ type: 'file', fileId: 0, path: abs });
    expect(h.events[4]).toMatchObject({ type: 'received', sessionId: sid, from: B.deviceId, files: [abs] });
    // the tombstone records relative paths too
    const tomb = JSON.parse(readFileSync(join(h.root, '.meshdrop-partial', '.finished', `${sid}.json`), 'utf8'));
    expect(tomb.files).toEqual(['sub/big.bin']);
    // partial state is gone after finish
    expect(existsSync(join(h.root, '.meshdrop-partial', sid))).toBe(false);
    // retried finish (lost 200): same files, no second 'received'
    const again = await call(h, B, 'POST', `finish/${sid}`);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ files: [path] });
    expect(h.events.filter((e) => e.type === 'received')).toHaveLength(1);
    // only the owner may ask
    expect((await call(h, D, 'POST', `finish/${sid}`)).status).toBe(403);
  });

  it('resume via re-offer returns the have map; conflicting re-offer is 409 and wipes nothing', async () => {
    const h = await startServer();
    const data = randomBytes(CHUNK_SIZE + 10);
    const sid = newSessionId();
    const m = mk(sid, [{ path: 'r.bin', data }]);
    const { offer, ctx } = mkOffer(m);
    expect((await call(h, B, 'POST', 'offer', offer)).status).toBe(200);
    expect((await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data.subarray(0, CHUNK_SIZE)))).status).toBe(204);

    const again = await call(h, B, 'POST', 'offer', offer);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ have: { 0: [0] } });
    expect(h.events.filter((e) => e.type === 'offer')).toHaveLength(1);

    // same session id, fresh HPKE context (different enc): refused, state intact
    const other = mkOffer(m).offer;
    const conflict = await call(h, B, 'POST', 'offer', other);
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({ error: 'session-conflict' });
    expect(await h.inbox.have(sid)).toEqual({ 0: [0] });
    expect((await call(h, B, 'POST', 'offer', offer)).json).toEqual({ have: { 0: [0] } });
  });

  it('survives a server restart: ctx is re-imported from the inbox', async () => {
    const h = await startServer();
    const data = randomBytes(CHUNK_SIZE + 10);
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'rs.bin', data }]));
    await call(h, B, 'POST', 'offer', offer);
    await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data.subarray(0, CHUNK_SIZE)));

    const h2 = await startServer({ root: h.root, trust: h.trust });
    expect((await call(h2, B, 'POST', 'offer', offer)).json).toEqual({ have: { 0: [0] } });
    expect((await putChunk(h2, sid, 0, 1, sealChunk(ctx, sid, 0, 1, data.subarray(CHUNK_SIZE)))).status).toBe(204);
    // the first server has no stale cache problem: finish on the second one works
    expect((await call(h2, B, 'POST', `complete/${sid}/0`)).status).toBe(200);
    expect((await call(h2, B, 'POST', `finish/${sid}`)).status).toBe(200);
    expect(readFileSync(join(h.root, 'rs.bin')).equals(data)).toBe(true);
  });

  it('finish after a restart still knows which files were completed (persisted by the inbox)', async () => {
    const h = await startServer();
    const data = Buffer.from('persisted');
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'p.txt', data }], { text: 't' }));
    await call(h, B, 'POST', 'offer', offer);
    await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data));
    const path = ((await call(h, B, 'POST', `complete/${sid}/0`)).json as { path: string }).path;

    expect(path).toBe('p.txt');
    const h2 = await startServer({ root: h.root, trust: h.trust });
    const fin = await call(h2, B, 'POST', `finish/${sid}`);
    expect(fin.status).toBe(200);
    expect(fin.json).toEqual({ files: ['p.txt'] });
    expect(h2.events).toEqual([expect.objectContaining({ type: 'received', files: [join(h.root, 'p.txt')], text: 't' })]);
  });

  it('re-offer after finish is done:true, creates no session or files; tombstone survives restart', async () => {
    const h = await startServer();
    const data = Buffer.from('delivered once');
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'once.txt', data }]));
    await call(h, B, 'POST', 'offer', offer);
    await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data));
    const path = ((await call(h, B, 'POST', `complete/${sid}/0`)).json as { path: string }).path;
    expect((await call(h, B, 'POST', `finish/${sid}`)).status).toBe(200);

    for (const hh of [h, await startServer({ root: h.root, trust: h.trust })]) {
      const before = hh.events.length;
      const r = await call(hh, B, 'POST', 'offer', offer);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ done: true, files: [path] });
      expect(await hh.inbox.load(sid)).toBeNull();
      expect(existsSync(join(h.root, '.meshdrop-partial', sid))).toBe(false);
      expect(readdirSync(h.root).filter((x) => !x.startsWith('.'))).toEqual(['once.txt']);
      const fin = await call(hh, B, 'POST', `finish/${sid}`);
      expect(fin.json).toEqual({ files: [path] });
      expect(hh.events.length).toBe(before);
      // an uploaded chunk for a delivered session is still an unknown session
      expect((await putChunk(hh, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data))).status).toBe(404);
    }
    // another peer cannot learn the file list
    const evilOffer = mkOffer({ ...mk(sid, [{ path: 'once.txt', data }]), from: D.deviceId }, D).offer;
    expect((await call(h, D, 'POST', 'offer', evilOffer)).status).toBe(403);
  });

  it('bad chunk: tampered ciphertext is 422 decrypt and is not recorded', async () => {
    const h = await startServer();
    const data = Buffer.from('some small file');
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 's.txt', data }]));
    await call(h, B, 'POST', 'offer', offer);
    const ct = sealChunk(ctx, sid, 0, 0, data);
    ct[3]! ^= 0xff;
    const r = await putChunk(h, sid, 0, 0, ct);
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: 'decrypt' });
    expect(await h.inbox.have(sid)).toEqual({});
    expect(h.events.map((e) => e.type)).toEqual(['offer']);
    // a chunk sealed for another position also fails (AAD binding)
    expect((await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 1, 0, data))).status).toBe(422);
  });

  it('oversize chunk is 413 (Content-Length and streamed without length)', async () => {
    const h = await startServer();
    const data = Buffer.from('x');
    const sid = newSessionId();
    const { offer } = mkOffer(mk(sid, [{ path: 'o.txt', data }]));
    await call(h, B, 'POST', 'offer', offer);
    const big = Buffer.alloc(CHUNK_SIZE + 17);
    const r = await putChunk(h, sid, 0, 0, big);
    expect(r.status).toBe(413);

    // exactly the cap is read (and then fails to decrypt, not 413)
    expect((await putChunk(h, sid, 0, 0, Buffer.alloc(CHUNK_SIZE + 16))).status).toBe(422);

    // chunked upload with no Content-Length: the server must cut it off while streaming
    const streamed = await call(h, B, 'PUT', `chunk/${sid}/0/0`, Readable.from([big.subarray(0, CHUNK_SIZE), big.subarray(CHUNK_SIZE)]))
      .then((x) => x.status, () => 'reset');
    expect([413, 'reset']).toContain(streamed);
    expect(await h.inbox.have(sid)).toEqual({});
  });

  it('ENOSPC propagates as 507 + error event, partial file kept', async () => {
    const root = tmpDir();
    let partWrites = 0;
    const failing = {
      ...fsp,
      open: async (path: string, ...rest: unknown[]) => {
        const h = await (fsp.open as (...a: unknown[]) => Promise<fsp.FileHandle>)(path, ...rest);
        if (String(path).endsWith('.part')) {
          const w = h.write.bind(h) as (...a: unknown[]) => Promise<unknown>;
          (h as unknown as { write: unknown }).write = async (...a: unknown[]) => {
            if (++partWrites === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            return w(...a);
          };
        }
        return h;
      },
    } as unknown as typeof fsp;
    const h = await startServer({ root, fs: failing });
    const data = randomBytes(2 * CHUNK_SIZE);
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'full.bin', data }]));
    await call(h, B, 'POST', 'offer', offer);
    expect((await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data.subarray(0, CHUNK_SIZE)))).status).toBe(204);
    const r = await putChunk(h, sid, 0, 1, sealChunk(ctx, sid, 0, 1, data.subarray(CHUNK_SIZE)));
    expect(r.status).toBe(507);
    expect(h.events.at(-1)).toMatchObject({ type: 'error', sessionId: sid, from: B.deviceId, code: 'ENOSPC' });
    expect(await h.inbox.have(sid)).toEqual({ 0: [0] });
    expect(existsSync(join(root, '.meshdrop-partial', sid, '0.part'))).toBe(true);
  });

  it('text only: received carries the text', async () => {
    const h = await startServer();
    const sid = newSessionId();
    const { offer } = mkOffer(mk(sid, [], { text: 'hello from b' }));
    expect((await call(h, B, 'POST', 'offer', offer)).status).toBe(200);
    expect((await call(h, B, 'POST', `finish/${sid}`)).status).toBe(200);
    expect(h.events.map((e) => e.type)).toEqual(['offer', 'received']);
    expect(h.events[1]).toMatchObject({ type: 'received', sessionId: sid, from: B.deviceId, files: [], text: 'hello from b' });
  });

  it('finish before every file is completed is 409 incomplete and keeps the session', async () => {
    const h = await startServer();
    const data = Buffer.from('abc');
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'f.txt', data }], { dirs: [{ path: 'emptydir' }] }));
    await call(h, B, 'POST', 'offer', offer);
    // no chunks at all
    let r = await call(h, B, 'POST', `finish/${sid}`);
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'incomplete' });
    // all chunks stored but file not completed yet: still incomplete
    await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data));
    r = await call(h, B, 'POST', `finish/${sid}`);
    expect(r.status).toBe(409);
    expect(existsSync(join(h.root, 'emptydir'))).toBe(false);
    // complete -> finish ok, dirs created
    expect((await call(h, B, 'POST', `complete/${sid}/0`)).status).toBe(200);
    expect((await call(h, B, 'POST', `finish/${sid}`)).status).toBe(200);
    expect(existsSync(join(h.root, 'emptydir'))).toBe(true);
    expect(readdirSync(h.root).filter((x) => !x.startsWith('.')).sort()).toEqual(['emptydir', 'f.txt']);
  });

  it('complete: sha mismatch is 422 integrity; missing chunks is 409', async () => {
    const h = await startServer();
    const data = Buffer.from('payload');
    const sid = newSessionId();
    const m = mk(sid, [{ path: 'w.txt', data }]);
    m.files[0]!.sha256 = sha(Buffer.from('something else'));
    const { offer, ctx } = mkOffer(m);
    await call(h, B, 'POST', 'offer', offer);
    expect((await call(h, B, 'POST', `complete/${sid}/0`)).status).toBe(409);
    await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data));
    const r = await call(h, B, 'POST', `complete/${sid}/0`);
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: 'integrity' });
    expect(existsSync(join(h.root, 'w.txt'))).toBe(false);
  });

  it('404 unknown session, 409 out-of-range index / unknown file, 400 malformed ids', async () => {
    const h = await startServer();
    const sid = newSessionId();
    expect((await putChunk(h, sid, 0, 0, Buffer.alloc(20))).status).toBe(404);
    expect((await call(h, B, 'POST', `complete/${sid}/0`)).status).toBe(404);
    expect((await call(h, B, 'POST', `finish/${sid}`)).status).toBe(404);
    expect((await putChunk(h, 'short', 0, 0, Buffer.alloc(20))).status).toBe(404);

    const data = Buffer.from('abc');
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'a.txt', data }]));
    await call(h, B, 'POST', 'offer', offer);
    const ct = sealChunk(ctx, sid, 0, 1, data);
    expect((await putChunk(h, sid, 0, 1, ct)).status).toBe(409);
    expect((await putChunk(h, sid, 7, 0, ct)).status).toBe(409);
    expect((await putChunk(h, sid, 0, 4294967296, ct)).status).toBe(409);
    expect((await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, Buffer.from('toolong!')))).status).toBe(409);
    expect((await call(h, B, 'PUT', `chunk/${sid}/x/0`, ct)).status).toBe(400);
    expect((await call(h, B, 'PUT', `chunk/${sid}/0/-1`, ct)).status).toBe(400);
  });

  it('offer validation: malformed JSON 400, from mismatch 403, bad manifest 422, session owner enforced', async () => {
    const h = await startServer();
    const bad = await call(h, B, 'POST', 'offer', Buffer.from('{not json'));
    expect(bad.status).toBe(400);

    const sid = newSessionId();
    const data = Buffer.from('abc');
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'a.txt', data }]));
    // D replays B's offer: o.from is B, peer is D
    expect((await call(h, D, 'POST', 'offer', offer)).status).toBe(403);
    expect(h.events).toEqual([]);

    // unsafe path in an otherwise valid manifest
    const sid2 = newSessionId();
    const evil = mkOffer(mk(sid2, [{ path: '../evil.txt', data }])).offer;
    const r = await call(h, B, 'POST', 'offer', evil);
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: 'bad-offer' });
    expect(existsSync(join(h.root, '.meshdrop-partial', sid2))).toBe(false);

    // structurally invalid offer
    expect((await call(h, B, 'POST', 'offer', { v: 1, from: B.deviceId })).status).toBe(422);
    expect((await call(h, B, 'POST', 'offer', [1, 2])).status).toBe(422);

    // a different trusted peer cannot touch B's session
    await call(h, B, 'POST', 'offer', offer);
    const ct = sealChunk(ctx, sid, 0, 0, data);
    expect((await putChunk(h, sid, 0, 0, ct, D)).status).toBe(403);
    expect((await call(h, D, 'POST', `complete/${sid}/0`)).status).toBe(403);
    expect((await call(h, D, 'POST', `finish/${sid}`)).status).toBe(403);
    expect((await call(h, D, 'POST', `cancel/${sid}`)).status).toBe(403);
    expect(await h.inbox.have(sid)).toEqual({});
    expect((await putChunk(h, sid, 0, 0, ct)).status).toBe(204);
  });

  it('offer body over 64 MiB is 413', async () => {
    const h = await startServer();
    const r = await call(h, B, 'POST', 'offer', Buffer.alloc(64 * 1024 * 1024 + 1, 0x20)).then((x) => x.status, () => 'reset');
    expect([413, 'reset']).toContain(r);
  });

  it('cancel drops the session (204) and emits cancelled; unknown session is a 204 no-op', async () => {
    const h = await startServer();
    const sid = newSessionId();
    const data = Buffer.from('abc');
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'a.txt', data }]));
    await call(h, B, 'POST', 'offer', offer);
    await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data));
    expect((await call(h, B, 'POST', `cancel/${sid}`)).status).toBe(204);
    expect(h.events.at(-1)).toMatchObject({ type: 'cancelled', sessionId: sid, from: B.deviceId });
    expect(existsSync(join(h.root, '.meshdrop-partial', sid))).toBe(false);
    expect((await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data))).status).toBe(404);
    const n = h.events.length;
    expect((await call(h, B, 'POST', `cancel/${sid}`)).status).toBe(204);
    expect(h.events.length).toBe(n);
  });

  it('unexpected failures are 500 internal without leaking details', async () => {
    const root = tmpDir();
    const failing = {
      ...fsp,
      open: async (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('.part')) throw Object.assign(new Error('secret /path detail'), { code: 'EIO' });
        return (fsp.open as (...a: unknown[]) => Promise<fsp.FileHandle>)(path, ...rest);
      },
    } as unknown as typeof fsp;
    const h = await startServer({ root, fs: failing });
    const data = Buffer.from('abc');
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'a.txt', data }]));
    await call(h, B, 'POST', 'offer', offer);
    const r = await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data));
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'internal' });
    expect(r.body.toString()).not.toMatch(/secret|EIO|\//);
    expect(h.events.at(-1)).toMatchObject({ type: 'error', sessionId: sid, from: B.deviceId, code: 'EIO' });
  });

  it('EACCES on a write: generic 500, error event with the errno, partial kept, nothing under the final name', async () => {
    const root = tmpDir();
    let partWrites = 0;
    const failing = {
      ...fsp,
      open: async (path: string, ...rest: unknown[]) => {
        const h = await (fsp.open as (...a: unknown[]) => Promise<fsp.FileHandle>)(path, ...rest);
        if (String(path).endsWith('.part')) {
          const w = h.write.bind(h) as (...a: unknown[]) => Promise<unknown>;
          (h as unknown as { write: unknown }).write = async (...a: unknown[]) => {
            if (++partWrites === 2) throw Object.assign(new Error('EACCES: permission denied /secret'), { code: 'EACCES' });
            return w(...a);
          };
        }
        return h;
      },
    } as unknown as typeof fsp;
    const h = await startServer({ root, fs: failing });
    const data = randomBytes(2 * CHUNK_SIZE);
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'denied.bin', data }]));
    await call(h, B, 'POST', 'offer', offer);
    expect((await putChunk(h, sid, 0, 0, sealChunk(ctx, sid, 0, 0, data.subarray(0, CHUNK_SIZE)))).status).toBe(204);
    const r = await putChunk(h, sid, 0, 1, sealChunk(ctx, sid, 0, 1, data.subarray(CHUNK_SIZE)));
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'internal' });
    expect(h.events.at(-1)).toMatchObject({ type: 'error', sessionId: sid, from: B.deviceId, code: 'EACCES' });
    expect(await h.inbox.have(sid)).toEqual({ 0: [0] });
    expect(existsSync(join(root, '.meshdrop-partial', sid, '0.part'))).toBe(true);
    expect(existsSync(join(root, 'denied.bin'))).toBe(false);
  });

  it('a client that dies mid-handshake does not crash the server', async () => {
    const h = await startServer();
    const { connect } = await import('node:net');
    const s = connect(h.port, '127.0.0.1');
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.write(Buffer.from('\x16\x03\x01\x00\x10garbage-not-tls'));
    s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect((await call(h, B, 'GET', 'info')).status).toBe(200);
  });

  it('exportCtx is what the inbox stores (sanity for the conflict check)', async () => {
    const h = await startServer();
    const sid = newSessionId();
    const { offer, ctx } = mkOffer(mk(sid, [{ path: 'a.txt', data: Buffer.from('a') }]));
    await call(h, B, 'POST', 'offer', offer);
    expect((await h.inbox.load(sid))?.ctxExport).toBe(exportCtx(ctx));
  });
});
