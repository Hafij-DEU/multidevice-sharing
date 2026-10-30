// Bluetooth links (M14) end to end: two engines whose RFCOMM sockets are in-process stream pairs.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, duplexPair, type Duplex } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { BtLinks, linkMode, type BtPlatform, type LinkPolicy } from '../src/bt/links.ts';
import { Engine, type EngineEvent, type EngineOptions } from '../src/engine.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { TrustStore } from '../src/trust.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}
const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-bt-'));
  tmps.push(d);
  return d;
}
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) await e.stop();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** Radios in range of each other: address -> the listener of the device with that address. */
class Air {
  readonly radios = new Map<string, FakeRadio>();
  dials = 0;
}

class FakeRadio implements BtPlatform {
  onConn: ((c: Duplex, a: string) => void) | null = null;
  away = false;
  dialled = 0;
  readonly air: Air;
  readonly address: string;
  constructor(air: Air, address: string) {
    this.air = air;
    this.address = address;
    air.radios.set(address, this);
  }
  async bonded() {
    return [...this.air.radios.keys()].filter((a) => a !== this.address).map((address) => ({ address, name: address }));
  }
  async dial(address: string): Promise<Duplex> {
    this.air.dials++;
    this.dialled++;
    const far = this.air.radios.get(address);
    if (!far || far.away || !far.onConn || this.away) throw new Error('host is down');
    const [x, y] = duplexPair();
    far.onConn(y, this.address);
    return x;
  }
  async listen(cb: (c: Duplex, a: string) => void) {
    this.onConn = cb;
  }
  stop() {
    this.onConn = null;
  }
}

/** Engines that trust each other from the start but never see each other on the LAN. */
async function makePair(policy?: LinkPolicy, extra: Partial<EngineOptions> = {}) {
  const homes = [tmpDir(), tmpDir()];
  const ids: Identity[] = await Promise.all(homes.map((h) => loadOrCreateIdentity(h)));
  homes.forEach((h, i) => {
    const other = ids[1 - i]!;
    new TrustStore(join(h, 'trust.json')).add({ deviceId: other.deviceId, alias: i ? 'ay' : 'bee', publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }) as string, addedAt: 1 });
  });
  const air = new Air();
  const radios = [new FakeRadio(air, 'AA:AA:AA:AA:AA:AA'), new FakeRadio(air, 'BB:BB:BB:BB:BB:BB')];
  const out = [];
  for (let i = 0; i < 2; i++) {
    const inbox = tmpDir();
    const e = await Engine.create({
      home: homes[i]!, inbox, port: 0, discovery: false, alias: i ? 'bee' : 'ay', autoResume: false,
      bt: { platform: radios[i]!, tickMs: 0, ...(policy ? { policy } : {}) }, ...extra,
    });
    const events: EngineEvent[] = [];
    e.on('event', (x: EngineEvent) => events.push(x));
    engines.push(e);
    out.push({ e, inbox, home: homes[i]!, radio: radios[i]!, events });
  }
  return { A: out[0]!, B: out[1]!, air };
}

describe('Bluetooth links between engines (M14)', () => {
  it('with no LAN path, files, app messages and live streams go over the Bluetooth link', async () => {
    const { A, B } = await makePair();
    await A.e.start();
    await B.e.start();
    const bId = B.e.identity.deviceId;
    await until(() => A.e.btLinked().includes(bId) && B.e.btLinked().includes(A.e.identity.deviceId));
    // Both sides dialled at start: only one link survives on each side.
    await sleep(50);
    expect(A.e.btLinked()).toEqual([bId]);
    expect(A.e.devices().find((d) => d.deviceId === bId)?.reach).toBe('bt');
    expect(await A.e.viaBluetooth(bId)).toBe(true);

    const data = randomBytes(600 * 1024);
    const src = join(tmpDir(), 'over-bt.bin');
    writeFileSync(src, data);
    const res = await A.e.send([bId], [{ kind: 'file', srcPath: src }]);
    expect(res[0]).toMatchObject({ status: 'done' });
    expect(sha(readFileSync(join(B.inbox, 'over-bt.bin')))).toBe(sha(data));

    B.e.setAppHandler(async (peer, msg) => ({ status: 200, body: { peer, msg } }));
    expect(await A.e.appSend(bId, { kind: 'key', key: 'play' })).toEqual({ status: 200, body: { peer: A.e.identity.deviceId, msg: { kind: 'key', key: 'play' } } });

    let got = Buffer.alloc(0);
    B.e.setStreamHandler((s) => {
      s.req.on('data', (d: Buffer) => (got = Buffer.concat([got, d])));
      s.req.on('end', () => s.res.writeHead(200).end());
      return true;
    });
    const body = new PassThrough();
    const status = A.e.streamPost(bId, 'audio', 'audio/opus-rtp; channels=2', body);
    body.end(Buffer.from('opus frames'));
    expect(await status).toBe(200);
    expect(got.toString()).toBe('opus frames');

    // The address map is learnt from HELLO and kept.
    expect(JSON.parse(readFileSync(join(A.home, 'bt-peers.json'), 'utf8'))).toEqual({ 'BB:BB:BB:BB:BB:BB': bId });
    expect(A.events.some((x) => x.source === 'bt' && x.type === 'up' && x.deviceId === bId)).toBe(true);
    expect(await A.e.send('all', [{ kind: 'text', text: 'to all' }])).toMatchObject([{ deviceId: bId, status: 'done' }]);
  });

  it('Wi-Fi only never uses Bluetooth; Bluetooth off closes links', async () => {
    const { A, B } = await makePair();
    await A.e.start();
    await B.e.start();
    const bId = B.e.identity.deviceId;
    await until(() => A.e.btLinked().includes(bId));
    A.e.setLinkPolicy({ bluetooth: true, allBluetooth: false, deviceLinks: { [bId]: 'wifi' } });
    await until(() => !A.e.btLinked().includes(bId));
    expect(A.e.devices().find((d) => d.deviceId === bId)?.reach).toBe('offline');
    expect((await A.e.send([bId], [{ kind: 'text', text: 'x' }]))[0]).toMatchObject({ status: 'failed', error: 'offline' });
    A.e.setLinkPolicy({ bluetooth: false, allBluetooth: false, deviceLinks: {} });
    expect(A.e.linkMode(bId)).toBe('wifi');
  });

  it('a send dials the device on demand when no link is up', async () => {
    const { A, B, air } = await makePair();
    B.radio.away = true;
    await B.e.start();
    await A.e.start();
    const bId = B.e.identity.deviceId;
    expect(A.e.btLinked()).toEqual([]);
    B.radio.away = false;
    const before = air.dials;
    const res = await A.e.send([bId], [{ kind: 'text', text: 'dial me' }]);
    expect(res[0]).toMatchObject({ status: 'done' });
    expect(air.dials).toBeGreaterThan(before);
  });

  it('an on-demand dial joins the start-up dial of the same address, so both sides keep one link', async () => {
    const { A, B } = await makePair();
    await B.e.start(); // its start-up dial finds A not listening yet
    await until(() => B.radio.dialled > 0);
    await A.e.start();
    const bId = B.e.identity.deviceId;
    let got = '';
    B.e.setStreamHandler((s) => {
      s.req.on('data', (d: Buffer) => (got += d));
      s.req.on('end', () => s.res.writeHead(200).end());
      return true;
    });
    // A's start-up pass is still learning who BB is when the user sends sound to B.
    expect(await A.e.viaBluetooth(bId)).toBe(true);
    expect(A.radio.dialled).toBe(1);
    const body = new PassThrough();
    const status = A.e.streamPost(bId, 'audio', 'audio/opus-rtp; channels=2', body);
    body.end(Buffer.from('sound'));
    expect(await status).toBe(200);
    expect(got).toBe('sound');
  });

  it('closes a link whose HELLO names an untrusted device', async () => {
    const { A } = await makePair();
    await A.e.start();
    const strangerHome = tmpDir();
    const S = await Engine.create({ home: strangerHome, inbox: tmpDir(), port: 0, discovery: false, alias: 'x', bt: { platform: new FakeRadio(new Air(), 'CC'), tickMs: 0 } });
    engines.push(S);
    const radio = (A.e as unknown as { opts: EngineOptions }).opts.bt!.platform as FakeRadio;
    const [x, y] = duplexPair();
    const { BtLink } = await import('../src/bt/mux.ts');
    const l = new BtLink(x, { dialer: true, selfId: S.identity.deviceId, meshPort: () => 1 });
    radio.onConn!(y, 'CC:CC:CC:CC:CC:CC');
    await l.ready;
    await until(() => l.closed);
    expect(A.e.btLinked()).toEqual([]);
  });
});

describe('BtLinks policy', () => {
  it('modes follow the switches', () => {
    const p: LinkPolicy = { bluetooth: true, allBluetooth: false, deviceLinks: { b: 'bt', w: 'wifi' } };
    expect([linkMode(p, 'x'), linkMode(p, 'b'), linkMode(p, 'w')]).toEqual(['auto', 'bt', 'wifi']);
    expect(linkMode({ ...p, allBluetooth: true }, 'w')).toBe('bt');
    expect(linkMode({ ...p, bluetooth: false, allBluetooth: true }, 'b')).toBe('wifi');
  });

  it('auto: an idle link closes once the device is back on the LAN; bt mode keeps it', async () => {
    const air = new Air();
    const ids = ['a'.repeat(64), 'b'.repeat(64)];
    let lan = false;
    const mk = (i: number) =>
      new BtLinks({
        platform: new FakeRadio(air, `R${i}`),
        selfId: ids[i]!,
        meshPort: () => 1,
        isTrusted: (id) => id === ids[1 - i],
        trustedIds: () => [ids[1 - i]!],
        onLan: () => lan,
        tickMs: 0,
        idleMs: 30,
      });
    const a = mk(0);
    const b = mk(1);
    await b.start();
    await a.start();
    await until(() => a.linked().length === 1);
    lan = true;
    await a.tick();
    expect(a.linked()).toHaveLength(1); // not idle long enough yet
    await sleep(60);
    await a.tick();
    expect(a.linked()).toHaveLength(0);
    lan = false;
    a.setPolicy({ bluetooth: true, allBluetooth: false, deviceLinks: { [ids[1]!]: 'bt' } });
    await until(() => a.linked().length === 1);
    lan = true;
    await sleep(60);
    await a.tick();
    expect(a.linked()).toHaveLength(1);
    a.stop();
    b.stop();
  });

  it('backs off after a failed dial', async () => {
    const air = new Air();
    const r = new FakeRadio(air, 'R0');
    new FakeRadio(air, 'R1').away = true;
    const links = new BtLinks({ platform: r, selfId: 'a'.repeat(64), meshPort: () => 1, isTrusted: () => true, trustedIds: () => ['b'.repeat(64)], onLan: () => false, tickMs: 0 });
    await links.start(); // start-up probe of the unmapped radio
    expect(await links.ensure('b'.repeat(64))).toBeUndefined();
    const n = air.dials;
    expect(n).toBe(1); // the on-demand dial joined the start-up probe of the same address
    expect(await links.ensure('b'.repeat(64))).toBeUndefined();
    await links.tick();
    expect(air.dials).toBe(n);
    links.stop();
  });
});
