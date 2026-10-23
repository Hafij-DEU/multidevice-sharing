import { createPublicKey, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { CompositeTrust, MembershipStore } from '../src/mesh/members.ts';
import { signList, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import { pullMembership } from '../src/mesh/propagate.ts';
import { loadOrCreateRootKey } from '../src/mesh/rootkey.ts';
import { connectPinned, pinnedRequest } from '../src/tls.ts';
import { TrustStore } from '../src/trust.ts';

const tmps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-revoke-'));
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
let B: Identity;
let C: Identity;
beforeAll(async () => {
  [H, A, B, C] = (await Promise.all([1, 2, 3, 4].map(() => loadOrCreateIdentity(tmpDir())))) as [Identity, Identity, Identity, Identity];
});
const spkiPem = (id: Identity) => id.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const member = (id: Identity, alias: string, role: 'hub' | 'member' = 'member') =>
  ({ deviceId: id.deviceId, alias, publicKeyPem: spkiPem(id), role, addedAt: 1 });

function listV1(anchor: KeyObject): MembershipList {
  return {
    v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: 1,
    hub: { deviceId: H.deviceId, urls: [] },
    members: [member(H, 'hub', 'hub'), member(A, 'a'), member(B, 'b'), member(C, 'c')],
    revoked: [],
  };
}

/** A device's receiver on a LAN port, trusting its mesh list. */
async function serve(id: Identity, store: MembershipStore | (() => SignedMembership | null)): Promise<{ port: number; server: Server }> {
  const trustStore = typeof store === 'function' ? null : store;
  const manual = new TrustStore(join(tmpDir(), 'trust.json'));
  // A peer without a mesh store (a hostile one) trusts C manually, so its list reaches C's verifier.
  if (typeof store === 'function') manual.add({ deviceId: C.deviceId, alias: 'c', publicKeyPem: spkiPem(C), addedAt: 1 });
  const trust = new CompositeTrust(trustStore, manual);
  const server = createMeshServer({
    id, trust, inbox: new Inbox(tmpDir()), onEvent: () => {},
    membership: typeof store === 'function' ? store : () => store.current(),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { port: (server.address() as { port: number }).port, server };
}

describe('revocation', () => {
  it('after the hub revokes B: A refuses B on the LAN, B is revoked once and never reconnects', async () => {
    const rootKey = await loadOrCreateRootKey(tmpDir());
    const anchor = createPublicKey(rootKey);
    const v1 = signList(listV1(anchor), rootKey);
    const hubHome = tmpDir();
    const hub = new HubServer({ id: H, home: hubHome, rootKey, members: await MembershipStore.init(hubHome, anchor, v1) });
    const hs = createMeshServer({ id: H, trust: new CompositeTrust(null, new TrustStore(join(hubHome, 't.json'))), inbox: new Inbox(tmpDir()), onEvent: () => {} });
    let upgrades = 0;
    hs.on('upgrade', () => { upgrades++; });
    hub.attach(hs);
    await new Promise<void>((r) => hs.listen(0, '127.0.0.1', () => r()));
    closers.push(async () => { await hub.close(); hs.closeAllConnections(); hs.close(); });
    const hubPort = (hs.address() as { port: number }).port;

    const aStore = await MembershipStore.init(tmpDir(), anchor, v1);
    const a = await serve(A, aStore);
    const mk = (id: Identity, store: MembershipStore) => {
      const c = new HubClient({ id, members: store, handler: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }), lanAddrs: () => [], hubLan: () => ({ host: '127.0.0.1', port: hubPort }), backoffMs: [50, 50] });
      closers.push(() => c.stop());
      c.start();
      return c;
    };
    const aClient = mk(A, aStore);
    const bClient = mk(B, await MembershipStore.init(tmpDir(), anchor, v1));
    let revokedEvents = 0;
    bClient.on('revoked', () => { revokedEvents++; });
    await until(() => aClient.state === 'online' && bClient.state === 'online');

    // Before: B is trusted by A's receiver.
    const info = async () => {
      const sock = await connectPinned('127.0.0.1', a.port, B, A.deviceId);
      return pinnedRequest(sock, 'GET', '/mesh/v1/membership', undefined, {});
    };
    expect((await info()).status).toBe(200);

    await hub.revoke(B.deviceId);
    await until(() => bClient.state === 'revoked' && aStore.list().version === 2);
    expect((await info()).status).toBe(403);
    const before = upgrades;
    await sleep(800);
    expect(upgrades).toBe(before);
    expect(revokedEvents).toBe(1);
  });
});

describe('LAN membership propagation', () => {
  it('info carries mv; C pulls a newer list from A while the hub is offline', async () => {
    const rootKey = await loadOrCreateRootKey(tmpDir());
    const anchor = createPublicKey(rootKey);
    const v1 = signList(listV1(anchor), rootKey);
    const v2 = signList({ ...listV1(anchor), version: 2, members: listV1(anchor).members.filter((m) => m.deviceId !== B.deviceId), revoked: [{ deviceId: B.deviceId, revokedAt: 5 }] }, rootKey);
    const aStore = await MembershipStore.init(tmpDir(), anchor, v1);
    aStore.accept(v2);
    const a = await serve(A, aStore);
    const sock = await connectPinned('127.0.0.1', a.port, C, A.deviceId);
    expect((await pinnedRequest(sock, 'GET', '/mesh/v1/info', undefined, {})).json).toMatchObject({ mv: 2 });

    const cStore = await MembershipStore.init(tmpDir(), anchor, v1);
    expect(await pullMembership(C, cStore, { deviceId: A.deviceId, host: '127.0.0.1', port: a.port })).toBe('updated');
    expect(cStore.list().version).toBe(2);
    expect(cStore.isTrusted(B.deviceId)).toBe(false);
    expect(await pullMembership(C, cStore, { deviceId: A.deviceId, host: '127.0.0.1', port: a.port })).toBe('same');
  });

  it('C refuses a list signed by another root and keeps its own', async () => {
    const rootKey = await loadOrCreateRootKey(tmpDir());
    const anchor = createPublicKey(rootKey);
    const v1 = signList(listV1(anchor), rootKey);
    const evilRoot = await loadOrCreateRootKey(tmpDir());
    const evil = signList({ ...listV1(anchor), version: 9 }, evilRoot); // claims our mesh id, wrong signer
    const a = await serve(A, () => evil);
    const cStore = await MembershipStore.init(tmpDir(), anchor, v1);
    await expect(pullMembership(C, cStore, { deviceId: A.deviceId, host: '127.0.0.1', port: a.port })).rejects.toThrow();
    expect(cStore.list().version).toBe(1);
  });
});
