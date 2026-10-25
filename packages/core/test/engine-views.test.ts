import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine, liveListener, type EngineEvent, type EngineOptions } from '../src/engine.ts';
import { probeLoopbackMulticast } from './multicast.ts';
import { RelayTransport } from '../src/transfer/transport.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-views-'));
  tmps.push(d);
  return d;
}
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) await e.stop();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}
async function make(extra: Partial<EngineOptions> = {}, home = tmpDir()): Promise<{ e: Engine; events: EngineEvent[]; inbox: string; home: string }> {
  const inbox = extra.inbox ?? tmpDir();
  const e = await Engine.create({ home, inbox, port: 0, discovery: false, alias: extra.alias ?? 'dev', hub: { ingressPort: 0 }, hubBackoffMs: [50, 100], allowLoopbackHubUrls: true, ...extra });
  const events: EngineEvent[] = [];
  e.on('event', (x: EngineEvent) => events.push(x));
  engines.push(e);
  return { e, events, inbox, home };
}

describe('Engine.devices()', () => {
  it('merges mesh members, manually paired devices and nearby strangers; never self', async () => {
    const H = await make({ alias: 'hub' });
    await H.e.hubInit([]);
    await H.e.start();
    const A = await make({ alias: 'laptop' });
    await A.e.start();
    expect(await A.e.join(H.e.createInvite().uri)).toBe('member');
    await until(() => A.e.hubStatus().online);
    const P = await make({ alias: 'paired' });
    await P.e.start();
    await A.e.pairManual('127.0.0.1', P.e.port, 'my-paired');
    const S = await make({ alias: 'stranger' });
    await S.e.start();
    await A.e.addNearby('127.0.0.1', S.e.port);
    const ds = A.e.devices();
    expect(ds.some((d) => d.deviceId === A.e.identity.deviceId)).toBe(false);
    expect(ds.find((d) => d.deviceId === H.e.identity.deviceId)).toMatchObject({ alias: 'hub', role: 'hub', trusted: true, reach: 'hub' });
    expect(ds.find((d) => d.deviceId === P.e.identity.deviceId)).toMatchObject({ alias: 'my-paired', role: 'paired', trusted: true, reach: 'lan' });
    expect(ds.find((d) => d.deviceId === S.e.identity.deviceId)).toMatchObject({ role: 'nearby', trusted: false, reach: 'lan' });
  });
});

describe('group invite', () => {
  it('one QR adds several devices to the mesh; a single-use one adds only the first', async () => {
    const H = await make({ alias: 'hub' });
    await H.e.hubInit([]);
    await H.e.start();
    const devs = [];
    for (const alias of ['phone', 'tablet', 'laptop']) {
      const d = await make({ alias });
      await d.e.start();
      devs.push(d);
    }
    const group = H.e.createInvite({ group: true }).uri;
    for (const d of devs) expect(await d.e.join(group)).toBe('member');
    expect(H.e.members().map((m) => m.alias).sort()).toEqual(['hub', 'laptop', 'phone', 'tablet']);
    const once = H.e.createInvite().uri;
    const x = await make({ alias: 'x' });
    await x.e.start();
    const y = await make({ alias: 'y' });
    await y.e.start();
    expect(await x.e.join(once)).toBe('member');
    await expect(y.e.join(once)).rejects.toThrow();
  }, 60_000);
});

describe('auto-resume', () => {
  it('a send that failed while the receiver was down completes on its own when it is seen again', async () => {
    const A = await make({ alias: 'a', autoResume: true });
    const bHome = tmpDir();
    let B = await make({ alias: 'b' }, bHome);
    await A.e.start();
    await B.e.start();
    const bPort = B.e.port;
    await A.e.pairManual('127.0.0.1', bPort, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    const f = join(tmpDir(), 'auto.bin');
    const data = randomBytes(64 * 1024 * 1024); // big enough that a fast runner cannot finish before B stops
    writeFileSync(f, data);
    const p = A.e.send([B.e.identity.deviceId.slice(0, 8)], [{ kind: 'file', srcPath: f }]);
    await until(() => A.events.some((x) => x.source === 'sender' && x.type === 'progress'));
    await B.e.stop();
    const [r] = await p;
    expect(r!.status).toBe('failed');
    B = await make({ alias: 'b', port: bPort, inbox: B.inbox }, bHome);
    await B.e.start();
    await A.e.addNearby('127.0.0.1', bPort); // seen again ('peer' event)
    await until(() => A.events.some((x) => x.source === 'sender' && x.type === 'result' && x.status === 'done'), 20_000);
    expect(sha(readFileSync(join(B.inbox, 'auto.bin')))).toBe(sha(data));
  }, 40_000);

  it('a send to a device that is away waits in the outbox and goes out when it is seen', async () => {
    const A = await make({ alias: 'a', autoResume: true });
    const bHome = tmpDir();
    let B = await make({ alias: 'b' }, bHome);
    await A.e.start();
    await B.e.start();
    const bPort = B.e.port;
    await A.e.pairManual('127.0.0.1', bPort, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    await B.e.stop();
    A.e.forgetPeer(B.e.identity.deviceId);
    const [r] = await A.e.send([B.e.identity.deviceId.slice(0, 8)], [{ kind: 'text', text: 'later' }]);
    expect(r).toMatchObject({ status: 'failed', error: 'offline', sessionId: expect.any(String) });
    expect((await A.e.listOutbox()).map((o) => o.sessionId)).toEqual([r!.sessionId]);
    B = await make({ alias: 'b', port: bPort, inbox: B.inbox }, bHome);
    await B.e.start();
    await A.e.addNearby('127.0.0.1', bPort);
    await until(() => A.events.some((x) => x.source === 'sender' && x.type === 'result' && x.status === 'done'), 20_000);
    expect(B.events).toContainEqual(expect.objectContaining({ source: 'receiver', type: 'received', text: 'later' }));
    expect(await A.e.listOutbox()).toEqual([]);
  }, 40_000);

  it('never auto-resumes a send whose source changed', async () => {
    const A = await make({ alias: 'a', autoResume: true });
    const B = await make({ alias: 'b' });
    await A.e.start();
    await B.e.start();
    await A.e.pairManual('127.0.0.1', B.e.port, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    const f = join(tmpDir(), 'chg.bin');
    writeFileSync(f, randomBytes(64 * 1024 * 1024));
    const p = A.e.send([B.e.identity.deviceId.slice(0, 8)], [{ kind: 'file', srcPath: f }]);
    await until(() => A.events.some((x) => x.source === 'sender' && x.type === 'progress'));
    writeFileSync(f, randomBytes(64 * 1024 * 1024)); // changed under the sender
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const [r] = await p;
    expect(r).toMatchObject({ status: 'failed', error: 'source-changed' });
    A.events.length = 0;
    await A.e.addNearby('127.0.0.1', B.e.port);
    await sleep(800);
    expect(A.events.filter((x) => x.source === 'sender' && x.type === 'result')).toEqual([]);
  });
});

describe('scanSubnet', () => {
  it('finds a listener in the scanned range and returns 0 when nothing listens', async () => {
    const A = await make({ alias: 'a' });
    const B = await make({ alias: 'b' });
    await A.e.start();
    await B.e.start();
    expect(await A.e.scanSubnet({ subnets: ['127.0.0.0/30'], ports: [B.e.port], timeoutMs: 400 })).toBe(1);
    expect(A.e.devices().find((d) => d.deviceId === B.e.identity.deviceId)).toMatchObject({ role: 'nearby', reach: 'lan' });
    expect(await A.e.scanSubnet({ subnets: ['127.0.0.0/30'], ports: [1], timeoutMs: 200 })).toBe(0);
  });
});

describe('routing', () => {
  it('a device trusted only by manual pairing is never routed through the hub', async () => {
    const H = await make({ alias: 'hub' });
    await H.e.hubInit([]);
    await H.e.start();
    const A = await make({ alias: 'a' });
    await A.e.start();
    expect(await A.e.join(H.e.createInvite().uri)).toBe('member');
    await until(() => A.e.hubStatus().online);
    const P = await make({ alias: 'p' });
    await P.e.start();
    await A.e.pairManual('127.0.0.1', P.e.port, 'pee');
    const pId = P.e.identity.deviceId;
    await P.e.stop();
    A.e.forgetPeer(pId); // off the LAN now
    let relayed = 0;
    const orig = RelayTransport.prototype.request;
    RelayTransport.prototype.request = function (...args) {
      relayed++;
      return orig.apply(this, args);
    };
    try {
      const f = join(tmpDir(), 'x.txt');
      writeFileSync(f, 'x');
      const [r] = await A.e.send([pId.slice(0, 8)], [{ kind: 'file', srcPath: f }]);
      expect(r).toMatchObject({ status: 'failed', error: 'offline' });
      expect(relayed).toBe(0);
    } finally {
      RelayTransport.prototype.request = orig;
    }
  });
});

describe('M3 review fixes (core)', () => {
  it('tags a send: its progress and result carry the tag and the session id', async () => {
    const A = await make({ alias: 'a' });
    const B = await make({ alias: 'b' });
    await A.e.start();
    await B.e.start();
    await A.e.pairManual('127.0.0.1', B.e.port, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    const f = join(tmpDir(), 'tag.bin');
    writeFileSync(f, randomBytes(5 * 1024 * 1024));
    const [r] = await A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: f }], { tag: 't1' });
    const prog = A.events.filter((x) => x.source === 'sender' && x.type === 'progress');
    expect(prog.length).toBeGreaterThan(0);
    for (const p of prog) expect(p).toMatchObject({ tag: 't1', sessionId: r!.sessionId });
    expect(A.events.find((x) => x.source === 'sender' && x.type === 'result')).toMatchObject({ tag: 't1', sessionId: r!.sessionId, status: 'done' });
  });

  it('a burst of sightings auto-resumes a paused send once', async () => {
    const A = await make({ alias: 'a', autoResume: true });
    const bHome = tmpDir();
    let B = await make({ alias: 'b' }, bHome);
    await A.e.start();
    await B.e.start();
    const bPort = B.e.port;
    await A.e.pairManual('127.0.0.1', bPort, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    const f = join(tmpDir(), 'burst.bin');
    writeFileSync(f, randomBytes(64 * 1024 * 1024));
    const p = A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: f }]);
    await until(() => A.events.some((x) => x.source === 'sender' && x.type === 'progress'));
    await B.e.stop();
    expect((await p)[0]!.status).toBe('failed');
    B = await make({ alias: 'b', port: bPort, inbox: B.inbox }, bHome);
    await B.e.start();
    A.events.length = 0;
    await Promise.all([A.e.addNearby('127.0.0.1', bPort), A.e.addNearby('127.0.0.1', bPort), A.e.addNearby('127.0.0.1', bPort)]);
    await until(() => A.events.some((x) => x.source === 'sender' && x.type === 'result' && x.status === 'done'), 20_000);
    await sleep(300);
    expect(A.events.filter((x) => x.source === 'sender' && x.type === 'result')).toHaveLength(1);
  }, 40_000);

  it('paused receiving refuses offers with 503 but keeps serving', async () => {
    const A = await make({ alias: 'a' });
    const B = await make({ alias: 'b' });
    await A.e.start();
    await B.e.start();
    await A.e.pairManual('127.0.0.1', B.e.port, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    const f = join(tmpDir(), 'p.txt');
    writeFileSync(f, 'x');
    B.e.setReceiving(false);
    expect(B.e.receiving).toBe(false);
    const [r1] = await A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: f }]);
    expect(r1).toMatchObject({ status: 'failed' });
    expect(r1!.error).toMatch(/503/);
    expect(B.events.some((x) => x.source === 'receiver' && x.type === 'received')).toBe(false);
    B.e.setReceiving(true);
    const [r2] = await A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: f }]);
    expect(r2).toMatchObject({ status: 'done' });
  });

  it('liveListener confirms the pid file by the certificate behind its port', async () => {
    const home = tmpDir();
    const S = await make({ alias: 's' }, home);
    await S.e.start();
    writeFileSync(join(home, 'listen.pid'), JSON.stringify({ pid: process.pid, port: S.e.port }));
    expect(await liveListener(home, S.e.identity.deviceId)).toEqual({ pid: process.pid, port: S.e.port });
    const other = await make({ alias: 'o' });
    await other.e.start();
    writeFileSync(join(home, 'listen.pid'), JSON.stringify({ pid: process.pid, port: other.e.port })); // someone else's port
    expect(await liveListener(home, S.e.identity.deviceId)).toBeNull();
    writeFileSync(join(home, 'listen.pid'), JSON.stringify({ pid: process.ppid, port: 1 })); // live pid, nothing listening
    expect(await liveListener(home, S.e.identity.deviceId)).toBeNull();
  });
});

describe('M3 review fixes: client-only discovery', () => {
  let ok = false;
  const port = 47000 + Math.floor(Math.random() * 900);
  it('probes multicast', async () => {
    ok = await probeLoopbackMulticast(port);
  });
  it('a serve:false engine hears announcements without announcing itself', async (ctx) => {
    if (!ok) ctx.skip();
    const S = await make({ alias: 'srv', discovery: { port, intervalMs: 100, ttlMs: 2000 } });
    const C = await make({ alias: 'cli', serve: false, clientDiscovery: true, discovery: { port, intervalMs: 100, ttlMs: 2000 } });
    await S.e.start();
    await C.e.start();
    await until(() => C.e.peers().some((p) => p.deviceId === S.e.identity.deviceId), 5_000);
    await sleep(400);
    expect(S.e.peers().some((p) => p.deviceId === C.e.identity.deviceId)).toBe(false);
  }, 20_000);
});

describe('Engine pairing code (security review #3)', () => {
  it('probe shows the same code on both sides and trusts nothing; a different device answering is refused', async () => {
    const A = await make({ alias: 'ay' });
    await A.e.start();
    const B = await make({ alias: 'bee' });
    await B.e.start();
    const C = await make({ alias: 'sea' });
    await C.e.start();
    const p = await A.e.pairProbe('127.0.0.1', B.e.port);
    expect(p.deviceId).toBe(B.e.identity.deviceId);
    expect(p.code).toBe(B.e.pairingCode(A.e.identity.deviceId));
    expect(A.e.devices().find((d) => d.deviceId === B.e.identity.deviceId)?.trusted ?? false).toBe(false);
    await expect(A.e.pairManual('127.0.0.1', C.e.port, 'bee', p.deviceId)).rejects.toThrow(/another device/);
    expect(A.e.devices().find((d) => d.deviceId === C.e.identity.deviceId)?.trusted ?? false).toBe(false);
    await A.e.pairManual('127.0.0.1', B.e.port, 'bee', p.deviceId);
    expect(A.e.devices().find((d) => d.deviceId === B.e.identity.deviceId)?.trusted).toBe(true);
  });
});

describe('app messages (M10)', () => {
  it('reach the paired device app over the LAN; 404 without a handler', async () => {
    const A = await make({ alias: 'ay' });
    await A.e.start();
    const B = await make({ alias: 'bee' });
    await B.e.start();
    await A.e.pairManual('127.0.0.1', B.e.port, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    expect(await A.e.appSend(B.e.identity.deviceId, { kind: 'ping' })).toMatchObject({ status: 404 });
    const seen: unknown[] = [];
    B.e.setAppHandler(async (peer, msg) => {
      seen.push([peer, msg]);
      return { status: 200, body: { pong: true } };
    });
    expect(await A.e.appSend(B.e.identity.deviceId, { kind: 'ping', n: 1 })).toEqual({ status: 200, body: { pong: true } });
    expect(seen).toEqual([[A.e.identity.deviceId, { kind: 'ping', n: 1 }]]);
  });
});

describe('live streams (M10b)', () => {
  it('a trusted device reaches the app stream handler on the LAN server; others get 403', async () => {
    const { LanTransport } = await import('../src/transfer/transport.ts');
    const A = await make({ alias: 'ay' });
    await A.e.start();
    const B = await make({ alias: 'bee' });
    await B.e.start();
    const C = await make({ alias: 'sea' });
    await C.e.start();
    await A.e.pairManual('127.0.0.1', B.e.port, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    B.e.setStreamHandler((s) => {
      if (s.path !== 'echo') return false;
      s.res.writeHead(200, { 'content-type': 'text/plain' });
      s.res.end(`hi ${s.peer.slice(0, 4)} ${s.query.get('x')}`);
      return true;
    });
    const get = (from: Engine, path: string) => new LanTransport(from.identity, { deviceId: B.e.identity.deviceId, host: '127.0.0.1', port: B.e.port }).request('GET', path, undefined, {}, { timeoutMs: 5000 });
    const ok = await get(A.e, '/mesh/v1/stream/echo?x=1');
    expect([ok.status, ok.body.toString()]).toEqual([200, `hi ${A.e.identity.deviceId.slice(0, 4)} 1`]);
    expect((await get(A.e, '/mesh/v1/stream/nope')).status).toBe(404);
    expect((await get(C.e, '/mesh/v1/stream/echo')).status).toBe(403);
  });
});

describe('burn and print flags (M11)', () => {
  it('reach the receiver with the received event', async () => {
    const A = await make({ alias: 'ay' });
    await A.e.start();
    const B = await make({ alias: 'bee' });
    await B.e.start();
    await A.e.pairManual('127.0.0.1', B.e.port, 'bee');
    await B.e.pairManual('127.0.0.1', A.e.port, 'ay');
    const f = join(tmpDir(), 'secret.txt');
    writeFileSync(f, 'read me once');
    const [r] = await A.e.send([B.e.identity.deviceId], [{ kind: 'file', srcPath: f }], { burn: true, print: true });
    expect(r).toMatchObject({ status: 'done' });
    await until(() => B.events.some((x) => x.source === 'receiver' && x.type === 'received'));
    expect(B.events.find((x) => x.source === 'receiver' && x.type === 'received')).toMatchObject({ burn: true, print: true });
  });
});
