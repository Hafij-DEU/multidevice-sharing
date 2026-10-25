import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Discovery, type Announce, type PeerInfo } from '../src/discovery.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { serverTlsOptions } from '../src/tls.ts';
import { cleanupEngines, makeEngines } from './engines.ts';
import { multicastIt, probeLoopbackMulticast } from './multicast.ts';

const GROUP = '224.0.0.168';
const LO = '127.0.0.1';
const hex64 = () => randomBytes(32).toString('hex');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every multicast test uses its own UDP port so a lingering socket or a real MeshDrop on the
// machine (53318) can never cross-talk with it.
let nextPort = 53900 + (process.pid % 50) * 10;
const freshPort = () => nextPort++;

const announce = (alias: string, port = 1111): Announce => ({
  v: 1,
  deviceId: hex64(),
  alias,
  deviceType: 'desktop',
  port,
});

const tmps: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  cleanupEngines();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mk(self: Announce, port: number, extra: Partial<ConstructorParameters<typeof Discovery>[0]> = {}): Discovery {
  const d = new Discovery({ self, port, iface: LO, intervalMs: 100, ttlMs: 400, ...extra });
  cleanups.push(() => d.stop());
  return d;
}

function once(d: Discovery, event: 'peer' | 'lost', pred: (p: PeerInfo) => boolean = () => true, ms = 1000): Promise<PeerInfo> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      d.off(event, on);
      reject(new Error(`timed out waiting for '${event}'`));
    }, ms);
    const on = (p: PeerInfo) => {
      if (!pred(p)) return;
      clearTimeout(t);
      d.off(event, on);
      resolve(p);
    };
    d.on(event, on);
  });
}

/** Raw UDP sender into the multicast group via loopback (what a hostile or buggy LAN host would do). */
async function rawSender(port: number): Promise<(data: Buffer | string) => Promise<void>> {
  const s = createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((r) => s.bind(0, LO, () => r()));
  s.setMulticastInterface(LO);
  s.setMulticastLoopback(true);
  cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
  return (data) => new Promise<void>((resolve, reject) => s.send(data, port, GROUP, (e) => (e ? reject(e) : resolve())));
}

let multicastOk = false;
beforeAll(async () => {
  multicastOk = await probeLoopbackMulticast(freshPort());
});
const mcast = multicastIt(() => multicastOk);

describe('Discovery (multicast)', () => {
  mcast('two instances discover each other within 1 s', async () => {
    const port = freshPort();
    const a = announce('alice', 4001);
    const b = announce('bob', 4002);
    const da = mk(a, port);
    const db = mk(b, port);
    const seenByA = once(da, 'peer', (p) => p.deviceId === b.deviceId);
    const seenByB = once(db, 'peer', (p) => p.deviceId === a.deviceId);
    da.start();
    db.start();
    const [pb, pa] = await Promise.all([seenByA, seenByB]);
    expect(pb).toMatchObject({ deviceId: b.deviceId, alias: 'bob', deviceType: 'desktop', port: 4002, host: LO });
    expect(pa).toMatchObject({ deviceId: a.deviceId, alias: 'alice', port: 4001, host: LO });
    expect(da.peers().map((p) => p.deviceId)).toEqual([b.deviceId]); // never lists itself
    expect(typeof da.peers()[0]!.lastSeen).toBe('number');
  });

  mcast("emits 'lost' after the other stops", async () => {
    const port = freshPort();
    const a = announce('alice');
    const b = announce('bob');
    const da = mk(a, port);
    const db = mk(b, port);
    da.start();
    db.start();
    await once(da, 'peer', (p) => p.deviceId === b.deviceId);
    const lost = once(da, 'lost', (p) => p.deviceId === b.deviceId, 2000);
    db.stop();
    expect((await lost).deviceId).toBe(b.deviceId);
    expect(da.peers()).toEqual([]);
  });

  mcast('garbage, oversized and invalid packets are ignored; the host comes from the UDP source', async () => {
    const port = freshPort();
    const d = mk(announce('me'), port);
    const errors: unknown[] = [];
    d.on('error', (e) => errors.push(e));
    d.start();
    await sleep(100); // let the socket bind and join
    const send = await rawSender(port);
    const good = announce('good', 4242);
    const ok = { v: 1, deviceId: good.deviceId, alias: 'good', deviceType: 'mobile', port: 4242 };
    const bad: (Buffer | string)[] = [
      Buffer.from([0xff, 0xfe, 0x00, 0x01]),
      'not json at all',
      '[]',
      'null',
      '"str"',
      JSON.stringify({ ...ok, v: 2 }),
      JSON.stringify({ ...ok, deviceId: 'A'.repeat(64) }), // uppercase
      JSON.stringify({ ...ok, deviceId: 'ab' }), // short
      JSON.stringify({ ...ok, deviceId: 5 }),
      JSON.stringify({ ...ok, alias: 'x'.repeat(65) }),
      JSON.stringify({ ...ok, alias: 7 }),
      JSON.stringify({ ...ok, deviceType: 'toaster' }),
      JSON.stringify({ ...ok, port: 0 }),
      JSON.stringify({ ...ok, port: 65536 }),
      JSON.stringify({ ...ok, port: 80.5 }),
      JSON.stringify({ ...ok, port: '80' }),
      JSON.stringify({ ...ok, padding: 'p'.repeat(1100) }), // valid fields, but > 1024 bytes
    ];
    for (const p of bad) await send(p);
    expect(JSON.stringify(ok).length).toBeLessThan(1024);
    // Control: a valid packet sent last proves the earlier ones were delivered and dropped, not lost.
    await send(JSON.stringify({ ...ok, host: '6.6.6.6' }));
    const p = await once(d, 'peer', () => true, 1500);
    expect(p).toMatchObject({ deviceId: good.deviceId, alias: 'good', deviceType: 'mobile', port: 4242, host: LO });
    expect(d.peers()).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  mcast("packets carrying our own deviceId are ignored", async () => {
    const port = freshPort();
    const me = announce('me');
    const d = mk(me, port);
    d.start();
    await sleep(100);
    const send = await rawSender(port);
    await send(JSON.stringify(me));
    const other = announce('other');
    await send(JSON.stringify(other));
    await once(d, 'peer', (p) => p.deviceId === other.deviceId);
    expect(d.peers().map((p) => p.deviceId)).toEqual([other.deviceId]);
  });

  mcast("'peer' fires on first sight and on change, not on every refresh", async () => {
    const port = freshPort();
    const d = mk(announce('me'), port, { ttlMs: 5000 });
    const seen: PeerInfo[] = [];
    d.on('peer', (p) => seen.push(p));
    d.start();
    await sleep(100);
    const send = await rawSender(port);
    const x = announce('x1', 5000);
    for (let i = 0; i < 4; i++) {
      await send(JSON.stringify(x));
      await sleep(30);
    }
    expect(seen).toHaveLength(1);
    const firstSeen = d.peers()[0]!.lastSeen;
    await sleep(20);
    await send(JSON.stringify(x));
    await sleep(60);
    expect(seen).toHaveLength(1);
    expect(d.peers()[0]!.lastSeen).toBeGreaterThan(firstSeen); // refresh still bumps lastSeen

    await send(JSON.stringify({ ...x, alias: 'x2' }));
    await sleep(60);
    expect(seen.map((p) => p.alias)).toEqual(['x1', 'x2']);
    await send(JSON.stringify({ ...x, alias: 'x2', port: 5001 }));
    await sleep(60);
    expect(seen).toHaveLength(3);
    await send(JSON.stringify({ ...x, alias: 'x2', port: 5001, deviceType: 'headless' }));
    await sleep(60);
    expect(seen).toHaveLength(4);
    expect(seen[3]).toMatchObject({ alias: 'x2', port: 5001, deviceType: 'headless' });
  });

  mcast('the peer table is bounded at 256 and never evicts live peers', async () => {
    const port = freshPort();
    const d = mk(announce('me'), port, { ttlMs: 10_000 });
    d.start();
    await sleep(100);
    const send = await rawSender(port);
    const first = Array.from({ length: 256 }, (_, i) => announce(`p${i}`));
    // UDP may drop part of a burst; announces are idempotent, so resend whatever is still missing.
    const deadline = Date.now() + 5000;
    while (d.peers().length < 256 && Date.now() < deadline) {
      const have = new Set(d.peers().map((p) => p.deviceId));
      for (const a of first) if (!have.has(a.deviceId)) await send(JSON.stringify(a));
      await sleep(50);
    }
    expect(d.peers()).toHaveLength(256);
    const extra = announce('overflow');
    await send(JSON.stringify(extra));
    await send(JSON.stringify({ ...first[0]!, alias: 'renamed' })); // known device: still updated
    await sleep(150);
    const ids = new Set(d.peers().map((p) => p.deviceId));
    expect(ids.size).toBe(256);
    expect(ids.has(extra.deviceId)).toBe(false);
    expect(first.every((a) => ids.has(a.deviceId))).toBe(true);
    expect(d.peers().find((p) => p.deviceId === first[0]!.deviceId)!.alias).toBe('renamed');
  });

  mcast('an announce for a manually probed peer refreshes it but keeps it manual', async () => {
    const [eng] = await makeEngines(1);
    const port = freshPort();
    const d = mk(announce('me'), port, { ttlMs: 100 });
    d.on('error', () => {});
    d.start();
    await sleep(100);
    await d.probe(LO, eng!.port);
    const before = d.peers()[0]!.lastSeen;
    const send = await rawSender(port);
    await sleep(20);
    await send(JSON.stringify({ v: 1, deviceId: eng!.id.deviceId, alias: 'renamed', deviceType: 'desktop', port: eng!.port }));
    await sleep(300);
    const p = d.peers()[0]!;
    expect(p.alias).toBe('renamed');
    expect(p.manual).toBe(true);
    expect(p.lastSeen).toBeGreaterThan(before);
  });

  mcast('an announce never moves a manual peer: its probed (certificate-verified) address stays', async () => {
    const [eng] = await makeEngines(1);
    const port = freshPort();
    const d = mk(announce('me'), port, { ttlMs: 10_000 });
    d.on('error', () => {});
    d.start();
    await sleep(100);
    await d.probe(LO, eng!.port);
    const send = await rawSender(port);
    await send(JSON.stringify({ v: 1, deviceId: eng!.id.deviceId, alias: 'forged', deviceType: 'desktop', port: 9 }));
    await sleep(300);
    const p = d.peers()[0]!;
    expect(p.host).toBe(LO);
    expect(p.port).toBe(eng!.port);
  });

  mcast('a full table still admits a trusted device by evicting an untrusted one', async () => {
    const trustedA = announce('trusted');
    const port = freshPort();
    const d = mk(announce('me'), port, { ttlMs: 10_000, isTrusted: (id) => id === trustedA.deviceId });
    d.start();
    await sleep(100);
    const send = await rawSender(port);
    const first = Array.from({ length: 256 }, (_, i) => announce(`p${i}`));
    const deadline = Date.now() + 5000;
    while (d.peers().length < 256 && Date.now() < deadline) {
      const have = new Set(d.peers().map((p) => p.deviceId));
      for (const a of first) if (!have.has(a.deviceId)) await send(JSON.stringify(a));
      await sleep(50);
    }
    expect(d.peers()).toHaveLength(256);
    const lost: PeerInfo[] = [];
    d.on('lost', (p: PeerInfo) => lost.push(p));
    await send(JSON.stringify(trustedA));
    await send(JSON.stringify(announce('stranger')));
    await sleep(200);
    const ids = new Set(d.peers().map((p) => p.deviceId));
    expect(ids.size).toBe(256);
    expect(ids.has(trustedA.deviceId)).toBe(true);
    expect(lost).toHaveLength(1);
  });

  mcast('stop() is idempotent and start() after stop() works', async () => {
    const port = freshPort();
    const a = announce('alice');
    const b = announce('bob');
    const da = mk(a, port);
    const db = mk(b, port);
    da.start();
    da.start(); // double start is harmless
    da.stop();
    da.stop();
    db.stop(); // stop before start
    da.start();
    db.start();
    await once(da, 'peer', (p) => p.deviceId === b.deviceId);
    await once(db, 'peer', (p) => p.deviceId === a.deviceId);
    da.stop();
    db.stop();
    db.stop();
  });
});

describe('Discovery (error handling)', () => {
  it('an unusable interface does not crash start(), with or without an error listener', async () => {
    const port = freshPort();
    // 203.0.113.0/24 is TEST-NET-3: not assigned to any local interface.
    const quiet = new Discovery({ self: announce('q'), port, iface: '203.0.113.77', intervalMs: 50, ttlMs: 200 });
    cleanups.push(() => quiet.stop());
    expect(() => quiet.start()).not.toThrow();
    await sleep(200); // several send ticks against a broken interface
    quiet.stop();

    const loud = new Discovery({ self: announce('l'), port, iface: '203.0.113.77', intervalMs: 50, ttlMs: 200 });
    cleanups.push(() => loud.stop());
    const errors: Error[] = [];
    loud.on('error', (e: Error) => errors.push(e));
    expect(() => loud.start()).not.toThrow();
    await sleep(200);
    loud.stop();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('rejects an invalid self announce', () => {
    expect(() => new Discovery({ self: { ...announce('x'), port: 0 } })).toThrow();
    expect(() => new Discovery({ self: { ...announce('x'), deviceId: 'nope' } })).toThrow();
  });
});

describe('Discovery.probe', () => {
  const self = () => announce('prober');

  it('finds a mesh server and reports the certificate-derived device id', async () => {
    const [eng] = await makeEngines(1);
    const d = new Discovery({ self: self() });
    const peers: PeerInfo[] = [];
    d.on('peer', (p: PeerInfo) => peers.push(p));
    await d.probe('127.0.0.1', eng!.port);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      deviceId: eng!.id.deviceId,
      host: '127.0.0.1',
      port: eng!.port,
      deviceType: 'desktop',
    });
    expect(typeof peers[0]!.alias).toBe('string');
    expect(d.peers().map((p) => p.deviceId)).toEqual([eng!.id.deviceId]);
    // A second probe of an unchanged peer refreshes it without a second 'peer'.
    await d.probe('127.0.0.1', eng!.port);
    expect(peers).toHaveLength(1);
  });

  /** An HTTPS server using `cert` that answers every request with 200 and `body`. */
  async function fakeInfoServer(cert: Identity, body: unknown, status = 200): Promise<number> {
    const srv: Server = createHttpsServer(serverTlsOptions(cert), (_req, res) => {
      const j = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': j.length });
      res.end(j);
    });
    srv.on('tlsClientError', () => {});
    await new Promise<void>((r) => srv.listen(0, LO, () => r()));
    cleanups.push(() => {
      srv.close();
      srv.closeAllConnections();
    });
    return (srv.address() as { port: number }).port;
  }

  async function ids(): Promise<[Identity, Identity]> {
    const dirs = [0, 1].map(() => {
      const d = mkdtempSync(join(tmpdir(), 'md-disc-'));
      tmps.push(d);
      return d;
    });
    return (await Promise.all(dirs.map((d) => loadOrCreateIdentity(d)))) as [Identity, Identity];
  }

  it('rejects when the info JSON claims a different device id than the certificate', async () => {
    const [real, other] = await ids();
    const port = await fakeInfoServer(real, { v: 1, deviceId: other.deviceId, alias: 'liar', deviceType: 'desktop' });
    const d = new Discovery({ self: self() });
    const peers: PeerInfo[] = [];
    d.on('peer', (p: PeerInfo) => peers.push(p));
    await expect(d.probe(LO, port)).rejects.toThrow();
    expect(peers).toEqual([]);
    expect(d.peers()).toEqual([]);
  });

  it('rejects invalid info (bad alias/type/version/status/json) and never emits', async () => {
    const [real] = await ids();
    const good = { v: 1, deviceId: real.deviceId, alias: 'ok', deviceType: 'desktop' };
    const cases: [string, unknown, number?][] = [
      ['alias too long', { ...good, alias: 'x'.repeat(65) }],
      ['alias not a string', { ...good, alias: 3 }],
      ['bad deviceType', { ...good, deviceType: 'fridge' }],
      ['bad version', { ...good, v: 2 }],
      ['not json', 'nope'],
      ['array', []],
      ['non-200', good, 403],
    ];
    const d = new Discovery({ self: self() });
    const peers: PeerInfo[] = [];
    d.on('peer', (p: PeerInfo) => peers.push(p));
    for (const [name, body, status] of cases) {
      const port = await fakeInfoServer(real, body, status);
      await expect(d.probe(LO, port), name).rejects.toThrow();
    }
    expect(peers).toEqual([]);
  });

  it('ignores a probe that reaches our own device', async () => {
    const [eng] = await makeEngines(1);
    const d = new Discovery({ self: { ...self(), deviceId: eng!.id.deviceId } });
    const peers: PeerInfo[] = [];
    d.on('peer', (p: PeerInfo) => peers.push(p));
    await d.probe(LO, eng!.port);
    expect(peers).toEqual([]);
    expect(d.peers()).toEqual([]);
  });

  it('times out against a host that accepts TCP but never answers TLS', async () => {
    const sockets: import('node:net').Socket[] = [];
    const srv: TcpServer = createTcpServer((s) => {
      sockets.push(s);
      s.on('error', () => {});
    });
    await new Promise<void>((r) => srv.listen(0, LO, () => r()));
    cleanups.push(() => {
      for (const s of sockets) s.destroy();
      srv.close();
    });
    const port = (srv.address() as { port: number }).port;
    const d = new Discovery({ self: self() });
    const t0 = Date.now();
    await expect(d.probe(LO, port, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('rejects an invalid port up front and leaves no timer that can crash the process later', async () => {
    const d = new Discovery({ self: self() });
    for (const port of [70000, 0, -1, 1.5, Number.NaN]) {
      await expect(d.probe(LO, port, { timeoutMs: 50 })).rejects.toThrow(/invalid port/);
    }
    await sleep(300); // well past every timeoutMs: a stray timer would throw an uncaught error here
    expect(d.peers()).toEqual([]);
  });

  it('keeps probed peers past ttlMs (even never started); forget() removes them with a single lost', async () => {
    const [eng] = await makeEngines(1);
    const d = new Discovery({ self: self(), ttlMs: 100 }); // never started
    cleanups.push(() => d.stop());
    const lost: PeerInfo[] = [];
    d.on('lost', (p: PeerInfo) => lost.push(p));
    await d.probe(LO, eng!.port);
    await sleep(400); // 4x ttl
    expect(lost).toEqual([]);
    expect(d.peers()).toHaveLength(1);
    expect(d.peers()[0]!.manual).toBe(true);
    d.forget('0'.repeat(64)); // unknown id: ignored
    expect(lost).toEqual([]);
    d.forget(eng!.id.deviceId);
    expect(d.peers()).toEqual([]);
    expect(lost.map((p) => p.deviceId)).toEqual([eng!.id.deviceId]);
    d.forget(eng!.id.deviceId); // second forget: nothing more
    expect(lost).toHaveLength(1);
  });

  it('a started Discovery does not sweep manual peers, and stop() still clears them', async () => {
    const [eng] = await makeEngines(1);
    const d = new Discovery({ self: self(), port: freshPort(), iface: LO, intervalMs: 50, ttlMs: 100 });
    cleanups.push(() => d.stop());
    const lost: PeerInfo[] = [];
    d.on('lost', (p: PeerInfo) => lost.push(p));
    d.on('error', () => {});
    d.start();
    await d.probe(LO, eng!.port);
    await sleep(400);
    expect(lost).toEqual([]);
    expect(d.peers()).toHaveLength(1);
    d.stop();
    expect(d.peers()).toEqual([]);
  });

  it('rejects when nothing is listening', async () => {
    const d = new Discovery({ self: self() });
    // Port 1 on loopback: connection refused.
    await expect(d.probe(LO, 1)).rejects.toThrow();
  });
});
