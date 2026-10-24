// LocalSend v2 discovery (M6): UDP multicast JSON on 224.0.0.167:53317. A peer's announce is answered
// through its /register endpoint (falling back to a multicast reply with announce:false), as LocalSend
// does. Peers are kept by fingerprint and forgotten after `ttlMs` of silence.
import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import type { LsInfo } from './server.ts';

export const LS_GROUP = '224.0.0.167';
export const LS_PORT = 53317;

export interface LsPeerInfo {
  alias: string;
  fingerprint: string;
  deviceModel?: string;
  deviceType?: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  lastSeen: number;
}

export interface LocalSendDiscoveryOptions {
  self: () => LsInfo;
  group?: string;
  port?: number;
  /** One interface address (tests: 127.0.0.1); default all non-internal IPv4. */
  iface?: string;
  ttlMs?: number;
  intervalMs?: number;
  /** Answers a peer's announce over HTTP(S); false when that failed (then we reply by multicast). */
  register?: (peer: LsPeerInfo) => Promise<boolean>;
}

export function parseAnnounce(msg: Buffer | string, host: string, now: number): (LsPeerInfo & { announce: boolean }) | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(msg.toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
  const alias = s(j.alias, 128);
  const fingerprint = s(j.fingerprint, 256);
  if (!alias || !fingerprint || typeof j.version !== 'string' || !j.version.startsWith('2')) return null;
  const port = Number.isInteger(j.port) && (j.port as number) > 0 && (j.port as number) < 65536 ? (j.port as number) : LS_PORT;
  return {
    alias, fingerprint, host, port, protocol: j.protocol === 'http' ? 'http' : 'https', lastSeen: now, announce: j.announce === true || j.announcement === true,
    ...(s(j.deviceModel, 128) ? { deviceModel: j.deviceModel as string } : {}),
    ...(s(j.deviceType, 32) ? { deviceType: j.deviceType as string } : {}),
  };
}

export class LocalSendDiscovery extends EventEmitter {
  readonly #o: LocalSendDiscoveryOptions;
  readonly #peers = new Map<string, LsPeerInfo>();
  #recv: Socket | null = null;
  #senders: Socket[] = [];
  #timer: NodeJS.Timeout | null = null;

  constructor(o: LocalSendDiscoveryOptions) {
    super();
    this.#o = o;
  }

  get #group() {
    return this.#o.group ?? LS_GROUP;
  }

  get #port() {
    return this.#o.port ?? LS_PORT;
  }

  #addrs(): string[] {
    if (this.#o.iface) return [this.#o.iface];
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !out.includes(a.address)) out.push(a.address);
    return out;
  }

  peers(): LsPeerInfo[] {
    const now = Date.now();
    for (const [k, p] of this.#peers) if (now - p.lastSeen > (this.#o.ttlMs ?? 60_000)) this.#peers.delete(k);
    return [...this.#peers.values()].map((p) => ({ ...p }));
  }

  peer(fingerprint: string): LsPeerInfo | undefined {
    return this.peers().find((p) => p.fingerprint === fingerprint);
  }

  /** A peer that registered with us over HTTP(S). */
  seen(p: LsPeerInfo): void {
    if (p.fingerprint === this.#o.self().fingerprint) return;
    const fresh = !this.#peers.has(p.fingerprint);
    this.#peers.set(p.fingerprint, p);
    if (fresh) this.emit('peer', { ...p });
  }

  #message(msg: Buffer, host: string): void {
    const p = parseAnnounce(msg, host, Date.now());
    if (!p || p.fingerprint === this.#o.self().fingerprint) return;
    const { announce, ...peer } = p;
    this.seen(peer);
    if (!announce) return;
    void (async () => {
      const ok = this.#o.register ? await this.#o.register(peer).catch(() => false) : false;
      if (!ok) this.#send(false);
    })();
  }

  #send(announce: boolean): void {
    const msg = Buffer.from(JSON.stringify({ ...this.#o.self(), announce, announcement: announce }));
    for (const s of this.#senders) s.send(msg, this.#port, this.#group, () => {});
  }

  start(): void {
    if (this.#recv) return;
    const addrs = this.#addrs();
    const recv = createSocket({ type: 'udp4', reuseAddr: true });
    recv.on('error', (e) => this.emit('error', e));
    recv.on('message', (m, r) => this.#message(m, r.address));
    recv.bind(this.#port, () => {
      for (const a of addrs) {
        try {
          recv.addMembership(this.#group, a);
        } catch {
          /* that interface cannot join */
        }
      }
    });
    this.#recv = recv;
    this.#senders = addrs.map((a) => {
      const s = createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {});
      s.bind(0, a, () => {
        try {
          s.setMulticastInterface(a);
          s.setMulticastTTL(1);
          s.setMulticastLoopback(true);
          s.send(Buffer.from(JSON.stringify({ ...this.#o.self(), announce: true, announcement: true })), this.#port, this.#group, () => {});
        } catch {
          /* not on this interface */
        }
      });
      return s;
    });
    this.#timer = setInterval(() => this.#send(true), this.#o.intervalMs ?? 30_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#recv?.close();
    this.#recv = null;
    for (const s of this.#senders) s.close();
    this.#senders = [];
  }
}
