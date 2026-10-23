import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine, type EngineEvent, type EngineOptions } from '../src/engine.ts';
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
    const data = randomBytes(3 * 4 * 1024 * 1024);
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
