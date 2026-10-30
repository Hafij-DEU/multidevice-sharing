// Bluetooth link manager (M14): which trusted devices get a Bluetooth link, when to dial them, and
// the address <-> device map learned from HELLO. The platform (BlueZ helper on the PC, RFCOMM on
// Android) only hands over byte streams; everything above that is here and in mux.ts.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { writeFileAtomic } from '../trust.ts';
import { BtLink } from './mux.ts';

/** A paired device that offers the MeshDrop service. */
export interface BtBonded { address: string; name: string }

/** What a platform gives the link manager: paired devices, outgoing and incoming RFCOMM byte streams. */
export interface BtPlatform {
  bonded(): Promise<BtBonded[]>;
  /** Rejects when the device is away or does not answer. */
  dial(address: string): Promise<Duplex>;
  /** Starts accepting; `onConn` gets every authenticated incoming connection. */
  listen(onConn: (conn: Duplex, address: string) => void): Promise<void>;
  stop(): void;
}

/** Per device: Auto (LAN, else Bluetooth, else hub), Wi-Fi only, or Bluetooth only. */
export type LinkMode = 'auto' | 'wifi' | 'bt';

export interface LinkPolicy {
  /** Master switch (default on). Off: no Bluetooth at all. */
  bluetooth: boolean;
  /** Every device as 'bt'. */
  allBluetooth: boolean;
  deviceLinks: Record<string, LinkMode>;
}

export const DEFAULT_LINK_POLICY: LinkPolicy = { bluetooth: true, allBluetooth: false, deviceLinks: {} };

/** The policy's mode for one device ('wifi' whenever Bluetooth is off). */
export function linkMode(p: LinkPolicy, deviceId: string): LinkMode {
  if (!p.bluetooth) return 'wifi';
  if (p.allBluetooth) return 'bt';
  return p.deviceLinks[deviceId] ?? 'auto';
}

export interface BtLinksOptions {
  platform: BtPlatform;
  selfId: string;
  meshPort: () => number;
  isTrusted: (deviceId: string) => boolean;
  /** Trusted devices the manager may keep links to. */
  trustedIds: () => string[];
  /** Whether discovery sees the device on the LAN now. */
  onLan: (deviceId: string) => boolean;
  /** bt-peers.json (address -> deviceId), or undefined to keep the map in memory only. */
  file?: string;
  /** Dial backoff per device (default 10 s doubling to 2 min). */
  backoffMs?: [number, number];
  /** An idle link to a device back on the LAN closes after this long (default 60 s). */
  idleMs?: number;
  /** Background policy pass interval (default 10 s); 0: only on tick(). */
  tickMs?: number;
  pingMs?: number;
}

interface DialState { failures: number; lastFail: number; inflight?: Promise<BtLink | undefined> }

/**
 * Keeps Bluetooth links to trusted devices per the policy. Events: 'up' (deviceId), 'down' (deviceId).
 */
export class BtLinks extends EventEmitter {
  readonly #o: BtLinksOptions;
  #policy: LinkPolicy = DEFAULT_LINK_POLICY;
  readonly #links = new Map<string, BtLink>();
  /** address -> deviceId, learned from HELLO. */
  readonly #addrs = new Map<string, string>();
  readonly #dials = new Map<string, DialState>();
  /** Bonded addresses not mapped yet: when we last tried to learn who they are. */
  readonly #probed = new Map<string, number>();
  /** When the device was last seen back on the LAN while it had a Bluetooth link. */
  readonly #lanSince = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(o: BtLinksOptions) {
    super();
    this.#o = o;
    if (o.file) {
      try {
        const j = JSON.parse(readFileSync(o.file, 'utf8')) as Record<string, unknown>;
        for (const [a, id] of Object.entries(j)) if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) this.#addrs.set(a, id);
      } catch {
        /* none yet */
      }
    }
  }

  async start(): Promise<void> {
    await this.#o.platform.listen((conn, address) => this.#adopt(conn, address, false));
    const every = this.#o.tickMs ?? 10_000;
    if (every > 0) {
      this.#timer = setInterval(() => void this.tick(), every);
      this.#timer.unref();
    }
    void this.tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#o.platform.stop();
    for (const l of this.#links.values()) l.close();
    this.#links.clear();
  }

  setPolicy(p: LinkPolicy): void {
    this.#policy = { bluetooth: p.bluetooth, allBluetooth: p.allBluetooth, deviceLinks: { ...p.deviceLinks } };
    for (const [id, l] of this.#links) if (this.mode(id) === 'wifi') l.close();
    void this.tick();
  }

  get policy(): LinkPolicy {
    return this.#policy;
  }

  mode(deviceId: string): LinkMode {
    return linkMode(this.#policy, deviceId);
  }

  /** The ready link to a device, if there is one. */
  link(deviceId: string): BtLink | undefined {
    const l = this.#links.get(deviceId);
    return l && !l.closed && l.ports ? l : undefined;
  }

  /** Devices with a ready link now. */
  linked(): string[] {
    return [...this.#links.keys()].filter((id) => this.link(id));
  }

  /** Bluetooth address last used for a device. */
  addressOf(deviceId: string): string | undefined {
    for (const [a, id] of this.#addrs) if (id === deviceId) return a;
    return undefined;
  }

  /**
   * A ready link to the device, dialling it now if needed (within `timeoutMs`). Undefined when the
   * device is in Wi-Fi mode, has no known address, or does not answer.
   */
  async ensure(deviceId: string, timeoutMs = 8000): Promise<BtLink | undefined> {
    if (this.#stopped || this.mode(deviceId) === 'wifi' || !this.#o.isTrusted(deviceId)) return undefined;
    const have = this.link(deviceId);
    if (have) return have;
    const st = this.#dials.get(deviceId);
    // A user action may dial again sooner than the background backoff, but not in a tight loop.
    if (st && !st.inflight && st.failures > 0 && Date.now() - st.lastFail < this.#backoff(1)) return undefined;
    return this.#withTimeout(this.#dial(deviceId), timeoutMs);
  }

  /** One policy pass: dial what should be up, close idle links to devices back on the LAN. */
  async tick(): Promise<void> {
    if (this.#stopped || !this.#policy.bluetooth) return;
    const now = Date.now();
    const idleMs = this.#o.idleMs ?? 60_000;
    for (const [id, l] of this.#links) {
      if (this.mode(id) !== 'auto' || !this.#o.onLan(id)) {
        this.#lanSince.delete(id);
        continue;
      }
      const since = this.#lanSince.get(id) ?? now;
      this.#lanSince.set(id, since);
      if (l.streams === 0 && now - since >= idleMs && now - l.lastActive >= idleMs) l.close();
    }
    const want = this.#o.trustedIds().filter((id) => !this.link(id) && (this.mode(id) === 'bt' || (this.mode(id) === 'auto' && !this.#o.onLan(id))));
    if (want.length === 0) return;
    const jobs: Promise<unknown>[] = [];
    for (const id of want) {
      const st = this.#dials.get(id);
      if (st?.inflight || (st && st.failures > 0 && now - st.lastFail < this.#backoff(st.failures))) continue;
      if (this.addressOf(id)) jobs.push(this.#dial(id));
    }
    // Paired devices we have not linked yet: dial each once in a while to learn which device it is.
    if (want.some((id) => !this.addressOf(id))) jobs.push(this.#learn(now));
    await Promise.allSettled(jobs);
  }

  #backoff(failures: number): number {
    const [lo, hi] = this.#o.backoffMs ?? [10_000, 120_000];
    return Math.min(hi, lo * 2 ** Math.max(0, failures - 1));
  }

  async #learn(now: number): Promise<void> {
    let bonded: BtBonded[];
    try {
      bonded = await this.#o.platform.bonded();
    } catch {
      return;
    }
    const every = (this.#o.backoffMs ?? [10_000, 120_000])[1];
    for (const b of bonded) {
      if (this.#addrs.has(b.address) || now - (this.#probed.get(b.address) ?? 0) < every) continue;
      this.#probed.set(b.address, now);
      try {
        await this.#adopt(await this.#o.platform.dial(b.address), b.address, true);
      } catch {
        /* away, or not a MeshDrop device */
      }
    }
  }

  #dial(deviceId: string): Promise<BtLink | undefined> {
    const st: DialState = this.#dials.get(deviceId) ?? { failures: 0, lastFail: 0 };
    this.#dials.set(deviceId, st);
    if (st.inflight) return st.inflight;
    const run = async (): Promise<BtLink | undefined> => {
      const tried = new Set<string>();
      const known = this.addressOf(deviceId);
      const candidates: string[] = known ? [known] : [];
      if (!known) {
        try {
          for (const b of await this.#o.platform.bonded()) if (!this.#addrs.has(b.address)) candidates.push(b.address);
        } catch {
          /* adapter off */
        }
      }
      for (const a of candidates) {
        if (tried.has(a)) continue;
        tried.add(a);
        try {
          const l = await this.#adopt(await this.#o.platform.dial(a), a, true);
          if (l && l.peerId === deviceId) return l;
        } catch {
          /* try the next one */
        }
        if (this.link(deviceId)) return this.link(deviceId);
      }
      return this.link(deviceId);
    };
    st.inflight = run().then(
      (l) => {
        st.inflight = undefined;
        if (l) st.failures = 0;
        else Object.assign(st, { failures: st.failures + 1, lastFail: Date.now() });
        return l;
      },
      () => {
        st.inflight = undefined;
        Object.assign(st, { failures: st.failures + 1, lastFail: Date.now() });
        return undefined;
      },
    );
    return st.inflight;
  }

  /** Runs a btmux link on a fresh connection; resolves once HELLO named a trusted device (or undefined). */
  async #adopt(conn: Duplex, address: string, dialer: boolean): Promise<BtLink | undefined> {
    conn.on('error', () => {});
    if (this.#stopped) {
      conn.destroy();
      return undefined;
    }
    const l = new BtLink(conn, { dialer, selfId: this.#o.selfId, meshPort: this.#o.meshPort, ...(this.#o.pingMs ? { pingMs: this.#o.pingMs } : {}) });
    let peer: string;
    try {
      peer = await this.#withTimeout(l.ready, 15_000, true);
    } catch {
      l.close();
      return undefined;
    }
    // The HELLO id is a claim: the TLS inside the tunnel proves it. It only maps the address.
    if (peer === this.#o.selfId || !this.#o.isTrusted(peer) || this.mode(peer) === 'wifi') {
      l.close();
      return undefined;
    }
    if (this.#addrs.get(address) !== peer) {
      for (const [a, id] of this.#addrs) if (id === peer) this.#addrs.delete(a);
      this.#addrs.set(address, peer);
      this.#save();
    }
    const cur = this.link(peer);
    if (cur && cur !== l) {
      // Both sides dialled at once: keep the link dialled by the device with the lower id, so both
      // sides drop the same one. The same dialler twice: the older link is stale.
      const dialerOf = (x: BtLink) => (x.mux.dialer ? this.#o.selfId : peer);
      const keepNew = dialerOf(l) === dialerOf(cur) || dialerOf(l) < dialerOf(cur);
      if (!keepNew) {
        l.close();
        return cur;
      }
      this.#links.delete(peer);
      cur.close();
    }
    this.#links.set(peer, l);
    l.once('close', () => {
      if (this.#links.get(peer) !== l) return;
      this.#links.delete(peer);
      this.#lanSince.delete(peer);
      this.emit('down', peer);
    });
    this.emit('up', peer);
    return l;
  }

  #save(): void {
    if (!this.#o.file) return;
    try {
      writeFileAtomic(this.#o.file, JSON.stringify(Object.fromEntries(this.#addrs)));
    } catch {
      /* the map is relearnt on the next link */
    }
  }

  #withTimeout<T>(p: Promise<T>, ms: number, reject = false): Promise<T> {
    return new Promise<T>((resolve, rej) => {
      const t = setTimeout(() => (reject ? rej(new Error('timeout')) : resolve(undefined as T)), ms);
      t.unref();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(t);
          rej(e as Error);
        },
      );
    });
  }
}
