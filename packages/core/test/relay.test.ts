import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createMeshHandler, type MeshRequest, type MeshResponse } from '../src/api/handler.ts';
import { createOffer, newSessionId, sealChunk, type Manifest } from '../src/chunk.ts';
import { HubClient } from '../src/hub/client.ts';
import { HUB_AUTH_DOMAIN, HubServer, type HubServerOptions } from '../src/hub/server.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { Inbox } from '../src/inbox.ts';
import { signDomain, spkiSha256 } from '../src/mesh/canonical.ts';
import { decodeFrame, encodeFrame, openEnvelope, sealEnvelope, type Envelope } from '../src/mesh/envelope.ts';
import { MembershipStore } from '../src/mesh/members.ts';
import { signList, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import { loadOrCreateRootKey } from '../src/mesh/rootkey.ts';
import { serverTlsOptions } from '../src/tls.ts';

const tmps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-relay-'));
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
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rid = () => randomBytes(16).toString('base64url');

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

interface Mesh { rootKey: KeyObject; anchor: KeyObject; v1: SignedMembership; hub: HubServer; port: number; frames: Buffer[] }

async function startMesh(extra: Partial<HubServerOptions> = {}): Promise<Mesh> {
  const rootKey = await loadOrCreateRootKey(tmpDir());
  const anchor = createPublicKey(rootKey);
  const list: MembershipList = {
    v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: 1,
    hub: { deviceId: H.deviceId, urls: [] },
    members: [member(H, 'hub', 'hub'), member(A, 'a'), member(B, 'b'), member(C, 'c')],
    revoked: [],
  };
  const v1 = signList(list, rootKey);
  const home = tmpDir();
  const frames: Buffer[] = [];
  const hub = new HubServer({ id: H, home, rootKey, members: await MembershipStore.init(home, anchor, v1), onRelay: (f) => frames.push(Buffer.from(f)), ...extra });
  const https: Server = createServer(serverTlsOptions(H));
  hub.attach(https);
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()));
  closers.push(async () => {
    await hub.close();
    https.closeAllConnections();
    await new Promise<void>((r) => https.close(() => r()));
  });
  return { rootKey, anchor, v1, hub, port: (https.address() as { port: number }).port, frames };
}

interface Dev { client: HubClient; root: string; members: MembershipStore }
async function device(m: Mesh, who: Identity): Promise<Dev> {
  const members = await MembershipStore.init(tmpDir(), m.anchor, m.v1);
  const root = tmpDir();
  const h = createMeshHandler({ id: who, trust: members, inbox: new Inbox(root), onEvent: () => {} });
  const client = new HubClient({ id: who, members, handler: (r) => h.handle(r), lanAddrs: () => [], hubLan: () => ({ host: '127.0.0.1', port: m.port }) });
  closers.push(() => client.stop());
  client.start();
  await until(() => client.state === 'online');
  return { client, root, members };
}

const req = (from: Identity, to: Identity, method: string, path: string, body: Buffer = Buffer.alloc(0), signer = from) =>
  sealEnvelope({ v: 1, kind: 'req', id: rid(), from: from.deviceId, to: to.deviceId, method, path }, body, signer.privateKey);
const json = (e: Envelope) => JSON.parse(e.body.toString());

describe('hub relay routing', () => {
  it('relays a whole session A→B; B inbox gets the file; the hub never sees plaintext', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const b = await device(m, B);
    const data = Buffer.from('PLAINTEXT-MARKER-7f3a '.repeat(500));
    const sessionId = newSessionId();
    const man: Manifest = {
      v: 1, sessionId, from: A.deviceId, to: B.deviceId, createdAt: 1,
      files: [{ fileId: 0, path: 'relayed.txt', size: data.length, mime: 'text/plain', sha256: sha(data) }], dirs: [],
    };
    const { offer, ctx } = createOffer(A, B.publicKey, man);
    const r1 = await a.client.request(req(A, B, 'POST', '/mesh/v1/offer', Buffer.from(JSON.stringify(offer))), 5000);
    expect(r1.header).toMatchObject({ kind: 'res', from: B.deviceId, to: A.deviceId, status: 200 });
    expect(openEnvelope(r1, (id) => (id === B.deviceId ? B.publicKey : undefined)).status).toBe(200);
    expect((await a.client.request(req(A, B, 'PUT', `/mesh/v1/chunk/${sessionId}/0/0`, sealChunk(ctx, sessionId, 0, 0, data)), 5000)).header.status).toBe(204);
    expect((await a.client.request(req(A, B, 'POST', `/mesh/v1/complete/${sessionId}/0`), 5000)).header.status).toBe(200);
    const fin = await a.client.request(req(A, B, 'POST', `/mesh/v1/finish/${sessionId}`), 5000);
    expect(json(fin)).toEqual({ files: ['relayed.txt'] });
    expect(sha(readFileSync(join(b.root, 'relayed.txt')))).toBe(sha(data));
    const marker = Buffer.from('PLAINTEXT-MARKER-7f3a');
    expect(m.frames.length).toBeGreaterThan(0);
    for (const f of m.frames) expect(f.includes(marker)).toBe(false);
  });

  it('a target that is offline gets a hub-signed 503 offline', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const r = await a.client.request(req(A, C, 'GET', '/mesh/v1/info'), 5000);
    expect(r.header).toMatchObject({ from: H.deviceId, to: A.deviceId, status: 503 });
    expect(openEnvelope(r, (id) => (id === H.deviceId ? H.publicKey : undefined)).status).toBe(503);
    expect(json(r)).toEqual({ error: 'offline' });
  });

  it('a forged from gets 400 bad-envelope and nothing reaches the target', async () => {
    const m = await startMesh();
    const a = await device(m, A);
    const b = await device(m, B);
    const seen: string[] = [];
    b.client.on('control', () => seen.push('control'));
    const before = m.frames.length;
    const forged = req(B, C, 'GET', '/mesh/v1/info', Buffer.alloc(0), B); // validly signed by B, but sent on A's link
    const r = await a.client.request(forged, 5000);
    expect(r.header).toMatchObject({ from: H.deviceId, status: 400 });
    expect(json(r)).toEqual({ error: 'bad-envelope' });
    expect(m.frames.length).toBe(before); // nothing was routed
    const self = await a.client.request(req(A, A, 'GET', '/mesh/v1/info'), 5000);
    expect(self.header.status).toBe(400);
  });

  it('a res that does not come from the target is dropped; the sender gets 504 relay-timeout', async () => {
    const m = await startMesh({ relayTimeoutMs: 300 });
    const a = await device(m, A);
    // B is a raw link that answers with a res signed by B but claiming to come from C
    const ws = new WebSocket(`wss://127.0.0.1:${m.port}/mesh/v1/hub`, { key: B.keyPem, cert: B.certPem, rejectUnauthorized: false });
    closers.push(() => ws.terminate());
    ws.on('error', () => {});
    const nonce = randomBytes(32).toString('base64');
    ws.on('message', (d, isBinary) => {
      if (isBinary) {
        const inbound = decodeFrame(d as Buffer);
        const lie = sealEnvelope({ v: 1, kind: 'res', id: inbound.header.id, from: C.deviceId, to: A.deviceId, status: 200 }, Buffer.alloc(0), B.privateKey);
        ws.send(encodeFrame(lie));
        return;
      }
      const msg = JSON.parse(d.toString());
      if (msg.t === 'hello') {
        const sig = signDomain(HUB_AUTH_DOMAIN, `${H.deviceId}\0${B.deviceId}\0${msg.nonce}`, B.privateKey);
        ws.send(JSON.stringify({ t: 'auth', deviceId: B.deviceId, cert: B.certDer.toString('base64'), nonce, sig, lan: [], mv: 1 }));
      }
    });
    await until(() => m.hub.online().includes(B.deviceId));
    const r = await a.client.request(req(A, B, 'GET', '/mesh/v1/info'), 5000);
    expect(r.header).toMatchObject({ from: H.deviceId, status: 504 });
    expect(json(r)).toEqual({ error: 'relay-timeout' });
  });
});

// keep the handler types referenced for readers of this file
export type { MeshRequest, MeshResponse };
