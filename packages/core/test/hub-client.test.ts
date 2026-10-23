import { createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MeshRequest, MeshResponse } from '../src/api/handler.ts';
import { HubClient, HubOfflineError } from '../src/hub/client.ts';
import { HUB_AUTH_DOMAIN, HubServer } from '../src/hub/server.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { signDomain, spkiSha256 } from '../src/mesh/canonical.ts';
import { decodeFrame, encodeFrame, sealEnvelope } from '../src/mesh/envelope.ts';
import { MembershipStore } from '../src/mesh/members.ts';
import { signList, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import { loadOrCreateRootKey } from '../src/mesh/rootkey.ts';
import { serverTlsOptions } from '../src/tls.ts';

const tmps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-hubc-'));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}

let H: Identity;
let A: Identity;
let B: Identity;
let C: Identity;
beforeAll(async () => {
  [H, A, B, C] = (await Promise.all([1, 2, 3, 4].map(() => loadOrCreateIdentity(tmpDir())))) as [Identity, Identity, Identity, Identity];
});

const spkiPem = (id: Identity) => id.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const member = (id: Identity, alias: string, role: 'hub' | 'member' = 'member') =>
  ({ deviceId: id.deviceId, alias, publicKeyPem: spkiPem(id), role, addedAt: 1 });

interface Mesh { rootKey: KeyObject; anchor: KeyObject; v1: SignedMembership }
async function makeMesh(): Promise<Mesh> {
  const rootKey = await loadOrCreateRootKey(tmpDir());
  const anchor = createPublicKey(rootKey);
  const list: MembershipList = {
    v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: 1,
    hub: { deviceId: H.deviceId, urls: [] },
    members: [member(H, 'hub', 'hub'), member(A, 'a'), member(B, 'b')],
    revoked: [],
  };
  return { rootKey, anchor, v1: signList(list, rootKey) };
}

interface RealHub { hub: HubServer; https: Server; port: number; upgrades: number; close(): Promise<void> }
async function startRealHub(mesh: Mesh, port = 0): Promise<RealHub> {
  const home = tmpDir();
  const members = await MembershipStore.init(home, mesh.anchor, mesh.v1);
  const hub = new HubServer({ id: H, home, rootKey: mesh.rootKey, members });
  const https = createServer(serverTlsOptions(H));
  const r = { hub, https, port: 0, upgrades: 0, close: async () => {} };
  https.on('upgrade', () => { r.upgrades++; });
  hub.attach(https);
  await new Promise<void>((res) => https.listen(port, '127.0.0.1', () => res()));
  r.port = (https.address() as { port: number }).port;
  let closed = false;
  r.close = async () => {
    if (closed) return;
    closed = true;
    await hub.close();
    https.closeAllConnections();
    await new Promise<void>((res) => https.close(() => res()));
  };
  closers.push(r.close);
  return r;
}

/** A hub impostor/test double: completes the handshake with `welcomeKey`, then hands over the socket. */
async function startFakeHub(welcomeKey: KeyObject): Promise<{ port: number; sockets: WebSocket[] }> {
  const https = createServer(serverTlsOptions(H));
  const wss = new WebSocketServer({ noServer: true });
  const sockets: WebSocket[] = [];
  https.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const nonce = randomBytes(32).toString('base64');
      ws.on('error', () => {});
      ws.once('message', (d) => {
        const auth = JSON.parse(d.toString());
        const sig = signDomain(HUB_AUTH_DOMAIN, `hub\0${auth.deviceId}\0${auth.nonce}`, welcomeKey);
        ws.send(JSON.stringify({ t: 'welcome', sig, directory: [] }));
        sockets.push(ws);
      });
      ws.send(JSON.stringify({ t: 'hello', v: 1, hub: H.deviceId, nonce }));
    });
  });
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()));
  closers.push(async () => {
    for (const s of sockets) s.terminate();
    https.closeAllConnections();
    await new Promise<void>((r) => https.close(() => r()));
  });
  return { port: (https.address() as { port: number }).port, sockets };
}

interface Dev { client: HubClient; members: MembershipStore; handled: MeshRequest[] }
async function device(mesh: Mesh, who: Identity, port: () => number, opts: { backoffMs?: number[]; answerCacheSize?: number } = {}): Promise<Dev> {
  const members = await MembershipStore.init(tmpDir(), mesh.anchor, mesh.v1);
  const handled: MeshRequest[] = [];
  const handler = async (r: MeshRequest): Promise<MeshResponse> => {
    handled.push(r);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
  };
  const client = new HubClient({
    id: who, members, handler, lanAddrs: () => [{ host: '10.0.0.5', port: 53318 }],
    hubLan: () => ({ host: '127.0.0.1', port: port() }), backoffMs: opts.backoffMs ?? [50, 50],
    ...(opts.answerCacheSize !== undefined ? { answerCacheSize: opts.answerCacheSize } : {}),
  });
  closers.push(() => client.stop());
  return { client, members, handled };
}

describe('HubClient', () => {
  it('goes online and accepts pushed membership updates', async () => {
    const mesh = await makeMesh();
    const hub = await startRealHub(mesh);
    const a = await device(mesh, A, () => hub.port);
    a.client.start();
    await until(() => a.client.state === 'online');
    const updates: SignedMembership[] = [];
    a.client.on('membership', (s: SignedMembership) => updates.push(s));
    await hub.hub.addMember({ deviceId: C.deviceId, alias: 'c', publicKeyPem: spkiPem(C) });
    await until(() => updates.length === 1);
    expect(a.members.list().version).toBe(2);
    expect(a.client.directory().find((d) => d.deviceId === A.deviceId)?.online).toBe(true);
  });

  it('ignores a stale list pushed by the hub', async () => {
    const mesh = await makeMesh();
    const fake = await startFakeHub(H.privateKey);
    const a = await device(mesh, A, () => fake.port);
    const v2 = signList({ ...mesh.v1.list, version: 2 }, mesh.rootKey);
    a.members.accept(v2);
    a.client.start();
    await until(() => a.client.state === 'online');
    let emitted = 0;
    a.client.on('membership', () => { emitted++; });
    fake.sockets[0]!.send(JSON.stringify({ t: 'membership', s: mesh.v1 }));
    await sleep(150);
    expect(emitted).toBe(0);
    expect(a.members.list().version).toBe(2);
  });

  it('never goes online when the welcome signature is wrong', async () => {
    const mesh = await makeMesh();
    const fake = await startFakeHub(B.privateKey); // not the hub's key
    const a = await device(mesh, A, () => fake.port);
    a.client.start();
    await sleep(400);
    expect(a.client.state).not.toBe('online');
  });

  it('reconnects after the hub restarts', async () => {
    const mesh = await makeMesh();
    let hub = await startRealHub(mesh);
    const port = hub.port;
    const a = await device(mesh, A, () => port);
    a.client.start();
    await until(() => a.client.state === 'online');
    await hub.close();
    await until(() => a.client.state !== 'online');
    hub = await startRealHub(mesh, port);
    await until(() => a.client.state === 'online');
    expect(hub.hub.online()).toContain(A.deviceId);
  });

  it('after revoke: one revoked event, state revoked, no reconnect attempts (Review Focus #3)', async () => {
    const mesh = await makeMesh();
    const hub = await startRealHub(mesh);
    const b = await device(mesh, B, () => hub.port);
    let revoked = 0;
    b.client.on('revoked', () => { revoked++; });
    b.client.start();
    await until(() => b.client.state === 'online');
    await hub.hub.revoke(B.deviceId);
    await until(() => b.client.state === 'revoked');
    const before = hub.upgrades;
    await sleep(1000);
    expect(hub.upgrades).toBe(before);
    expect(revoked).toBe(1);
  });

  it('request() rejects with HubOfflineError when not online', async () => {
    const mesh = await makeMesh();
    const a = await device(mesh, A, () => 1);
    const e = sealEnvelope({ v: 1, kind: 'req', id: 'AAAAAAAAAAAAAAAAAAAAAA', from: A.deviceId, to: B.deviceId, method: 'GET', path: '/mesh/v1/info' }, Buffer.alloc(0), A.privateKey);
    await expect(a.client.request(e, 1000)).rejects.toBeInstanceOf(HubOfflineError);
  });
});

describe('link liveness', () => {
  it('a hub that stops answering pings is dropped and relinked', async () => {
    const mesh = await makeMesh();
    const fake = await startFakeHub(H.privateKey);
    const members = await MembershipStore.init(tmpDir(), mesh.anchor, mesh.v1);
    const client = new HubClient({
      id: A, members, handler: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }), lanAddrs: () => [],
      hubLan: () => ({ host: '127.0.0.1', port: fake.port }), backoffMs: [50, 50], pingMs: 200,
    });
    closers.push(() => client.stop());
    let onlines = 0;
    client.on('online', () => { onlines++; });
    client.start();
    await until(() => onlines === 1);
    // the fake hub never answers pings and sends nothing: within 2 x pingMs + slack the client relinks
    await until(() => onlines === 2, 2 * 200 + 1500);
  });
});

describe('revocation must be proven (I1)', () => {
  /** A hub endpoint that answers every auth with {t:'revoked', s?} and close 4403. */
  async function revokingHub(s?: SignedMembership): Promise<number> {
    const https = createServer(serverTlsOptions(H));
    const wss = new WebSocketServer({ noServer: true });
    https.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => {});
        ws.once('message', () => {
          ws.send(JSON.stringify(s ? { t: 'revoked', s } : { t: 'revoked' }));
          ws.close(4403);
        });
        ws.send(JSON.stringify({ t: 'hello', v: 1, hub: H.deviceId, nonce: randomBytes(32).toString('base64') }));
      });
    });
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()));
    closers.push(async () => { https.closeAllConnections(); await new Promise<void>((r) => https.close(() => r())); });
    return (https.address() as { port: number }).port;
  }

  it('an unsigned revoked notice only stops the link; the mesh state stays', async () => {
    const mesh = await makeMesh();
    const port = await revokingHub();
    const a = await device(mesh, A, () => port);
    let revoked = 0;
    a.client.on('revoked', () => { revoked++; });
    a.client.start();
    await until(() => a.client.state === 'refused');
    await sleep(300);
    expect(revoked).toBe(0);
    expect(a.members.isTrusted(A.deviceId)).toBe(true);
  });

  it('a revoked notice carrying a root-signed list without this device revokes it', async () => {
    const mesh = await makeMesh();
    const v2 = signList({ ...mesh.v1.list, version: 2, members: mesh.v1.list.members.filter((m) => m.deviceId !== A.deviceId), revoked: [{ deviceId: A.deviceId, revokedAt: 1 }] }, mesh.rootKey);
    const port = await revokingHub(v2);
    const a = await device(mesh, A, () => port);
    let revoked = 0;
    a.client.on('revoked', () => { revoked++; });
    a.client.start();
    await until(() => a.client.state === 'revoked');
    expect(revoked).toBe(1);
  });

  it('a revoked notice with a list from another root is ignored', async () => {
    const mesh = await makeMesh();
    const evil = await makeMesh();
    const port = await revokingHub(evil.v1);
    const a = await device(mesh, A, () => port);
    let revoked = 0;
    a.client.on('revoked', () => { revoked++; });
    a.client.start();
    await until(() => a.client.state === 'refused');
    expect(revoked).toBe(0);
  });
});

describe('HubClient inbound relay', () => {
  async function linked() {
    const mesh = await makeMesh();
    const fake = await startFakeHub(H.privateKey);
    const a = await device(mesh, A, () => fake.port);
    a.client.start();
    await until(() => a.client.state === 'online');
    const ws = fake.sockets[0]!;
    const replies: Buffer[] = [];
    ws.on('message', (d, isBinary) => { if (isBinary) replies.push(d as Buffer); });
    return { a, ws, replies };
  }
  const req = (signer: Identity, id = 'BBBBBBBBBBBBBBBBBBBBBB') =>
    encodeFrame(sealEnvelope({ v: 1, kind: 'req', id, from: B.deviceId, to: A.deviceId, method: 'GET', path: '/mesh/v1/info' }, Buffer.alloc(0), signer.privateKey));

  it('a forged req never reaches the handler', async () => {
    const { a, ws, replies } = await linked();
    ws.send(req(C)); // C signs as B
    await sleep(200);
    expect(a.handled).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('a valid req is handled once (an in-flight replay is dropped) and answered with a signed res', async () => {
    const { a, ws, replies } = await linked();
    ws.send(req(B));
    ws.send(req(B));
    await until(() => replies.length >= 1);
    await sleep(150);
    expect(a.handled.length).toBe(1);
    expect(a.handled[0]!.peer).toBe(B.deviceId);
    const res = decodeFrame(replies[0]!);
    expect(res.header).toMatchObject({ kind: 'res', id: 'BBBBBBBBBBBBBBBBBBBBBB', from: A.deviceId, to: B.deviceId, status: 200 });
  });

  it('a repeat whose cached answer was evicted is handled again, never silently dropped', async () => {
    const mesh = await makeMesh();
    const fake = await startFakeHub(H.privateKey);
    const a = await device(mesh, A, () => fake.port, { answerCacheSize: 1 });
    a.client.start();
    await until(() => a.client.state === 'online');
    const ws = fake.sockets[0]!;
    const replies: Buffer[] = [];
    ws.on('message', (d, isBinary) => { if (isBinary) replies.push(d as Buffer); });
    ws.send(req(B, 'XXXXXXXXXXXXXXXXXXXXXX'));
    await until(() => replies.length === 1);
    ws.send(req(B, 'YYYYYYYYYYYYYYYYYYYYYY'));
    await until(() => replies.length === 2);
    ws.send(req(B, 'XXXXXXXXXXXXXXXXXXXXXX')); // evicted from the cache of 1
    await until(() => replies.length === 3);
    expect(decodeFrame(replies[2]!).header.id).toBe('XXXXXXXXXXXXXXXXXXXXXX');
  });

  it('a req repeated after it was answered gets the cached res again, without re-running the handler', async () => {
    const { a, ws, replies } = await linked();
    ws.send(req(B, 'CCCCCCCCCCCCCCCCCCCCCC'));
    await until(() => replies.length === 1);
    ws.send(req(B, 'CCCCCCCCCCCCCCCCCCCCCC')); // e.g. the hub replaying a held session after a link drop
    await until(() => replies.length === 2);
    expect(a.handled.length).toBe(1);
    expect(replies[1]!.equals(replies[0]!)).toBe(true);
  });
});
