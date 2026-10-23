// Hub side of the device link (protocol v1): authenticated WebSocket on /mesh/v1/hub, the
// registry of online devices, the device directory, and the membership authority (the hub signs
// every list change with the mesh root key and pushes it to online members).
//
// Handshake (JSON text frames; any deviation, or no auth within authTimeoutMs, closes 4401):
//   hub    → {t:'hello', v:1, hub, nonce}
//   device → {t:'auth', deviceId, cert, nonce, sig, lan, mv}
//            sig = signDomain('meshdrop-hub-auth-v1', hub + '\0' + deviceId + '\0' + hubNonce, deviceKey)
//   hub    → {t:'welcome', sig, membership?, directory}
//            sig = signDomain('meshdrop-hub-auth-v1', 'hub\0' + deviceId + '\0' + deviceNonce, hubDeviceKey)
// Close codes: 4401 authentication failed, 4403 revoked or not a member, 4409 replaced by a newer link.
import { X509Certificate, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { MAX_OFFER_BODY } from '../api/handler.ts';
import { deviceIdOf, type Identity } from '../identity.ts';
import { signDomain, verifyDomain } from '../mesh/canonical.ts';
import { decodeFrame, encodeFrame, openEnvelope, sealEnvelope, type Envelope } from '../mesh/envelope.ts';
import type { MembershipStore } from '../mesh/members.ts';
import { signList, type Member, type MembershipList, type SignedMembership } from '../mesh/membership.ts';
import { peerDeviceId } from '../tls.ts';
import { canonicalSpki } from '../trust.ts';

export const HUB_AUTH_DOMAIN = 'meshdrop-hub-auth-v1';
export const HUB_PATH = '/mesh/v1/hub';
export const DEFAULT_INGRESS_PORT = 53319;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 510_000;
export const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
export const MAX_FRAME_BYTES = MAX_OFFER_BODY + 64 * 1024;
export const CLOSE_AUTH = 4401;
export const CLOSE_REVOKED = 4403;
export const CLOSE_REPLACED = 4409;
const MAX_LAN_ADDRS = 8;

export interface LanAddr { host: string; port: number }
export interface DirectoryEntry { deviceId: string; online: boolean; lastSeen: number; lanAddrs: LanAddr[] }

export interface HubServerOptions {
  id: Identity;
  home: string;
  rootKey: KeyObject;
  /** The hub's own view of the mesh; every list change goes through accept(). */
  members: MembershipStore;
  /** A link with no traffic for this long is dropped (default 510 000 ms). */
  heartbeatTimeoutMs?: number;
  /** Time allowed between hello and a valid auth (default 10 000 ms). */
  authTimeoutMs?: number;
  /** The hub's own LAN addresses, shown in the directory. */
  hubLan?: () => LanAddr[];
  /** A relayed request the target does not answer within this is failed with 504 (default 600 000 ms). */
  relayTimeoutMs?: number;
  /** Observes every frame the hub forwards (tests, diagnostics). */
  onRelay?: (frame: Buffer) => void;
  now?: () => number;
}

export const DEFAULT_RELAY_TIMEOUT_MS = 600_000;

interface Relay { from: string; to: string; timer: NodeJS.Timeout }

interface Conn {
  ws: WebSocket;
  deviceId: string | null;
  lastSeen: number;
}

const DEVICE_ID_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseLan(v: unknown): LanAddr[] | null {
  if (!Array.isArray(v) || v.length > MAX_LAN_ADDRS) return null;
  const out: LanAddr[] = [];
  for (const a of v) {
    if (typeof a !== 'object' || a === null) return null;
    const { host, port } = a as Record<string, unknown>;
    if (typeof host !== 'string' || host.length === 0 || host.length > 255 || !/^[\x21-\x7e]+$/.test(host)) return null;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
    out.push({ host, port: port as number });
  }
  return out;
}

export class HubServer extends EventEmitter {
  readonly #opts: HubServerOptions;
  readonly #now: () => number;
  readonly #heartbeatMs: number;
  readonly #authMs: number;
  readonly #wss: WebSocketServer;
  /** Authenticated links by device id. */
  readonly #online = new Map<string, Conn>();
  /** Last known state per device (survives disconnects). */
  readonly #seen = new Map<string, { lastSeen: number; lanAddrs: LanAddr[] }>();
  readonly #all = new Set<Conn>();
  /** Relayed requests awaiting the target's res, by `${from}:${id}`. */
  readonly #relays = new Map<string, Relay>();
  readonly #keys = new Map<string, KeyObject>();
  #sweep: NodeJS.Timeout;
  #ingress: HttpServer | null = null;
  #closed = false;

  constructor(opts: HubServerOptions) {
    super();
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#heartbeatMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#authMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    this.#sweep = setInterval(() => this.#dropSilent(), Math.max(20, Math.min(60_000, Math.floor(this.#heartbeatMs / 4))));
    this.#sweep.unref();
  }

  /** Serves the link on an HTTPS (mTLS) server: the TLS client certificate, if any, must match. */
  attach(server: HttpsServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.#upgrade(req, socket, head, peerDeviceId(req.socket as TLSSocket));
    });
  }

  /** Plain-HTTP ingress for tunnels, bound to 127.0.0.1 only; authentication is application-level. */
  listenIngress(port = DEFAULT_INGRESS_PORT): Promise<number> {
    const srv = createHttpServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    srv.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.#upgrade(req, socket, head, null));
    this.#ingress = srv;
    return new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweep);
    for (const r of this.#relays.values()) clearTimeout(r.timer);
    this.#relays.clear();
    for (const c of this.#all) c.ws.terminate();
    this.#all.clear();
    this.#online.clear();
    await new Promise<void>((r) => this.#wss.close(() => r()));
    const ing = this.#ingress;
    if (ing) {
      ing.closeAllConnections();
      await new Promise<void>((r) => ing.close(() => r()));
    }
  }

  online(): string[] {
    return [...this.#online.keys()];
  }

  directory(): DirectoryEntry[] {
    const list = this.#opts.members.list();
    return list.members.map((m) => {
      if (m.deviceId === this.#opts.id.deviceId) {
        return { deviceId: m.deviceId, online: true, lastSeen: this.#now(), lanAddrs: this.#opts.hubLan?.() ?? [] };
      }
      const s = this.#seen.get(m.deviceId);
      return { deviceId: m.deviceId, online: this.#online.has(m.deviceId), lastSeen: s?.lastSeen ?? 0, lanAddrs: s?.lanAddrs ?? [] };
    });
  }

  /** Sends a text or binary frame to an online device; false if it is not connected. */
  sendTo(deviceId: string, data: string | Buffer): boolean {
    const c = this.#online.get(deviceId);
    if (!c) return false;
    c.ws.send(data);
    return true;
  }

  // ---- relay --------------------------------------------------------------------------------

  #pubOf(deviceId: string): KeyObject | undefined {
    const cached = this.#keys.get(deviceId);
    if (cached) return cached;
    const d = this.#opts.members.get(deviceId);
    if (!d) return undefined;
    const k = createPublicKey(d.publicKeyPem);
    this.#keys.set(deviceId, k);
    return k;
  }

  /** A res signed by the hub itself, for failures the target never saw. */
  #hubReply(to: string, id: string, status: number, error: string): void {
    const e = sealEnvelope(
      { v: 1, kind: 'res', id, from: this.#opts.id.deviceId, to, status, contentType: 'application/json' },
      Buffer.from(JSON.stringify({ error })),
      this.#opts.id.privateKey,
    );
    this.sendTo(to, encodeFrame(e));
  }

  #route(sender: string, buf: Buffer): void {
    let e: Envelope;
    try {
      e = decodeFrame(buf);
    } catch {
      return; // not even a frame: no id to answer to
    }
    const h = e.header;
    if (h.kind === 'res') return this.#routeRes(sender, e, buf);
    try {
      openEnvelope(e, (id) => this.#pubOf(id));
    } catch {
      return this.#hubReply(sender, h.id, 400, 'bad-envelope');
    }
    if (h.from !== sender || h.to === sender || !this.#opts.members.isTrusted(h.to)) {
      return this.#hubReply(sender, h.id, 400, 'bad-envelope');
    }
    if (!this.#online.has(h.to)) return this.#offlineTarget(e);
    const key = `${sender}:${h.id}`;
    if (this.#relays.has(key)) return; // duplicate in flight: the first answer serves it
    const timer = setTimeout(() => {
      if (this.#relays.get(key)?.timer !== timer) return;
      this.#relays.delete(key);
      this.#hubReply(sender, h.id, 504, 'relay-timeout');
    }, this.#opts.relayTimeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS);
    timer.unref();
    this.#relays.set(key, { from: sender, to: h.to, timer });
    this.#opts.onRelay?.(buf);
    this.sendTo(h.to, buf);
  }

  #routeRes(sender: string, e: Envelope, buf: Buffer): void {
    const h = e.header;
    const key = `${h.to}:${h.id}`;
    const r = this.#relays.get(key);
    // Only the device the request went to may answer it, and only with a res it signed itself.
    if (!r || r.to !== sender || h.from !== sender) return;
    try {
      openEnvelope(e, (id) => this.#pubOf(id));
    } catch {
      return;
    }
    clearTimeout(r.timer);
    this.#relays.delete(key);
    this.#opts.onRelay?.(buf);
    this.sendTo(r.from, buf);
  }

  /** The target is not connected (held delivery hooks in here). */
  #offlineTarget(e: Envelope): void {
    this.#hubReply(e.header.from, e.header.id, 503, 'offline');
  }

  // ---- membership authority ----------------------------------------------------------------

  async addMember(m: Omit<Member, 'role' | 'addedAt'>): Promise<SignedMembership> {
    const list = this.#opts.members.list();
    if (list.revoked.some((r) => r.deviceId === m.deviceId)) throw new Error('device was revoked and cannot rejoin');
    const pem = canonicalSpki(m.publicKeyPem);
    const existing = list.members.find((x) => x.deviceId === m.deviceId);
    if (existing) {
      if (canonicalSpki(existing.publicKeyPem) !== pem) throw new Error('device id is already a member with a different key');
      return this.#opts.members.current();
    }
    const now = this.#now();
    return this.#publish({ ...list, members: [...list.members, { deviceId: m.deviceId, alias: m.alias, publicKeyPem: pem, role: 'member', addedAt: now }] });
  }

  async revoke(deviceId: string): Promise<SignedMembership> {
    const list = this.#opts.members.list();
    if (deviceId === list.hub.deviceId) throw new Error('the hub cannot revoke itself');
    if (list.revoked.some((r) => r.deviceId === deviceId)) return this.#opts.members.current();
    if (!list.members.some((m) => m.deviceId === deviceId)) throw new Error('not a member');
    const s = this.#publish({
      ...list,
      members: list.members.filter((m) => m.deviceId !== deviceId),
      revoked: [...list.revoked, { deviceId, revokedAt: this.#now() }],
    });
    const c = this.#online.get(deviceId);
    if (c) this.#reject(c, CLOSE_REVOKED);
    this.#seen.delete(deviceId);
    return s;
  }

  async setUrls(urls: string[]): Promise<SignedMembership> {
    const list = this.#opts.members.list();
    return this.#publish({ ...list, hub: { ...list.hub, urls: [...urls] } });
  }

  #publish(next: Omit<MembershipList, 'version' | 'issuedAt'> & Partial<MembershipList>): SignedMembership {
    const cur = this.#opts.members.list();
    const list: MembershipList = { ...next, version: cur.version + 1, issuedAt: this.#now() } as MembershipList;
    const s = signList(list, this.#opts.rootKey);
    if (this.#opts.members.accept(s) !== 'updated') throw new Error('membership update was not accepted');
    this.#broadcast(JSON.stringify({ t: 'membership', s }));
    this.emit('membership', s);
    return s;
  }

  // ---- links --------------------------------------------------------------------------------

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, tlsPeer: string | null): void {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://hub').pathname;
    } catch {
      path = '';
    }
    if (this.#closed || path !== HUB_PATH) {
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, tlsPeer));
  }

  #accept(ws: WebSocket, tlsPeer: string | null): void {
    const c: Conn = { ws, deviceId: null, lastSeen: this.#now() };
    this.#all.add(c);
    const nonce = randomBytes(32).toString('base64');
    const authTimer = setTimeout(() => ws.close(CLOSE_AUTH), this.#authMs);
    authTimer.unref();
    ws.on('error', () => {});
    ws.on('ping', () => { c.lastSeen = this.#now(); });
    ws.on('pong', () => { c.lastSeen = this.#now(); });
    ws.on('close', () => {
      clearTimeout(authTimer);
      this.#all.delete(c);
      if (c.deviceId && this.#online.get(c.deviceId) === c) {
        this.#online.delete(c.deviceId);
        const s = this.#seen.get(c.deviceId);
        if (s) s.lastSeen = c.lastSeen;
        this.emit('offline', c.deviceId);
        this.#pushDirectory();
      }
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      c.lastSeen = this.#now();
      if (c.deviceId === null) {
        clearTimeout(authTimer);
        this.#handshake(c, data, isBinary, nonce, tlsPeer);
        return;
      }
      this.#onAuthed(c, data, isBinary);
    });
    ws.send(JSON.stringify({ t: 'hello', v: 1, hub: this.#opts.id.deviceId, nonce }));
  }

  #handshake(c: Conn, data: RawData, isBinary: boolean, hubNonce: string, tlsPeer: string | null): void {
    const fail = () => c.ws.close(CLOSE_AUTH);
    if (isBinary) return fail();
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return fail();
    }
    if (typeof m !== 'object' || m === null || m.t !== 'auth') return fail();
    const { deviceId, cert, nonce, sig, mv } = m;
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return fail();
    if (typeof cert !== 'string' || !B64_RE.test(cert) || cert.length > 8192) return fail();
    if (typeof nonce !== 'string' || Buffer.from(nonce, 'base64').length !== 32) return fail();
    if (typeof sig !== 'string') return fail();
    if (!Number.isSafeInteger(mv) || (mv as number) < 0) return fail();
    const lan = parseLan(m.lan);
    if (lan === null) return fail();
    const der = Buffer.from(cert, 'base64');
    if (deviceIdOf(der) !== deviceId) return fail();
    if (tlsPeer !== null && tlsPeer !== deviceId) return fail();
    let pub: KeyObject;
    try {
      pub = new X509Certificate(der).publicKey;
    } catch {
      return fail();
    }
    const hub = this.#opts.id.deviceId;
    if (!verifyDomain(HUB_AUTH_DOMAIN, `${hub}\0${deviceId}\0${hubNonce}`, sig, pub)) return fail();

    const members = this.#opts.members;
    const known = members.get(deviceId);
    if (!members.isTrusted(deviceId) || !known) return this.#reject(c, CLOSE_REVOKED);
    // The member entry pins the key: a cert for another key never authenticates as this device.
    if (canonicalSpki(known.publicKeyPem) !== canonicalSpki(pub.export({ type: 'spki', format: 'pem' }) as string)) return fail();

    const prev = this.#online.get(deviceId);
    c.deviceId = deviceId;
    this.#online.set(deviceId, c);
    this.#seen.set(deviceId, { lastSeen: this.#now(), lanAddrs: lan });
    if (prev && prev !== c) prev.ws.close(CLOSE_REPLACED);

    const welcome: Record<string, unknown> = {
      t: 'welcome',
      sig: signDomain(HUB_AUTH_DOMAIN, `hub\0${deviceId}\0${nonce}`, this.#opts.id.privateKey),
      directory: this.directory(),
    };
    const current = members.current();
    if ((mv as number) < current.list.version) welcome.membership = current;
    c.ws.send(JSON.stringify(welcome));
    this.emit('online', deviceId);
    this.#pushDirectory(deviceId);
  }

  #onAuthed(c: Conn, data: RawData, isBinary: boolean): void {
    const deviceId = c.deviceId!;
    if (isBinary) {
      this.#route(deviceId, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof m !== 'object' || m === null) return;
    if (m.t === 'ping') {
      c.ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    this.emit('message', deviceId, m);
  }

  #reject(c: Conn, code: number): void {
    try {
      c.ws.send(JSON.stringify({ t: 'revoked' }));
    } finally {
      c.ws.close(code);
    }
  }

  #dropSilent(): void {
    const now = this.#now();
    for (const c of this.#all) if (c.deviceId !== null && now - c.lastSeen > this.#heartbeatMs) c.ws.terminate();
  }

  #broadcast(text: string, except?: string): void {
    for (const [id, c] of this.#online) if (id !== except) c.ws.send(text);
  }

  #pushDirectory(except?: string): void {
    this.#broadcast(JSON.stringify({ t: 'directory', devices: this.directory() }), except);
  }
}
