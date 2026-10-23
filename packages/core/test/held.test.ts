import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMeshHandler, type MeshRequest, type MeshResponse } from '../src/api/handler.ts';
import { CHUNK_SIZE, createOffer, newSessionId, sealChunk, type Manifest } from '../src/chunk.ts';
import type { HpkeContext } from '../src/crypto/hpke.ts';
import { HubClient } from '../src/hub/client.ts';
import { HeldStore } from '../src/hub/held.ts';
import { HubServer } from '../src/hub/server.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { Inbox } from '../src/inbox.ts';
import { spkiSha256 } from '../src/mesh/canonical.ts';
import { sealEnvelope, type Envelope } from '../src/mesh/envelope.ts';
import { MembershipStore } from '../src/mesh/members.ts';
import { signList, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import { loadOrCreateRootKey } from '../src/mesh/rootkey.ts';
import { serverTlsOptions } from '../src/tls.ts';

const tmps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-held-'));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rid = () => randomBytes(16).toString('base64url');

let H: Identity;
let A: Identity;
let B: Identity;
beforeAll(async () => {
  [H, A, B] = (await Promise.all([1, 2, 3].map(() => loadOrCreateIdentity(tmpDir())))) as [Identity, Identity, Identity];
});
const spkiPem = (id: Identity) => id.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const member = (id: Identity, alias: string, role: 'hub' | 'member' = 'member') =>
  ({ deviceId: id.deviceId, alias, publicKeyPem: spkiPem(id), role, addedAt: 1 });

interface Mesh { anchor: KeyObject; v1: SignedMembership; hub: HubServer; held: HeldStore; heldDir: string; port: number }
async function startMesh(heldOpts: ConstructorParameters<typeof HeldStore>[1] = {}): Promise<Mesh> {
  const rootKey = await loadOrCreateRootKey(tmpDir());
  const anchor = createPublicKey(rootKey);
  const list: MembershipList = {
    v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: 1,
    hub: { deviceId: H.deviceId, urls: [] },
    members: [member(H, 'hub', 'hub'), member(A, 'a'), member(B, 'b')],
    revoked: [],
  };
  const v1 = signList(list, rootKey);
  const home = tmpDir();
  const heldDir = join(home, 'hub', 'held');
  const held = new HeldStore(heldDir, heldOpts);
  const hub = new HubServer({ id: H, home, rootKey, members: await MembershipStore.init(home, anchor, v1), held });
  const https: Server = createServer(serverTlsOptions(H));
  hub.attach(https);
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()));
  closers.push(async () => {
    await hub.close();
    https.closeAllConnections();
    await new Promise<void>((r) => https.close(() => r()));
  });
  return { anchor, v1, hub, held, heldDir, port: (https.address() as { port: number }).port };
}

interface Dev { client: HubClient; root: string; notices: Record<string, unknown>[] }
async function device(m: Mesh, who: Identity, wrap?: (h: (r: MeshRequest) => Promise<MeshResponse>) => (r: MeshRequest) => Promise<MeshResponse>): Promise<Dev> {
  const members = await MembershipStore.init(tmpDir(), m.anchor, m.v1);
  const root = tmpDir();
  const h = createMeshHandler({ id: who, trust: members, inbox: new Inbox(root), onEvent: () => {} });
  const base = (r: MeshRequest) => h.handle(r);
  const client = new HubClient({ id: who, members, handler: wrap ? wrap(base) : base, lanAddrs: () => [], hubLan: () => ({ host: '127.0.0.1', port: m.port }), backoffMs: [50, 50] });
  const notices: Record<string, unknown>[] = [];
  client.on('held-delivered', (n) => notices.push(n));
  client.on('held-failed', (n) => notices.push(n));
  closers.push(() => client.stop());
  client.start();
  await until(() => client.state === 'online');
  return { client, root, notices };
}

/** A held session from A to B: `chunks` 4 MiB chunks of pseudo-random data. */
function session(chunks = 2) {
  const data = randomBytes(CHUNK_SIZE * chunks - 100);
  const sessionId = newSessionId();
  const man: Manifest = {
    v: 1, sessionId, from: A.deviceId, to: B.deviceId, createdAt: 1,
    files: [{ fileId: 0, path: 'held.bin', size: data.length, mime: 'application/octet-stream', sha256: sha(data) }], dirs: [],
  };
  const { offer, ctx } = createOffer(A, B.publicKey, man);
  const holdBytes = data.length + 16 * chunks + 4096;
  return { data, sessionId, offer, ctx, holdBytes, chunks };
}
type Sess = ReturnType<typeof session>;
const env = (method: string, path: string, body: Buffer = Buffer.alloc(0), holdBytes?: number): Envelope => {
  const h: Parameters<typeof sealEnvelope>[0] = { v: 1, kind: 'req', id: rid(), from: A.deviceId, to: B.deviceId, method, path };
  if (holdBytes !== undefined) h.holdBytes = holdBytes;
  return sealEnvelope(h, body, A.privateKey);
};
const chunkEnv = (s: Sess, i: number) =>
  env('PUT', `/mesh/v1/chunk/${s.sessionId}/0/${i}`, sealChunk(s.ctx as HpkeContext, s.sessionId, 0, i, s.data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)));
const json = (e: Envelope) => (e.body.length ? JSON.parse(e.body.toString()) : undefined);

async function upload(a: Dev, s: Sess, only?: number[]): Promise<Envelope[]> {
  const out: Envelope[] = [];
  out.push(await a.client.request(env('POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(s.offer)), s.holdBytes), 10_000));
  for (let i = 0; i < s.chunks; i++) if (!only || only.includes(i)) out.push(await a.client.request(chunkEnv(s, i), 10_000));
  return out;
}
async function finishUpload(a: Dev, s: Sess): Promise<Envelope[]> {
  return [
    await a.client.request(env('POST', `/mesh/v1/complete/${s.sessionId}/0`), 10_000),
    await a.client.request(env('POST', `/mesh/v1/finish/${s.sessionId}`), 10_000),
  ];
}

describe('held files', () => {
  it('stores a session for an offline target with synthetic hub replies, delivers it when the target connects', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const s = session(2);
    const replies = [...(await upload(a, s)), ...(await finishUpload(a, s))];
    for (const r of replies) expect(r.header.from).toBe(H.deviceId);
    expect(replies.map((r) => r.header.status)).toEqual([200, 204, 204, 200, 200]);
    expect(json(replies[0]!)).toEqual({ have: {}, held: true });
    expect(json(replies[4]!)).toEqual({ held: true });
    expect((await m.held.pending(B.deviceId)).map((p) => p.sessionId)).toEqual([s.sessionId]);

    const b = await device(m, B);
    await until(() => a.notices.length === 1, 10_000);
    expect(a.notices[0]).toMatchObject({ t: 'held-delivered', to: B.deviceId, sessionId: s.sessionId, files: ['held.bin'] });
    expect(sha(readFileSync(join(b.root, 'held.bin')))).toBe(sha(s.data));
    expect(await m.held.pending(B.deviceId)).toEqual([]);
    expect(existsSync(join(m.heldDir, B.deviceId, s.sessionId))).toBe(false);
  });

  it('a re-offer of a held session lists the stored chunks so only missing ones are re-sent', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const s = session(3);
    await upload(a, s, [0, 2]);
    const again = await a.client.request(env('POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(s.offer)), s.holdBytes), 10_000);
    expect(json(again)).toEqual({ have: { 0: [0, 2] }, held: true });
  });

  it('a held-delivered notice waits for an offline sender', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const s = session(1);
    await upload(a, s);
    await finishUpload(a, s);
    await a.client.stop();
    await device(m, B);
    await until(() => readdirSync(m.heldDir).includes('.notices'), 10_000);
    const a2 = await device(m, A);
    await until(() => a2.notices.length === 1, 10_000);
    expect(a2.notices[0]).toMatchObject({ t: 'held-delivered', sessionId: s.sessionId });
  });

  it('a terminal 4xx on replay sends held-failed and deletes the session', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const s = session(1);
    await upload(a, s);
    await finishUpload(a, s);
    await device(m, B, (h) => async (r) =>
      r.path.startsWith('/mesh/v1/chunk/') ? { status: 422, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"decrypt"}') } : h(r));
    await until(() => a.notices.length === 1, 10_000);
    expect(a.notices[0]).toMatchObject({ t: 'held-failed', to: B.deviceId, sessionId: s.sessionId, status: 422, error: 'decrypt' });
    expect(await m.held.pending(B.deviceId)).toEqual([]);
  });

  it('the target disconnecting mid-replay keeps the session for the next connect', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const s = session(2);
    await upload(a, s);
    await finishUpload(a, s);
    let stall = true;
    const b1 = await device(m, B, (h) => async (r) => {
      if (stall && r.path.startsWith('/mesh/v1/chunk/')) await new Promise(() => {}); // hangs forever
      return h(r);
    });
    await sleep(300);
    await b1.client.stop();
    stall = false;
    expect((await m.held.pending(B.deviceId)).length).toBe(1);
    const b2 = await device(m, B);
    await until(() => a.notices.length === 1, 10_000);
    expect(a.notices[0]).toMatchObject({ t: 'held-delivered' });
    expect(sha(readFileSync(join(b2.root, 'held.bin')))).toBe(sha(s.data));
  });
});

describe('HeldStore limits (Review Focus #4)', () => {
  it('holdBytes over the quota is 507 hub-quota and stores nothing', async () => {
    const m = await startMesh({ quotaBytes: 1024 });
    const a = await device(m, A);
    const s = session(1);
    const r = await a.client.request(env('POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(s.offer)), s.holdBytes), 10_000);
    expect(r.header.status).toBe(507);
    expect(json(r)).toEqual({ error: 'hub-quota' });
    expect(existsSync(join(m.heldDir, B.deviceId, s.sessionId))).toBe(false);
  });

  it('a chunk beyond the declared holdBytes is 507 hub-quota and the session is removed', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const s = session(2);
    const small = { ...s, holdBytes: 1000 };
    await a.client.request(env('POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(s.offer)), small.holdBytes), 10_000);
    const r = await a.client.request(chunkEnv(s, 0), 10_000);
    expect(r.header.status).toBe(507);
    expect(json(r)).toEqual({ error: 'hub-quota' });
    expect(existsSync(join(m.heldDir, B.deviceId, s.sessionId))).toBe(false);
  });

  it('ENOSPC while writing is 507 hub-no-space and the session directory is removed', async () => {
    const failing = {
      ...fsp,
      open: (async (p: Parameters<typeof fsp.open>[0], ...rest: unknown[]) => {
        if (String(p).includes('c-0-1')) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        return (fsp.open as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fsp.open,
    };
    const m = await startMesh({ fs: failing });
    const a = await device(m, A);
    const s = session(2);
    const [, c0, c1] = await upload(a, s);
    expect(c0!.header.status).toBe(204);
    expect(c1!.header.status).toBe(507);
    expect(json(c1!)).toEqual({ error: 'hub-no-space' });
    expect(existsSync(join(m.heldDir, B.deviceId, s.sessionId))).toBe(false);
  });

  it('prune() deletes sessions older than the TTL by the hub clock', async () => {
    let t = 1_000_000;
    const dir = tmpDir();
    const store = new HeldStore(dir, { now: () => t });
    const s = session(1);
    const r = await store.put(env('POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(s.offer)), s.holdBytes));
    expect(r.status).toBe(200);
    expect(await store.prune()).toBe(0);
    t += 7 * 24 * 3600 * 1000 + 1;
    expect(await store.prune()).toBe(1);
    expect(existsSync(join(dir, B.deviceId, s.sessionId))).toBe(false);
  });
});
