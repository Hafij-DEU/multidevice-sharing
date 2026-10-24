import { createHmac, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMeshServer } from '../src/api/server.ts';
import { HubClient } from '../src/hub/client.ts';
import { HubServer } from '../src/hub/server.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { Inbox } from '../src/inbox.ts';
import { spkiSha256 } from '../src/mesh/canonical.ts';
import {
  INVITE_GROUP_TTL_MS,
  INVITE_GROUP_USES,
  INVITE_MAX_ATTEMPTS,
  INVITE_TTL_MS,
  InviteBook,
  InviteError,
  inviteUri,
  joinProof,
  parseInviteUri,
  type Invite,
} from '../src/mesh/invite.ts';
import { completeJoin, createJoinHandler, joinViaHub, joinViaLan } from '../src/mesh/join.ts';
import { CompositeTrust, MembershipStore } from '../src/mesh/members.ts';
import { signList, type MembershipList } from '../src/mesh/membership.ts';
import { loadOrCreateRootKey } from '../src/mesh/rootkey.ts';
import { TrustStore } from '../src/trust.ts';

const tmps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-invite-'));
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

let H: Identity;
let A: Identity;
let N: Identity; // the joining device
let M: Identity; // a second device holding the same QR
beforeAll(async () => {
  [H, A, N, M] = (await Promise.all([1, 2, 3, 4].map(() => loadOrCreateIdentity(tmpDir())))) as [Identity, Identity, Identity, Identity];
});
const spkiPem = (id: Identity) => id.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const ID1 = '1'.repeat(64);
const ID2 = '2'.repeat(64);

describe('invite URIs', () => {
  const inv = (): Invite => ({
    secret: Buffer.alloc(16, 7), inviter: ID1, mesh: ID2,
    lan: [{ host: '192.168.1.20', port: 53318 }, { host: '::1', port: 53318 }],
    hubUrls: ['wss://hub.example.ts.net/mesh/v1/hub'], expiresAt: 1_790_000_000_000,
  });

  it('round-trips, with fixed parameter order', () => {
    const u = inviteUri(inv());
    expect(u.startsWith('meshdrop://join?v=1&s=')).toBe(true);
    expect(u.indexOf('&i=')).toBeLessThan(u.indexOf('&r='));
    expect(u.indexOf('&r=')).toBeLessThan(u.indexOf('&l='));
    expect(u.lastIndexOf('&l=')).toBeLessThan(u.indexOf('&h='));
    expect(u.indexOf('&h=')).toBeLessThan(u.indexOf('&e='));
    expect(parseInviteUri(u)).toEqual(inv());
  });

  it('rejects every malformed field', () => {
    const u = inviteUri(inv());
    const bad = [
      u.replace('meshdrop://join', 'https://join'),
      u.replace('v=1', 'v=2'),
      u.replace(/s=[^&]+/, 's=short'),
      u.replace(/i=[^&]+/, 'i=' + 'g'.repeat(64)),
      u.replace(/r=[^&]+/, 'r=' + '2'.repeat(63)),
      u.replace(/l=[^&]+/, 'l=host-without-port'),
      u.replace(/l=[^&]+/, 'l=1.2.3.4%3A70000'),
      u.replace(/h=[^&]+/, 'h=' + encodeURIComponent('http://plain.example/x')),
      u.replace(/e=[^&]+/, 'e=soon'),
      u.replace(/&i=[^&]+/, ''),
      u + '&x=1',
    ];
    for (const b of bad) expect(() => parseInviteUri(b), b).toThrow(InviteError);
  });

  it('joinProof is HMAC-SHA256(secret, "meshdrop-join-v1\\0" + newId + "\\0" + inviter)', () => {
    const s = Buffer.alloc(16, 9);
    const want = createHmac('sha256', s).update(`meshdrop-join-v1\0${ID2}\0${ID1}`).digest('base64');
    expect(joinProof(s, ID2, ID1)).toBe(want);
  });
});

describe('InviteBook', () => {
  it('a good proof is ok once, then used', () => {
    const book = new InviteBook();
    const i = book.create(ID1, ID2, [], []);
    expect(i.expiresAt - Date.now()).toBeLessThanOrEqual(INVITE_TTL_MS);
    expect(book.consume(ID2, ID1, joinProof(i.secret, ID2, ID1))).toBe('ok');
    expect(book.consume(ID2, ID1, joinProof(i.secret, ID2, ID1))).toBe('used');
  });

  it('wrong proofs: bad-proof, then burned after the attempt limit even with the right proof', () => {
    const book = new InviteBook();
    const i = book.create(ID1, ID2, [], []);
    for (let k = 0; k < INVITE_MAX_ATTEMPTS; k++) expect(book.consume(ID2, ID1, 'AAAA')).toBe('bad-proof');
    expect(INVITE_MAX_ATTEMPTS).toBe(5);
    expect(book.consume(ID2, ID1, joinProof(i.secret, ID2, ID1))).toBe('burned');
  });

  it('registering a secret the book already holds never resets it (a used invite stays used)', () => {
    const book = new InviteBook();
    const i = book.create(ID1, ID2, [], []);
    expect(book.consume(ID2, ID1, joinProof(i.secret, ID2, ID1))).toBe('ok');
    book.register(i);
    expect(book.consume(ID2, ID1, joinProof(i.secret, ID2, ID1))).toBe('used');
  });

  it('register keeps the remaining lifetime it is given, never more than the invite TTL', () => {
    let t = 1_000;
    const book = new InviteBook(() => t);
    const s = Buffer.alloc(16, 3);
    book.register({ secret: s, inviter: ID1, mesh: ID2, lan: [], hubUrls: [], expiresAt: 0 }, 1000);
    t += 1001;
    expect(book.consume(ID2, ID1, joinProof(s, ID2, ID1))).toBe('expired');
    book.register({ secret: Buffer.alloc(16, 4), inviter: ID1, mesh: ID2, lan: [], hubUrls: [], expiresAt: 0 }, 10 * INVITE_TTL_MS);
    t += INVITE_TTL_MS + 1;
    expect(book.consume(ID2, ID1, joinProof(Buffer.alloc(16, 4), ID2, ID1))).toBe('expired');
  });

  it('a group invite takes several devices (each once, a retry is free), 15 min, and is not burned by markUsed', () => {
    let t = 1_000;
    const book = new InviteBook(() => t);
    const i = book.create(ID1, ID2, [], [], INVITE_GROUP_USES);
    expect(i.expiresAt - t).toBe(INVITE_GROUP_TTL_MS);
    const dev = (k: number) => k.toString(16).padStart(64, '0');
    expect(book.consume(dev(1), ID1, joinProof(i.secret, dev(1), ID1))).toBe('ok');
    expect(book.consume(dev(1), ID1, joinProof(i.secret, dev(1), ID1))).toBe('ok');
    expect(book.markUsed(ID1)).toBe(false);
    for (let k = 2; k <= INVITE_GROUP_USES; k++) expect(book.consume(dev(k), ID1, joinProof(i.secret, dev(k), ID1))).toBe('ok');
    expect(book.consume(dev(99), ID1, joinProof(i.secret, dev(99), ID1))).toBe('used');
    const j = book.create(ID1, ID2, [], [], 50);
    t += INVITE_GROUP_TTL_MS + 1;
    expect(book.consume(dev(1), ID1, joinProof(j.secret, dev(1), ID1))).toBe('expired');
  });

  it('markUsed burns the live invite of an inviter', () => {
    const book = new InviteBook();
    const i = book.create(ID1, ID2, [], []);
    expect(book.markUsed(ID1)).toBe(true);
    expect(book.consume(ID2, ID1, joinProof(i.secret, ID2, ID1))).toBe('used');
  });

  it('expiry is judged by the book’s own clock', () => {
    let t = 1_000;
    const book = new InviteBook(() => t);
    const i = book.create(ID1, ID2, [], []);
    t += INVITE_TTL_MS + 1;
    expect(book.consume(ID2, ID1, joinProof(i.secret, ID2, ID1))).toBe('expired');
    expect(book.consume(ID2, '3'.repeat(64), 'x')).toBe('unknown');
  });
});

// ---- joining ------------------------------------------------------------------------------------

interface Mesh { rootKey: KeyObject; anchor: KeyObject; hubHome: string }
async function makeMesh(urls: string[] = []): Promise<Mesh & { members: MembershipStore }> {
  const hubHome = tmpDir();
  const rootKey = await loadOrCreateRootKey(hubHome);
  const anchor = createPublicKey(rootKey);
  const list: MembershipList = {
    v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: 1,
    hub: { deviceId: H.deviceId, urls },
    members: [
      { deviceId: H.deviceId, alias: 'hub', publicKeyPem: spkiPem(H), role: 'hub', addedAt: 1 },
      { deviceId: A.deviceId, alias: 'a', publicKeyPem: spkiPem(A), role: 'member', addedAt: 1 },
    ],
    revoked: [],
  };
  const members = await MembershipStore.init(hubHome, anchor, signList(list, rootKey));
  return { rootKey, anchor, hubHome, members };
}

interface HubNode { hub: HubServer; https: Server; port: number; ingress: number; invites: InviteBook; close(): Promise<void> }
async function startHub(m: Mesh & { members: MembershipStore }, port = 0, ingressPort = 0): Promise<HubNode> {
  const invites = new InviteBook();
  const hub = new HubServer({ id: H, home: m.hubHome, rootKey: m.rootKey, members: m.members, invites });
  const trust = new CompositeTrust(m.members, new TrustStore(join(m.hubHome, 'trust.json')));
  const https = createMeshServer({
    id: H, trust, inbox: new Inbox(tmpDir()), onEvent: () => {},
    onJoin: createJoinHandler({ id: H, invites, members: () => m.members, hub, manualTrust: new TrustStore(join(m.hubHome, 'trust.json')) }),
    membership: () => m.members.current(),
  });
  hub.attach(https);
  await new Promise<void>((r) => https.listen(port, '127.0.0.1', () => r()));
  const ingress = await hub.listenIngress(ingressPort);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await hub.close();
    https.closeAllConnections();
    await new Promise<void>((r) => https.close(() => r()));
  };
  closers.push(close);
  return { hub, https, port: (https.address() as { port: number }).port, ingress, invites, close };
}

/** Member A: its own mesh server (accepting joins) plus a hub link. */
async function startA(m: Mesh & { members: MembershipStore }, hubPort: () => number) {
  const home = tmpDir();
  const members = await MembershipStore.init(home, m.anchor, m.members.current());
  const manual = new TrustStore(join(home, 'trust.json'));
  const trust = new CompositeTrust(members, manual);
  const invites = new InviteBook();
  const handler = { client: null as HubClient | null };
  const onJoin = createJoinHandler({ id: A, invites, members: () => members, hubClient: () => handler.client, manualTrust: manual });
  const https = createMeshServer({ id: A, trust, inbox: new Inbox(tmpDir()), onEvent: () => {}, onJoin, membership: () => members.current() });
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()));
  closers.push(() => { https.closeAllConnections(); https.close(); });
  const client = new HubClient({ id: A, members, handler: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }), lanAddrs: () => [], hubLan: () => ({ host: '127.0.0.1', port: hubPort() }), backoffMs: [50, 50] });
  handler.client = client;
  closers.push(() => client.stop());
  return { home, members, invites, client, port: (https.address() as { port: number }).port };
}

describe('joining over the LAN', () => {
  it('with the hub as inviter: the new device becomes a member and A sees the pushed list', async () => {
    const m = await makeMesh();
    const h = await startHub(m);
    const a = await startA(m, () => h.port);
    a.client.start();
    await until(() => a.client.state === 'online');
    const invite = h.invites.create(H.deviceId, spkiSha256(m.anchor), [{ host: '127.0.0.1', port: h.port }], []);
    const nHome = tmpDir();
    expect(await joinViaLan(N, inviteUri(invite), 'phone', nHome)).toBe('member');
    const nm = await MembershipStore.load(nHome);
    expect(nm!.isTrusted(N.deviceId)).toBe(true);
    await until(() => a.members.isTrusted(N.deviceId));
  });

  it('with a non-hub inviter while the hub is offline: provisional, then full member after the hub returns', async () => {
    const m = await makeMesh();
    let h = await startHub(m);
    const hubPort = h.port;
    await h.close();
    const a = await startA(m, () => hubPort);
    a.client.start();
    const invite = a.invites.create(A.deviceId, spkiSha256(m.anchor), [{ host: '127.0.0.1', port: a.port }], []);
    const nHome = tmpDir();
    expect(await joinViaLan(N, inviteUri(invite), 'phone', nHome)).toBe('provisional');
    expect(await MembershipStore.load(nHome)).toBeNull();
    h = await startHub(m, hubPort);
    await until(() => m.members.isTrusted(N.deviceId), 8000);
    await completeJoin(N, nHome);
    const nm = (await MembershipStore.load(nHome))!;
    expect(nm.isTrusted(N.deviceId)).toBe(true);
    const nClient = new HubClient({ id: N, members: nm, handler: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }), lanAddrs: () => [], hubLan: () => ({ host: '127.0.0.1', port: hubPort }), backoffMs: [50, 50] });
    closers.push(() => nClient.stop());
    nClient.start();
    await until(() => nClient.state === 'online');
  });

  it('refuses an invite whose root hash does not match and stores nothing', async () => {
    const m = await makeMesh();
    const h = await startHub(m);
    const invite = h.invites.create(H.deviceId, '9'.repeat(64), [{ host: '127.0.0.1', port: h.port }], []);
    const nHome = tmpDir();
    await expect(joinViaLan(N, inviteUri(invite), 'phone', nHome)).rejects.toThrow(/mesh/);
    expect(existsSync(join(nHome, 'mesh'))).toBe(false);
  });

  it('a wrong proof is refused by the inviter', async () => {
    const m = await makeMesh();
    const h = await startHub(m);
    const invite = h.invites.create(H.deviceId, spkiSha256(m.anchor), [{ host: '127.0.0.1', port: h.port }], []);
    const forged = { ...invite, secret: Buffer.alloc(16, 1) };
    await expect(joinViaLan(N, inviteUri(forged), 'phone', tmpDir())).rejects.toThrow(/bad-proof/);
  });
});

describe('an invite is single-use across the LAN and the hub (I2)', () => {
  it('redeemed over the LAN via a member: the hub copy is burned too', async () => {
    const m = await makeMesh();
    const h = await startHub(m);
    const url = `ws://127.0.0.1:${h.ingress}/mesh/v1/hub`;
    await h.hub.setUrls([url]);
    const a = await startA(m, () => h.port);
    a.client.start();
    await until(() => a.client.state === 'online' && a.members.list().hub.urls.length === 1);
    const invite = a.invites.create(A.deviceId, spkiSha256(m.anchor), [{ host: '127.0.0.1', port: a.port }], [url]);
    a.client.registerInvite(invite);
    await sleep(100);
    expect(await joinViaLan(N, inviteUri(invite), 'n', tmpDir())).toBe('member');
    await expect(joinViaHub(M, inviteUri(invite), 'm', tmpDir())).rejects.toThrow(/used/);
  });

  it('redeemed over the hub: the inviter’s own copy is burned too', async () => {
    const m = await makeMesh();
    const h = await startHub(m);
    const url = `ws://127.0.0.1:${h.ingress}/mesh/v1/hub`;
    await h.hub.setUrls([url]);
    const a = await startA(m, () => h.port);
    a.client.on('invite-used', () => a.invites.markUsed(A.deviceId));
    a.client.start();
    await until(() => a.client.state === 'online' && a.members.list().hub.urls.length === 1);
    const invite = a.invites.create(A.deviceId, spkiSha256(m.anchor), [{ host: '127.0.0.1', port: a.port }], [url]);
    a.client.registerInvite(invite);
    await sleep(100);
    expect(await joinViaHub(N, inviteUri(invite), 'n', tmpDir())).toBe('member');
    await sleep(200);
    await expect(joinViaLan(M, inviteUri(invite), 'm', tmpDir())).rejects.toThrow(/used/);
  });
});

describe('joining through the hub only', () => {
  it('an invite registered by A lets a device join over the hub ingress', async () => {
    const m = await makeMesh();
    const h = await startHub(m);
    const url = `ws://127.0.0.1:${h.ingress}/mesh/v1/hub`;
    await h.hub.setUrls([url]);
    const a = await startA(m, () => h.port);
    a.client.start();
    await until(() => a.client.state === 'online' && a.members.list().hub.urls.length === 1);
    const invite = a.invites.create(A.deviceId, spkiSha256(m.anchor), [], [url]);
    expect(a.client.registerInvite(invite)).toBe(true);
    await sleep(100);
    const nHome = tmpDir();
    // Review Focus #5: the joining device's clock is a day ahead; only the enforcing side's clock counts.
    expect(await joinViaHub(N, inviteUri(invite), 'laptop', nHome, { now: () => Date.now() + 86_400_000 })).toBe('member');
    expect((await MembershipStore.load(nHome))!.isTrusted(N.deviceId)).toBe(true);
    expect(m.members.isTrusted(N.deviceId)).toBe(true);
  });
});

// ---- frozen vector --------------------------------------------------------------------------

const VECTOR_URL = new URL('../../../protocol/vectors/invite-v1.json', import.meta.url);
interface InviteVector { description: string; invite: { secretHex: string; inviter: string; mesh: string; lan: Invite['lan']; hubUrls: string[]; expiresAt: number }; uri: string; newDeviceId: string; proofB64: string }
function compute(): InviteVector {
  const inv: Invite = {
    secret: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), inviter: ID1, mesh: ID2,
    lan: [{ host: '192.168.1.20', port: 53318 }], hubUrls: ['wss://hub.example.ts.net/mesh/v1/hub'], expiresAt: 1_790_000_000_000,
  };
  return {
    description: 'Invite URI v1 and join proof. proof = base64(HMAC-SHA256(secret, utf8("meshdrop-join-v1") || 0x00 || utf8(newDeviceId) || 0x00 || utf8(inviter))). e = expiresAt in epoch seconds (informational; only the inviter or hub enforces expiry).',
    invite: { secretHex: inv.secret.toString('hex'), inviter: inv.inviter, mesh: inv.mesh, lan: inv.lan, hubUrls: inv.hubUrls, expiresAt: inv.expiresAt },
    uri: inviteUri(inv),
    newDeviceId: '3'.repeat(64),
    proofB64: joinProof(inv.secret, '3'.repeat(64), inv.inviter),
  };
}
describe('frozen vector (invite-v1.json)', () => {
  if (process.env.UPDATE_VECTORS === '1') {
    it('regenerates invite-v1.json', () => {
      writeFileSync(VECTOR_URL, JSON.stringify(compute(), null, 2) + '\n');
    });
  }
  it('URI and proof match byte-for-byte', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as InviteVector;
    expect(compute()).toEqual(vec);
    expect(parseInviteUri(vec.uri).secret.toString('hex')).toBe(vec.invite.secretHex);
  });
});

// keep imported helpers referenced
void createPrivateKey;
