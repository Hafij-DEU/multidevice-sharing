// LAN discovery: UDP multicast announces + manual/scan probe over TLS.
//
// TRUST MODEL: an announce is an UNAUTHENTICATED HINT. Anyone on the LAN can send one claiming any
// deviceId, alias or port; the only thing it buys an attacker is a bogus entry in the peer list.
// Trust and identity are never derived from an announce: they are established at connect time by
// pinning the peer's TLS certificate to its deviceId (see tls.ts `connectPinned`) and by the
// TrustStore. The `host` of a peer entry is the UDP source address of the packet, never a field
// inside it. `probe` is the one place a deviceId comes from evidence: the certificate itself.
import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';
import type { TLSSocket } from 'node:tls';
import { deviceIdOf } from './identity.ts';

export type DeviceType = 'desktop' | 'mobile' | 'headless';

export interface Announce {
  v: 1;
  deviceId: string;
  alias: string;
  deviceType: DeviceType;
  port: number;
}

export type PeerInfo = Announce & {
  host: string;
  lastSeen: number;
  /** Added via probe(): exempt from TTL expiry; removed only by forget() or stop(). */
  manual?: boolean;
};

export interface DiscoveryOptions {
  self: Announce;
  /** Multicast group (default 224.0.0.168). */
  group?: string;
  /** UDP port, for both listening and announcing (default 53318). */
  port?: number;
  /** Announce period (default 5000 ms). */
  intervalMs?: number;
  /** A peer not heard from for this long is 'lost' (default 15000 ms). */
  ttlMs?: number;
  /** Local IPv4 address of the one interface to use. Default: every non-internal IPv4 interface. */
  iface?: string;
  /** Devices we trust are always admitted to a full peer table (an untrusted entry makes room). */
  isTrusted?: (deviceId: string) => boolean;
  /** False: only listen (a client next to a listener that announces for this device). Default true. */
  announce?: boolean;
}

export interface ProbeOptions {
  /** Overall budget for connect + handshake + response (default 5000 ms). */
  timeoutMs?: number;
}

const DEFAULT_GROUP = '224.0.0.168';
/** UDP announce port. */
const DEFAULT_DISCOVERY_PORT = 53318;
/** TCP mesh HTTPS port, the default target of `probe`. */
export const DEFAULT_MESH_PORT = 53318;
const MAX_ANNOUNCE_BYTES = 1024;
const MAX_PEERS = 256;
export const MAX_ALIAS_CHARS = 64;
/** An info response is a ~100-byte JSON object; a scan target must not make us buffer more. */
const MAX_INFO_BYTES = 4096;
const DEVICE_ID_RE = /^[0-9a-f]{64}$/;
const DEVICE_TYPES: readonly string[] = ['desktop', 'mobile', 'headless'];

const isDeviceId = (x: unknown): x is string => typeof x === 'string' && DEVICE_ID_RE.test(x);
const isAlias = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_ALIAS_CHARS;
const isDeviceType = (x: unknown): x is DeviceType => typeof x === 'string' && DEVICE_TYPES.includes(x);
const isPort = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535;

/** Strict validation of an announce payload; null for anything that is not exactly well-formed. */
function parseAnnounce(buf: Buffer): Announce | null {
  if (buf.length > MAX_ANNOUNCE_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o['v'] !== 1) return null;
  if (!isDeviceId(o['deviceId']) || !isAlias(o['alias']) || !isDeviceType(o['deviceType']) || !isPort(o['port'])) return null;
  return { v: 1, deviceId: o['deviceId'], alias: o['alias'], deviceType: o['deviceType'], port: o['port'] };
}

interface Sender {
  addr: string;
  sock: Socket;
  ready: boolean;
}

interface Running {
  recv: Socket;
  senders: Sender[];
  announceTimer: NodeJS.Timeout;
  sweepTimer: NodeJS.Timeout;
}

export class Discovery extends EventEmitter {
  private readonly self: Announce;
  private readonly group: string;
  private readonly port: number;
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private readonly announce: boolean;
  private readonly iface: string | undefined;
  private readonly table = new Map<string, PeerInfo>();
  private running: Running | null = null;

  private readonly isTrusted: ((deviceId: string) => boolean) | undefined;

  constructor(opts: DiscoveryOptions) {
    super();
    const s = opts.self;
    if (s.v !== 1 || !isDeviceId(s.deviceId) || !isAlias(s.alias) || !isDeviceType(s.deviceType) || !isPort(s.port)) {
      throw new Error('invalid self announce');
    }
    this.self = { v: 1, deviceId: s.deviceId, alias: s.alias, deviceType: s.deviceType, port: s.port };
    this.group = opts.group ?? DEFAULT_GROUP;
    this.port = opts.port ?? DEFAULT_DISCOVERY_PORT;
    this.intervalMs = opts.intervalMs ?? 5000;
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.announce = opts.announce ?? true;
    this.iface = opts.iface;
    this.isTrusted = opts.isTrusted;
  }

  /** Socket-level failures never throw: they surface as 'error' only if someone is listening. */
  private fail(err: unknown): void {
    if (this.listenerCount('error') === 0) return;
    try {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* a throwing listener must not take down the socket callback */
    }
  }

  private interfaceAddrs(): string[] {
    if (this.iface !== undefined) return [this.iface];
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === 'IPv4' && !a.internal && !out.includes(a.address)) out.push(a.address);
      }
    }
    return out;
  }

  /** Starts listening and announcing. No-op if already started. */
  start(): void {
    if (this.running) return;
    const addrs = this.interfaceAddrs();

    const recv = createSocket({ type: 'udp4', reuseAddr: true });
    recv.on('error', (e) => this.fail(e));
    recv.on('message', (msg, rinfo) => this.onPacket(msg, rinfo.address));
    recv.bind(this.port, () => {
      if (this.running?.recv !== recv) return; // stopped while binding
      for (const addr of addrs) {
        try {
          recv.addMembership(this.group, addr);
        } catch (e) {
          this.fail(e); // e.g. ENODEV / EADDRNOTAVAIL: other interfaces still work
        }
      }
    });

    // One send socket per interface, bound to that interface's address, so every interface gets
    // its own copy of the announce regardless of the host's multicast routing.
    const senders: Sender[] = (this.announce ? addrs : []).map((addr) => {
      const sock = createSocket({ type: 'udp4', reuseAddr: true });
      const sender: Sender = { addr, sock, ready: false };
      sock.on('error', (e) => {
        sender.ready = false;
        this.fail(e);
      });
      try {
        sock.bind(0, addr, () => {
          try {
            sock.setMulticastInterface(addr);
            sock.setMulticastTTL(1); // link-local only
            sock.setMulticastLoopback(true); // same-host peers (and the tests) hear us
            sender.ready = true;
            this.sendOne(sender);
          } catch (e) {
            this.fail(e);
          }
        });
      } catch (e) {
        this.fail(e);
      }
      return sender;
    });

    const announceTimer = setInterval(() => {
      for (const s of senders) this.sendOne(s);
    }, this.intervalMs);
    announceTimer.unref(); // a forgotten stop() must not hold the process open
    const sweepTimer = setInterval(() => this.sweep(), Math.min(1000, Math.max(25, Math.floor(this.ttlMs / 4))));
    sweepTimer.unref();
    this.running = { recv, senders, announceTimer, sweepTimer };
  }

  /** Stops announcing and listening and forgets all peers (silently, without 'lost'). Idempotent. */
  stop(): void {
    const r = this.running;
    if (!r) return;
    this.running = null;
    clearInterval(r.announceTimer);
    clearInterval(r.sweepTimer);
    for (const sock of [r.recv, ...r.senders.map((s) => s.sock)]) {
      sock.removeAllListeners('message');
      sock.on('error', () => {}); // late errors from a closing socket
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    }
    this.table.clear();
  }

  peers(): PeerInfo[] {
    return [...this.table.values()].map((p) => ({ ...p }));
  }

  private sendOne(s: Sender): void {
    if (!s.ready || this.running === null) return;
    try {
      s.sock.send(JSON.stringify(this.self), this.port, this.group, (err) => {
        if (err) this.fail(err);
      });
    } catch (e) {
      this.fail(e);
    }
  }

  private onPacket(msg: Buffer, host: string): void {
    const a = parseAnnounce(msg);
    if (!a) return;
    this.observe(a, host);
  }

  /**
   * Records a sighting. Returns false only when the peer was dropped because the table is full.
   * Emits 'peer' for a new peer or when host/port/alias/deviceType changed, not on plain refreshes.
   */
  private observe(a: Announce, host: string, manual = false): boolean {
    if (a.deviceId === this.self.deviceId) return true;
    const now = Date.now();
    const cur = this.table.get(a.deviceId);
    if (!cur && this.table.size >= MAX_PEERS) {
      // A full table never takes an untrusted newcomer; a trusted one replaces the oldest untrusted,
      // non-manual entry (so a flood of forged announces cannot hide our own devices).
      if (!this.isTrusted?.(a.deviceId)) return false;
      let victim: PeerInfo | undefined;
      for (const p of this.table.values()) {
        if (p.manual || this.isTrusted?.(p.deviceId)) continue;
        if (!victim || p.lastSeen < victim.lastSeen) victim = p;
      }
      if (!victim) return false;
      this.table.delete(victim.deviceId);
      this.emitSafe('lost', { ...victim });
    }
    // A manual peer's address was verified by its certificate when probed: an (unauthenticated)
    // announce refreshes it but never moves it.
    const keepAddr = cur?.manual === true && !manual;
    const next: PeerInfo = {
      v: 1,
      deviceId: a.deviceId,
      alias: a.alias,
      deviceType: a.deviceType,
      port: keepAddr ? cur.port : a.port,
      host: keepAddr ? cur.host : host,
      lastSeen: now,
    };
    // An announce for a manually added peer refreshes it but never demotes it back to expiring.
    if (manual || cur?.manual) next.manual = true;
    this.table.set(a.deviceId, next);
    // Also report a peer seen again after a silence longer than the TTL (a manual peer never
    // expires, so this is the only sign that it came back).
    const changed =
      !cur || cur.host !== next.host || cur.port !== next.port || cur.alias !== a.alias || cur.deviceType !== a.deviceType ||
      now - cur.lastSeen > this.ttlMs;
    if (changed) this.emitSafe('peer', { ...next });
    return true;
  }

  /** Removes a peer (announced or manual) and emits 'lost' for it. Unknown ids are ignored. */
  forget(deviceId: string): void {
    const p = this.table.get(deviceId);
    if (!p) return;
    this.table.delete(deviceId);
    this.emitSafe('lost', { ...p });
  }

  private emitSafe(event: 'peer' | 'lost', p: PeerInfo): void {
    try {
      this.emit(event, p);
    } catch {
      /* a throwing listener must not break the socket callback or the sweep */
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, p] of this.table) {
      if (!p.manual && p.lastSeen < cutoff) {
        this.table.delete(id);
        this.emitSafe('lost', { ...p });
      }
    }
  }

  /**
   * Asks `host:port` (default TCP 53318) for `GET /mesh/v1/info` over TLS 1.3 WITHOUT pinning (we
   * do not know the device yet) and without presenting our own certificate (a scan must not tell
   * every host it touches who we are). The peer's deviceId is the SHA-256 of the certificate it
   * presented, never what the JSON says; if the JSON disagrees, or anything is malformed, this
   * rejects and nothing is emitted. On success the peer is entered in the table (so a re-probe
   * of an unchanged peer only refreshes it) and 'peer' is emitted if it is new or changed.
   * Probed peers are `manual`: exempt from TTL expiry (nothing would refresh them) until `forget()`
   * or `stop()`; this works on a Discovery that was never started.
   * A probe that lands on our own device resolves without emitting anything.
   */
  probe(host: string, port: number = DEFAULT_MESH_PORT, opts: ProbeOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    if (!isPort(port)) return Promise.reject(new Error(`probe: invalid port ${String(port)}`));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let req: ClientRequest | undefined;
      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        req?.destroy();
        if (err) reject(err);
        else resolve();
      };

      try {
        req = httpsRequest({
          host,
          port,
          method: 'GET',
          path: '/mesh/v1/info',
          agent: false, // fresh connection, Connection: close
          minVersion: 'TLSv1.3',
          // Self-signed peers: CA/hostname validation cannot succeed. We take the certificate as the
          // evidence of identity instead (deviceIdOf below) and pin it at real connect time.
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
          headers: { accept: 'application/json' },
        });
      } catch (e) {
        return finish(e as Error); // e.g. a bad host string: nothing was created, no timer armed
      }
      timer = setTimeout(() => finish(new Error(`probe of ${host}:${port} timed out after ${timeoutMs} ms`)), timeoutMs);
      req.on('error', (e) => finish(e));
      req.on('response', (res) => {
        res.on('error', (e) => finish(e));
        if (res.statusCode !== 200) return finish(new Error(`probe: HTTP ${res.statusCode ?? 0} from ${host}:${port}`));
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > MAX_INFO_BYTES) return finish(new Error('probe: info response too large'));
          parts.push(d);
        });
        res.on('end', () => {
          try {
            this.acceptInfo(res.socket as TLSSocket, Buffer.concat(parts), host, port);
            finish(null);
          } catch (e) {
            finish(e as Error);
          }
        });
      });
      req.end();
    });
  }

  private acceptInfo(sock: TLSSocket, body: Buffer, host: string, port: number): void {
    const cert = sock.getPeerCertificate(true);
    if (!cert || !cert.raw || cert.raw.length === 0) throw new Error('probe: peer presented no certificate');
    const deviceId = deviceIdOf(cert.raw);

    let j: unknown;
    try {
      j = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Error('probe: info is not valid JSON');
    }
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('probe: info is not an object');
    const o = j as Record<string, unknown>;
    if (o['v'] !== 1) throw new Error('probe: unsupported info version');
    if (o['deviceId'] !== deviceId) throw new Error('probe: info deviceId does not match the peer certificate');
    if (!isAlias(o['alias'])) throw new Error('probe: invalid alias');
    if (!isDeviceType(o['deviceType'])) throw new Error('probe: invalid deviceType');

    const ok = this.observe({ v: 1, deviceId, alias: o['alias'], deviceType: o['deviceType'], port }, host, true);
    if (!ok) throw new Error('probe: peer table is full');
  }
}
