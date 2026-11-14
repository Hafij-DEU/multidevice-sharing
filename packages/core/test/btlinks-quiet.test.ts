// Bluetooth links stay off the radio while this device plays sound to Bluetooth headphones, back off
// far for a device that is away, and dial at once when that device connects again. Paging a device
// that is away holds the radio for seconds; on an Intel AX201 that stalled A2DP and dropped the headset.
import { duplexPair, type Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BtLinks, DEFAULT_BACKOFF_MS, type BtPlatform } from '../src/bt/links.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}

class Air {
  readonly radios = new Map<string, Radio>();
  dials = 0;
}

class Radio implements BtPlatform {
  onConn: ((c: Duplex, a: string) => void) | null = null;
  away = false;
  quietNow = false;
  connectedCb: ((address: string) => void) | null = null;
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
  quiet() {
    return this.quietNow;
  }
  onConnected(cb: (address: string) => void) {
    this.connectedCb = cb;
  }
}

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('BtLinks and Bluetooth audio', () => {
  it('backs off to 15 min by default, so a phone that is off is paged rarely', () => {
    expect(DEFAULT_BACKOFF_MS).toEqual([10_000, 900_000]);
  });

  it('pages no device while sound plays to Bluetooth headphones; a dial the user asks for still runs', async () => {
    const air = new Air();
    const r = new Radio(air, 'R0');
    new Radio(air, 'R1').away = true;
    r.quietNow = true;
    const links = new BtLinks({ platform: r, selfId: A, meshPort: () => 1, isTrusted: () => true, trustedIds: () => [B], onLan: () => false, tickMs: 0, backoffMs: [1, 1] });
    await links.start();
    await links.tick();
    expect(air.dials).toBe(0);
    expect(await links.ensure(B)).toBeUndefined();
    expect(air.dials).toBe(1);
    r.quietNow = false;
    await sleep(5);
    await links.tick();
    expect(air.dials).toBe(2);
    links.stop();
  });

  it('dials a device in backoff at once when it connects over Bluetooth', async () => {
    const air = new Air();
    const ids = [A, B];
    const ra = new Radio(air, 'R0');
    const rb = new Radio(air, 'R1');
    const opts = (i: number, dialOut: boolean) => ({
      selfId: ids[i]!,
      meshPort: () => 1,
      isTrusted: (id: string) => id === ids[1 - i],
      trustedIds: () => (dialOut ? [ids[1 - i]!] : []),
      onLan: () => false,
      tickMs: 0,
      connectedDelayMs: 0,
      backoffMs: [60_000, 60_000] as [number, number],
    });
    const a = new BtLinks({ platform: ra, ...opts(0, true) });
    const b = new BtLinks({ platform: rb, ...opts(1, true) });
    await b.start();
    await a.start();
    await until(() => a.linked().length === 1);
    b.stop(); // the phone goes away (a fake stream pair does not pass the close on, so drop A's end too)
    a.link(B)!.close();
    await until(() => a.linked().length === 0);
    await a.tick(); // fails: now in a 60 s backoff
    const n = air.dials;
    // the phone is back, listening only
    const b2 = new BtLinks({ platform: rb, ...opts(1, false) });
    await b2.start();
    await a.tick();
    expect(air.dials).toBe(n);
    expect(a.linked()).toHaveLength(0);
    ra.connectedCb!('r1'); // BlueZ: it connected (any profile)
    await until(() => a.linked().length === 1);
    a.stop();
    b2.stop();
  });

  it('ignores a connect from a device that is linked already or on the LAN', async () => {
    const air = new Air();
    const r = new Radio(air, 'R0');
    new Radio(air, 'R1').away = true;
    const links = new BtLinks({ platform: r, selfId: A, meshPort: () => 1, isTrusted: () => true, trustedIds: () => [B], onLan: () => true, tickMs: 0, connectedDelayMs: 0 });
    await links.start();
    const n = air.dials;
    r.connectedCb!('R1'); // unmapped: probed once to learn who it is
    await until(() => air.dials === n + 1);
    links.stop();
  });
});
