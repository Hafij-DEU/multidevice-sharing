import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMeshHandler } from '../src/api/handler.ts';
import { createMeshServer } from '../src/api/server.ts';
import { CHUNK_SIZE } from '../src/chunk.ts';
import { HubClient } from '../src/hub/client.ts';
import { HeldStore } from '../src/hub/held.ts';
import { HubServer } from '../src/hub/server.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { Inbox } from '../src/inbox.ts';
import { spkiSha256 } from '../src/mesh/canonical.ts';
import { MembershipStore } from '../src/mesh/members.ts';
import { signList, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import { loadOrCreateRootKey } from '../src/mesh/rootkey.ts';
import { serverTlsOptions } from '../src/tls.ts';
import { LanTransport, NoRouteError, RelayTransport } from '../src/transfer/transport.ts';
import { Outbox, sendTo, type Target } from '../src/transfer/send.ts';

const tmps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-transport-'));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let H: Identity;
let A: Identity;
let B: Identity;
beforeAll(async () => {
  [H, A, B] = (await Promise.all([1, 2, 3].map(() => loadOrCreateIdentity(tmpDir())))) as [Identity, Identity, Identity];
});
const spkiPem = (id: Identity) => id.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const member = (id: Identity, alias: string, role: 'hub' | 'member' = 'member') =>
  ({ deviceId: id.deviceId, alias, publicKeyPem: spkiPem(id), role, addedAt: 1 });

interface Hub { port: number; close(): Promise<void> }
interface Mesh { anchor: KeyObject; v1: SignedMembership; rootKey: KeyObject; hubHome: string; held: HeldStore }

async function makeMesh(heldQuota?: number): Promise<Mesh> {
  const rootKey = await loadOrCreateRootKey(tmpDir());
  const anchor = createPublicKey(rootKey);
  const list: MembershipList = {
    v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: 1,
    hub: { deviceId: H.deviceId, urls: [] },
    members: [member(H, 'hub', 'hub'), member(A, 'a'), member(B, 'b')],
    revoked: [],
  };
  const hubHome = tmpDir();
  return { anchor, v1: signList(list, rootKey), rootKey, hubHome, held: new HeldStore(join(hubHome, 'held'), heldQuota !== undefined ? { quotaBytes: heldQuota } : {}) };
}

async function startHub(m: Mesh, port = 0): Promise<Hub> {
  const members = (await MembershipStore.load(m.hubHome)) ?? (await MembershipStore.init(m.hubHome, m.anchor, m.v1));
  const hub = new HubServer({ id: H, home: m.hubHome, rootKey: m.rootKey, members, held: m.held });
  const https: Server = createHttpsServer(serverTlsOptions(H));
  hub.attach(https);
  await new Promise<void>((r) => https.listen(port, '127.0.0.1', () => r()));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await hub.close();
    https.closeAllConnections();
    await new Promise<void>((r) => https.close(() => r()));
  };
  closers.push(close);
  return { port: (https.address() as { port: number }).port, close };
}

/** A device with a hub link; `serveLan` also exposes its receiver on a pinned HTTPS port. */
interface Dev { client: HubClient; members: MembershipStore; root: string; writes: { fileId: number; index: number }[]; lanPort?: number }
async function device(m: Mesh, who: Identity, hubPort: () => number, serveLan = false): Promise<Dev> {
  const members = await MembershipStore.init(tmpDir(), m.anchor, m.v1);
  const root = tmpDir();
  const inbox = new Inbox(root);
  const writes: { fileId: number; index: number }[] = [];
  const orig = inbox.writeChunk.bind(inbox);
  inbox.writeChunk = async (sid, fileId, index, pt) => {
    await orig(sid, fileId, index, pt);
    writes.push({ fileId, index });
  };
  const h = createMeshHandler({ id: who, trust: members, inbox, onEvent: () => {} });
  const client = new HubClient({ id: who, members, handler: (r) => h.handle(r), lanAddrs: () => [], hubLan: () => ({ host: '127.0.0.1', port: hubPort() }), backoffMs: [50, 50] });
  closers.push(() => client.stop());
  client.start();
  const dev: Dev = { client, members, root, writes };
  if (serveLan) {
    const srv = createMeshServer({ id: who, trust: members, inbox, onEvent: () => {} });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    closers.push(() => { srv.closeAllConnections(); srv.close(); });
    dev.lanPort = (srv.address() as { port: number }).port;
  }
  return dev;
}

const pubOf = (d: Dev) => (id: string) => {
  const t = d.members.get(id);
  return t ? createPublicKey(t.publicKeyPem) : undefined;
};
const targetB: () => Target = () => ({ deviceId: B.deviceId, publicKey: B.publicKey });
function file(chunks: number): { path: string; data: Buffer } {
  const data = randomBytes(CHUNK_SIZE * chunks - 7);
  const path = join(tmpDir(), 'big.bin');
  writeFileSync(path, data);
  return { path, data };
}
const fast = { retryDelaysMs: [10, 10], concurrency: 1 };

describe('sender transports', () => {
  it('sendTo over a RelayTransport delivers a 3-chunk file through the hub', async () => {
    const m = await makeMesh();
    const hub = await startHub(m);
    const a = await device(m, A, () => hub.port);
    const b = await device(m, B, () => hub.port);
    await until(() => a.client.state === 'online' && b.client.state === 'online');
    const f = file(3);
    const r = await sendTo(A, targetB(), [{ kind: 'file', srcPath: f.path }], {
      ...fast, transport: () => new RelayTransport(A, a.client, B.deviceId, pubOf(a), 'relay'),
    });
    expect(r.status).toBe('done');
    expect(sha(readFileSync(join(b.root, 'big.bin')))).toBe(sha(f.data));
  });

  it("held mode to an offline target ends 'held', drops the outbox entry, and delivers later", async () => {
    const m = await makeMesh();
    const hub = await startHub(m);
    const a = await device(m, A, () => hub.port);
    await until(() => a.client.state === 'online');
    const outbox = new Outbox(tmpDir());
    const f = file(2);
    const r = await sendTo(A, targetB(), [{ kind: 'file', srcPath: f.path }], {
      ...fast, outbox, transport: () => new RelayTransport(A, a.client, B.deviceId, pubOf(a), 'held', f.data.length + 4096 * 4),
    });
    expect(r.status).toBe('held');
    expect(await outbox.list()).toEqual([]);
    const b = await device(m, B, () => hub.port);
    await until(() => readdirSync(b.root).includes('big.bin'), 10_000);
    expect(sha(readFileSync(join(b.root, 'big.bin')))).toBe(sha(f.data));
  });

  it('hub restart mid-transfer: a re-run resumes, every chunk stored once, one file (Review Focus #1)', async () => {
    const m = await makeMesh();
    let hub = await startHub(m);
    const port = hub.port;
    const a = await device(m, A, () => port);
    const b = await device(m, B, () => port);
    await until(() => a.client.state === 'online' && b.client.state === 'online');
    const outbox = new Outbox(tmpDir());
    const f = file(4);
    const opts = { ...fast, outbox, transport: () => new RelayTransport(A, a.client, B.deviceId, pubOf(a), 'relay') };
    const killer = (async () => {
      await until(() => b.writes.length >= 1, 10_000);
      await hub.close();
    })();
    const first = await sendTo(A, targetB(), [{ kind: 'file', srcPath: f.path }], opts);
    await killer;
    expect(first.status).toBe('failed');
    hub = await startHub(m, port);
    await until(() => a.client.state === 'online' && b.client.state === 'online', 10_000);
    const second = await sendTo(A, targetB(), [{ kind: 'file', srcPath: f.path }], opts);
    expect(second.status).toBe('done');
    const idx = b.writes.map((w) => w.index).sort((x, y) => x - y);
    expect(idx).toEqual([0, 1, 2, 3]);
    expect(readdirSync(b.root).filter((n) => n.startsWith('big'))).toEqual(['big.bin']);
    expect(sha(readFileSync(join(b.root, 'big.bin')))).toBe(sha(f.data));
  });

  it('a session started on the relay resumes over the LAN without re-sending stored chunks', async () => {
    const m = await makeMesh();
    const hub = await startHub(m);
    const a = await device(m, A, () => hub.port);
    const b = await device(m, B, () => hub.port, true);
    await until(() => a.client.state === 'online' && b.client.state === 'online');
    const outbox = new Outbox(tmpDir());
    const f = file(3);
    const ac = new AbortController();
    const stop = (async () => {
      await until(() => b.writes.length >= 1, 10_000);
      ac.abort();
    })();
    const first = await sendTo(A, targetB(), [{ kind: 'file', srcPath: f.path }], {
      ...fast, outbox, signal: ac.signal, transport: () => new RelayTransport(A, a.client, B.deviceId, pubOf(a), 'relay'),
    });
    await stop;
    expect(first.status).toBe('cancelled');
    const stored = b.writes.length;
    const lanTarget: Target = { ...targetB(), host: '127.0.0.1', port: b.lanPort! };
    const second = await sendTo(A, lanTarget, [{ kind: 'file', srcPath: f.path }], { ...fast, outbox, transport: (t) => new LanTransport(A, t) });
    expect(second.status).toBe('done');
    expect(b.writes.length).toBe(3);
    expect(new Set(b.writes.map((w) => w.index)).size).toBe(3);
    expect(stored).toBeGreaterThanOrEqual(1);
    expect(sha(readFileSync(join(b.root, 'big.bin')))).toBe(sha(f.data));
  });

  it('a full hub: the sender reports hub-quota at once, keeps its outbox entry, no retries (I3)', async () => {
    const m = await makeMesh(1024);
    const hub = await startHub(m);
    const a = await device(m, A, () => hub.port);
    await until(() => a.client.state === 'online');
    const outbox = new Outbox(tmpDir());
    const f = file(1);
    let offers = 0;
    const r = await sendTo(A, targetB(), [{ kind: 'file', srcPath: f.path }], {
      retryDelaysMs: [10, 10, 10], outbox,
      transport: () => {
        const t = new RelayTransport(A, a.client, B.deviceId, pubOf(a), 'held', f.data.length + 1_000_000);
        const orig = t.request.bind(t);
        t.request = (method, path, ...rest) => { if (path.endsWith('/offer')) offers++; return orig(method, path, ...rest); };
        return t;
      },
    });
    expect(r).toMatchObject({ status: 'failed', error: 'http-507 hub-quota' });
    expect(offers).toBe(1);
    expect((await outbox.list()).length).toBe(1);
  });

  it('an interrupted held upload resumes from the outbox and ends held (I5)', async () => {
    const m = await makeMesh();
    const hub = await startHub(m);
    const a = await device(m, A, () => hub.port);
    await until(() => a.client.state === 'online');
    const outbox = new Outbox(tmpDir());
    const f = file(3);
    const ac = new AbortController();
    const first = await sendTo(A, targetB(), [{ kind: 'file', srcPath: f.path }], {
      ...fast, outbox, signal: ac.signal, onProgress: (p) => { if (p.sent > 0) ac.abort(); },
      transport: () => new RelayTransport(A, a.client, B.deviceId, pubOf(a), 'held', f.data.length + 4096 * 8),
    });
    expect(first.status).toBe('cancelled');
    const [again] = await outbox.resumeAll(A, () => targetB(), { ...fast, transport: () => new RelayTransport(A, a.client, B.deviceId, pubOf(a), 'relay') });
    expect(again!.status).toBe('held');
    const b = await device(m, B, () => hub.port);
    await until(() => readdirSync(b.root).includes('big.bin'), 10_000);
    expect(sha(readFileSync(join(b.root, 'big.bin')))).toBe(sha(f.data));
  });

  it('a LanTransport without an address fails with NoRouteError, not a retry loop', async () => {
    const t = new LanTransport(A, targetB());
    await expect(t.request('GET', '/mesh/v1/info', undefined, {}, { timeoutMs: 1000 })).rejects.toBeInstanceOf(NoRouteError);
    const r = await sendTo(A, targetB(), [{ kind: 'text', text: 'hi' }], { retryDelaysMs: [1000, 1000] });
    expect(r).toMatchObject({ status: 'failed', error: 'no-route' });
  });
});
