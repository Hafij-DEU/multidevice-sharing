import { createPublicKey, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HUB_AUTH_DOMAIN, HubServer, type HubServerOptions } from '../src/hub/server.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { signDomain, verifyDomain } from '../src/mesh/canonical.ts';
import { MembershipStore } from '../src/mesh/members.ts';
import { signList, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import { loadOrCreateRootKey } from '../src/mesh/rootkey.ts';
import { spkiSha256 } from '../src/mesh/canonical.ts';
import { serverTlsOptions } from '../src/tls.ts';

const tmps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-hub-'));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

let H: Identity; // hub device
let A: Identity;
let B: Identity;
let C: Identity; // never a member
beforeAll(async () => {
  [H, A, B, C] = (await Promise.all([1, 2, 3, 4].map(() => loadOrCreateIdentity(tmpDir())))) as [Identity, Identity, Identity, Identity];
});

const spkiPem = (id: Identity) => id.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const member = (id: Identity, alias: string, role: 'hub' | 'member' = 'member') =>
  ({ deviceId: id.deviceId, alias, publicKeyPem: spkiPem(id), role, addedAt: 1 });

interface Hub {
  hub: HubServer;
  port: number;
  members: MembershipStore;
  https: Server;
}

async function startHub(extra: Partial<HubServerOptions> = {}): Promise<Hub> {
  const home = tmpDir();
  const rootKey = await loadOrCreateRootKey(home);
  const anchor = createPublicKey(rootKey);
  const list: MembershipList = {
    v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: 1,
    hub: { deviceId: H.deviceId, urls: [] },
    members: [member(H, 'hub', 'hub'), member(A, 'a'), member(B, 'b')],
    revoked: [],
  };
  const members = await MembershipStore.init(home, anchor, signList(list, rootKey));
  const hub = new HubServer({ id: H, home, rootKey, members, ...extra });
  const https = createServer(serverTlsOptions(H));
  hub.attach(https);
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()));
  closers.push(async () => {
    await hub.close();
    https.closeAllConnections();
    await new Promise<void>((r) => https.close(() => r()));
  });
  return { hub, port: (https.address() as { port: number }).port, members, https };
}

/** A ws client with a message queue. `tls` = identity presented on the TLS layer (default: none). */
class Client {
  readonly ws: WebSocket;
  readonly msgs: Record<string, unknown>[] = [];
  readonly closed: Promise<number>;
  #waiters: (() => void)[] = [];
  constructor(url: string, tls?: Identity) {
    this.ws = new WebSocket(url, tls ? { key: tls.keyPem, cert: tls.certPem, rejectUnauthorized: false } : { rejectUnauthorized: false });
    this.ws.on('message', (d, isBinary) => {
      if (!isBinary) this.msgs.push(JSON.parse(d.toString()));
      for (const w of this.#waiters.splice(0)) w();
    });
    this.ws.on('error', () => {});
    this.closed = new Promise((r) => this.ws.on('close', (code) => r(code)));
    closers.push(() => this.ws.terminate());
  }
  async next(t: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t);
      if (i >= 0) return this.msgs.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error(`no ${t} message (have ${this.msgs.map((m) => m.t).join(',')})`);
      await new Promise<void>((r) => {
        this.#waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }
}

const url = (port: number) => `wss://127.0.0.1:${port}/mesh/v1/hub`;

/** Full handshake as `who`, presenting `tls` on the TLS layer (default: who). */
async function login(h: Hub, who: Identity, opts: { tls?: Identity | null; lan?: { host: string; port: number }[]; mv?: number; sigKey?: Identity; cert?: Identity } = {}): Promise<{ c: Client; nonce: string }> {
  const c = new Client(url(h.port), opts.tls === null ? undefined : (opts.tls ?? who));
  const hello = await c.next('hello');
  expect(hello).toMatchObject({ v: 1, hub: H.deviceId });
  const nonce = randomBytes(32).toString('base64');
  const sig = signDomain(HUB_AUTH_DOMAIN, `${H.deviceId}\0${who.deviceId}\0${hello.nonce as string}`, (opts.sigKey ?? who).privateKey);
  c.send({ t: 'auth', deviceId: who.deviceId, cert: (opts.cert ?? who).certDer.toString('base64'), nonce, sig, lan: opts.lan ?? [], mv: opts.mv ?? 1 });
  return { c, nonce };
}

describe('HubServer handshake', () => {
  it('a member authenticates and the welcome signature verifies with the hub member key', async () => {
    const h = await startHub();
    const { c, nonce } = await login(h, A, { mv: 0 });
    const w = await c.next('welcome');
    expect(verifyDomain(HUB_AUTH_DOMAIN, `hub\0${A.deviceId}\0${nonce}`, w.sig as string, H.publicKey)).toBe(true);
    expect((w.membership as SignedMembership).list.version).toBe(1); // mv 0 < 1: list included
    expect(h.hub.online()).toContain(A.deviceId);
  });

  it('omits the list when the device already has the current version', async () => {
    const h = await startHub();
    const { c } = await login(h, A, { mv: 1 });
    expect((await c.next('welcome')).membership).toBeUndefined();
  });

  it('a bad signature closes 4401', async () => {
    const h = await startHub();
    const { c } = await login(h, A, { sigKey: B });
    expect(await c.closed).toBe(4401);
  });

  it('a cert that does not hash to deviceId closes 4401', async () => {
    const h = await startHub();
    const { c } = await login(h, A, { cert: B });
    expect(await c.closed).toBe(4401);
  });

  it('a non-member gets revoked and 4403', async () => {
    const h = await startHub();
    const { c } = await login(h, C);
    await c.next('revoked');
    expect(await c.closed).toBe(4403);
  });

  it('a TLS peer other than deviceId closes 4401', async () => {
    const h = await startHub();
    const { c } = await login(h, B, { tls: A });
    expect(await c.closed).toBe(4401);
  });

  it('no auth within authTimeoutMs closes 4401', async () => {
    const h = await startHub({ authTimeoutMs: 100 });
    const c = new Client(url(h.port), A);
    await c.next('hello');
    expect(await c.closed).toBe(4401);
  });

  it('garbage instead of auth closes 4401', async () => {
    const h = await startHub();
    const c = new Client(url(h.port), A);
    await c.next('hello');
    c.ws.send('not json');
    expect(await c.closed).toBe(4401);
  });
});

describe('HubServer authority and registry', () => {
  it('addMember pushes version+1 to an online member', async () => {
    const h = await startHub();
    const { c } = await login(h, A);
    await c.next('welcome');
    const s = await h.hub.addMember({ deviceId: C.deviceId, alias: 'c', publicKeyPem: spkiPem(C) });
    expect(s.list.version).toBe(2);
    const pushed = await c.next('membership');
    expect((pushed.s as SignedMembership).list.version).toBe(2);
    expect(h.members.isTrusted(C.deviceId)).toBe(true);
  });

  it('revoke(B) closes B with 4403 and pushes the list to A', async () => {
    const h = await startHub();
    const a = await login(h, A);
    await a.c.next('welcome');
    const b = await login(h, B);
    await b.c.next('welcome');
    const s = await h.hub.revoke(B.deviceId);
    expect(s.list.revoked.map((r) => r.deviceId)).toEqual([B.deviceId]);
    await b.c.next('revoked');
    expect(await b.c.closed).toBe(4403);
    expect(((await a.c.next('membership')).s as SignedMembership).list.version).toBe(2);
    await expect(h.hub.revoke(H.deviceId)).rejects.toThrow();
  });

  it('a second link for A closes the first with 4409', async () => {
    const h = await startHub();
    const first = await login(h, A);
    await first.c.next('welcome');
    const second = await login(h, A);
    await second.c.next('welcome');
    expect(await first.c.closed).toBe(4409);
    expect(h.hub.online()).toEqual([A.deviceId]);
  });

  it('directory shows A online with its lan, offline after the heartbeat timeout', async () => {
    const h = await startHub({ heartbeatTimeoutMs: 200 });
    const lan = [{ host: '192.168.1.20', port: 53318 }];
    const { c } = await login(h, A, { lan });
    await c.next('welcome');
    const entry = h.hub.directory().find((d) => d.deviceId === A.deviceId)!;
    expect(entry).toMatchObject({ online: true, lanAddrs: lan });
    await new Promise((r) => h.hub.once('offline', r)); // silent client: the hub drops it
    const after = h.hub.directory().find((d) => d.deviceId === A.deviceId)!;
    expect(after.online).toBe(false);
    expect(after.lanAddrs).toEqual(lan);
    expect(after.lastSeen).toBeGreaterThan(0);
  });

  it('pushes directory changes to online members', async () => {
    const h = await startHub();
    const a = await login(h, A);
    await a.c.next('welcome');
    const b = await login(h, B);
    await b.c.next('welcome');
    const d = await a.c.next('directory');
    const devices = d.devices as { deviceId: string; online: boolean }[];
    expect(devices.find((x) => x.deviceId === B.deviceId)?.online).toBe(true);
  });
});

describe('pre-auth limits', () => {
  it('at most 64 unauthenticated links: the 65th is closed 4429', async () => {
    const h = await startHub({ authTimeoutMs: 5000 });
    const clients: Client[] = [];
    for (let i = 0; i < 64; i++) {
      const c = new Client(url(h.port));
      await c.next('hello');
      clients.push(c);
    }
    const extra = new Client(url(h.port));
    expect(await extra.closed).toBe(4429);
  });

  it('an oversized message before auth closes 4401', async () => {
    const h = await startHub();
    const c = new Client(url(h.port), A);
    await c.next('hello');
    c.ws.send('x'.repeat(20_000));
    expect(await c.closed).toBe(4401);
  });
});

describe('ingress', () => {
  it('listens on 127.0.0.1 only and speaks the same handshake over plain ws', async () => {
    const h = await startHub();
    const port = await h.hub.listenIngress(0);
    const c = new WebSocket(`ws://127.0.0.1:${port}/mesh/v1/hub`);
    closers.push(() => c.terminate());
    const hello = await new Promise<Record<string, unknown>>((r) => c.once('message', (d) => r(JSON.parse(d.toString()))));
    expect(hello.t).toBe('hello');
    const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (lanIp) {
      const err = await new Promise<string>((r) => {
        const x = new WebSocket(`ws://${lanIp}:${port}/mesh/v1/hub`);
        x.on('error', (e) => r((e as NodeJS.ErrnoException).code ?? 'error'));
        x.on('open', () => { x.terminate(); r('open'); });
      });
      expect(err).not.toBe('open');
    }
  });
});
