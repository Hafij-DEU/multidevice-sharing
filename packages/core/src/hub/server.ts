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
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { MAX_OFFER_BODY } from '../api/handler.ts';
import { deviceIdOf, type Identity } from '../identity.ts';
import { signDomain, verifyDomain } from '../mesh/canonical.ts';
import { decodeFrame, encodeFrame, openEnvelope, sealEnvelope, type Envelope } from '../mesh/envelope.ts';
import { heldSessionOf, type HeldSession, type HeldStore } from './held.ts';
import type { InviteBook } from '../mesh/invite.ts';
import type { MembershipStore } from '../mesh/members.ts';
import { signList, verifySigned, type Member, type MembershipList, type SignedMembership } from '../mesh/membership.ts';
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
/** Too many links waiting to authenticate. */
export const CLOSE_BUSY = 4429;
export const MAX_PENDING_AUTH = 64;
export const MAX_PREAUTH_BYTES = 16384;
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
  /** Invites this hub enforces (its own and those members registered); without it joins over the hub fail. */
  invites?: InviteBook;
  /** Store for sessions sent to offline devices; without it they get 503 offline. */
  held?: HeldStore;
  /** Observes every frame the hub forwards (tests, diagnostics). */
  onRelay?: (frame: Buffer) => void;
  /** Plain HTTP requests on the ingress (internet guest links); return true when handled. */
  ingressHttp?: (req: IncomingMessage, res: ServerResponse) => boolean;
  now?: () => number;
}

export const DEFAULT_RELAY_TIMEOUT_MS = 600_000;

interface Relay { from: string; to: string; timer: NodeJS.Timeout; onRes?: (e: Envelope | null) => void }
const HELD_PRUNE_INTERVAL_MS = 3600_000;
const REPLAY_RETRY_MS = 30_000;

interface Conn {
  ws: WebSocket;
  deviceId: string | null;
  lastSeen: number;
}

const DEVICE_ID_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A device alias as stored in the membership list: 1–64 chars, no control characters. */
export function isAlias(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
}

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
  readonly #replaying = new Set<string>();
  readonly #replayAgain = new Set<string>();
  #sweep: NodeJS.Timeout;
  #prune: NodeJS.Timeout | null = null;
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
    if (opts.held) {
      void this.pruneHeld().catch(() => {});
      this.#prune = setInterval(() => void this.pruneHeld().catch(() => {}), HELD_PRUNE_INTERVAL_MS);
      this.#prune.unref();
    }
  }

  /** Serves the link on an HTTPS (mTLS) server: the TLS client certificate, if any, must match. */
  attach(server: HttpsServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.#upgrade(req, socket, head, peerDeviceId(req.socket as TLSSocket));
    });
  }

  /** Plain-HTTP ingress for tunnels, bound to 127.0.0.1 only; authentication is application-level. */
  listenIngress(port = DEFAULT_INGRESS_PORT): Promise<number> {
    const srv = createHttpServer((req, res) => {
      if (this.#opts.ingressHttp?.(req, res)) return; // internet guest links (M5b)
      res.writeHead(404);
      res.end();
    });
    srv.headersTimeout = 10_000;
    srv.requestTimeout = 300_000;
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
    if (this.#prune) clearInterval(this.#prune);
    for (const key of [...this.#relays.keys()]) this.#failRelay(key, 503, 'offline');
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

  /** Drops held sessions past their TTL and tells each sender (held-failed, error 'expired'). */
  async pruneHeld(): Promise<void> {
    const held = this.#opts.held;
    if (!held) return;
    for (const x of await held.pruneExpired()) {
      this.#notify(x.from, { t: 'held-failed', to: x.to, sessionId: x.sessionId, status: 410, error: 'expired' });
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
    const held = this.#opts.held;
    if (held) {
      // A held session in progress keeps being stored even if the target came online meanwhile.
      const sid = heldSessionOf(e);
      void (async () => {
        if (sid !== null && (await held.isOpen(h.to, sid))) return this.#hold(e);
        if (!this.#online.has(h.to)) return this.#hold(e);
        this.#forward(e, buf);
      })().catch(() => this.#hubReply(sender, h.id, 500, 'internal'));
      return;
    }
    if (!this.#online.has(h.to)) return this.#hubReply(sender, h.id, 503, 'offline');
    this.#forward(e, buf);
  }

  /** Relays a req to its (online) target; the target's res goes back to the sender. */
  #forward(e: Envelope, buf: Buffer): void {
    const h = e.header;
    const sender = h.from;
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
    if (!this.sendTo(h.to, buf)) this.#failRelay(key, 503, 'offline');
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
    if (r.onRes) return r.onRes(e);
    this.#opts.onRelay?.(buf);
    this.sendTo(r.from, buf);
  }

  /** Ends a relay without the target's answer (hub replay: null; a sender: a hub-signed error). */
  #failRelay(key: string, status: number, error: string): void {
    const r = this.#relays.get(key);
    if (!r) return;
    clearTimeout(r.timer);
    this.#relays.delete(key);
    if (r.onRes) return r.onRes(null);
    this.#hubReply(r.from, key.slice(key.indexOf(':') + 1), status, error);
  }

  // ---- held delivery ------------------------------------------------------------------------

  async #hold(e: Envelope): Promise<void> {
    const h = e.header;
    const r = await this.#opts.held!.put(e);
    const sid = heldSessionOf(e);
    const res = sealEnvelope(
      { v: 1, kind: 'res', id: h.id, from: this.#opts.id.deviceId, to: h.from, status: r.status, ...(r.body ? { contentType: 'application/json' } : {}) },
      r.body ? Buffer.from(JSON.stringify(r.body)) : Buffer.alloc(0),
      this.#opts.id.privateKey,
    );
    this.sendTo(h.from, encodeFrame(res));
    // A session finished while its target is already online is delivered right away.
    if (sid !== null && r.status === 200 && h.path?.startsWith('/mesh/v1/finish/') && this.#online.has(h.to)) void this.#replay(h.to);
  }

  /** Sends a stored req to its target as the hub, resolving with the target's res (null if none). */
  #replayOne(e: Envelope): Promise<Envelope | null> {
    const h = e.header;
    const key = `${h.from}:${h.id}`;
    return new Promise((resolve) => {
      if (this.#relays.has(key)) this.#failRelay(key, 503, 'offline');
      const timer = setTimeout(() => this.#failRelay(key, 504, 'relay-timeout'), this.#opts.relayTimeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS);
      timer.unref();
      this.#relays.set(key, { from: h.from, to: h.to, timer, onRes: resolve });
      if (!this.sendTo(h.to, encodeFrame(e))) this.#failRelay(key, 503, 'offline');
    });
  }

  #notify(to: string, notice: { t: string; sessionId: string } & Record<string, unknown>): void {
    if (!this.sendTo(to, JSON.stringify(notice))) void this.#opts.held!.queueNotice(to, notice.sessionId, notice).catch(() => {});
  }

  /** Replays every finished held session for `to`; a link drop leaves the rest for the next connect. */
  async #replay(to: string): Promise<void> {
    const held = this.#opts.held;
    if (!held) return;
    if (this.#replaying.has(to)) {
      this.#replayAgain.add(to); // run again once the current pass ends
      return;
    }
    this.#replaying.add(to);
    let retry = false;
    try {
      for (const s of await held.pending(to)) {
        if (!this.#online.has(to)) return;
        if (!this.#opts.members.isTrusted(s.from)) {
          await held.remove(s.to, s.sessionId); // its sender was revoked: undeliverable
          continue;
        }
        if ((await this.#replaySession(s)) === 'retry') {
          retry = true;
          break;
        }
      }
    } catch {
      /* a broken held session stays until the TTL prunes it */
    } finally {
      this.#replaying.delete(to);
    }
    if (this.#replayAgain.delete(to) && this.#online.has(to)) {
      void this.#replay(to);
    } else if (retry && this.#online.has(to)) {
      // The target answered 5xx: try again later even if it stays connected.
      setTimeout(() => void this.#replay(to), REPLAY_RETRY_MS).unref();
    }
  }

  async #replaySession(s: HeldSession): Promise<'done' | 'failed' | 'retry'> {
    const held = this.#opts.held!;
    let skip: Record<string, number[]> = {};
    const fail = async (status: number, error: string): Promise<'failed'> => {
      await held.remove(s.to, s.sessionId);
      this.#notify(s.from, { t: 'held-failed', to: s.to, sessionId: s.sessionId, status, error });
      return 'failed';
    };
    for await (const e of s.envelopes()) {
      const chunk = /^\/mesh\/v1\/chunk\/[^/]+\/(\d+)\/(\d+)$/.exec(e.header.path ?? '');
      if (chunk && skip[chunk[1]!]?.includes(Number(chunk[2]))) continue;
      const res = await this.#replayOne(e);
      if (!res) return 'retry';
      const st = res.header.status!;
      const body = (() => {
        try {
          return res.body.length ? (JSON.parse(res.body.toString()) as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      })();
      if (st >= 500) return 'retry';
      if (st >= 400) return fail(st, typeof body.error === 'string' ? body.error : 'rejected');
      if (e.header.path === '/mesh/v1/offer') {
        if (body.done === true) {
          await held.remove(s.to, s.sessionId);
          this.#notify(s.from, { t: 'held-delivered', to: s.to, sessionId: s.sessionId, files: body.files ?? [] });
          return 'done';
        }
        if (body.have && typeof body.have === 'object') skip = body.have as Record<string, number[]>;
      }
      if (e.header.path?.startsWith('/mesh/v1/finish/')) {
        await held.remove(s.to, s.sessionId);
        this.#notify(s.from, { t: 'held-delivered', to: s.to, sessionId: s.sessionId, files: body.files ?? [] });
        return 'done';
      }
    }
    return 'retry';
  }

  // ---- membership authority ----------------------------------------------------------------

  async addMember(m: Omit<Member, 'role' | 'addedAt'>): Promise<SignedMembership> {
    return this.#addMemberSync(m);
  }

  /**
   * A device presented a root-signed list at least as new as ours (this hub was recovered from an
   * older export, or its own file went back). Merge it: members of either list, revocations of
   * either list (a revocation always wins), this device as the hub, any other hub id revoked; then
   * sign it with a version above both.
   */
  #adoptNewer(raw: unknown): void {
    const members = this.#opts.members;
    const cur = members.current();
    let theirs: MembershipList;
    try {
      theirs = verifySigned(raw as SignedMembership, createPublicKey(this.#opts.rootKey));
    } catch {
      return;
    }
    const mine = cur.list;
    if (theirs.version < mine.version || (theirs.version === mine.version && (raw as SignedMembership).sig === cur.sig)) return;
    const me = this.#opts.id.deviceId;
    const now = this.#now();
    const revoked = new Map<string, number>();
    for (const r of [...mine.revoked, ...theirs.revoked]) if (r.deviceId !== me && !revoked.has(r.deviceId)) revoked.set(r.deviceId, r.revokedAt);
    for (const hubId of [mine.hub.deviceId, theirs.hub.deviceId]) if (hubId !== me && !revoked.has(hubId)) revoked.set(hubId, now);
    const byId = new Map<string, Member>();
    for (const m of [...theirs.members, ...mine.members]) if (!revoked.has(m.deviceId) && m.deviceId !== me) byId.set(m.deviceId, { ...m, role: 'member' });
    const self = mine.members.find((m) => m.deviceId === me)!;
    const list: MembershipList = {
      ...mine,
      version: Math.max(mine.version, theirs.version) + 1,
      issuedAt: now,
      members: [...byId.values(), { ...self, role: 'hub' }],
      revoked: [...revoked].map(([deviceId, revokedAt]) => ({ deviceId, revokedAt })),
    };
    const s = signList(list, this.#opts.rootKey);
    if (members.accept(s) !== 'updated') return;
    this.#broadcast(JSON.stringify({ t: 'membership', s }));
    this.emit('membership', s);
  }

  /** The mesh root public key as SPKI PEM (what a joining device pins). */
  get anchorPem(): string {
    return createPublicKey(this.#opts.rootKey).export({ type: 'spki', format: 'pem' }) as string;
  }

  #addMemberSync(m: Omit<Member, 'role' | 'addedAt'>): SignedMembership {
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
    // Its held sessions could never be delivered (targets refuse it) and would block the rest.
    await this.#opts.held?.purgeDevice(deviceId).catch(() => {});
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
    // Unauthenticated links are cheap to open and cost us memory: cap them.
    let pending = 0;
    for (const x of this.#all) if (x.deviceId === null) pending++;
    if (pending >= MAX_PENDING_AUTH) {
      ws.on('error', () => {});
      ws.close(CLOSE_BUSY);
      return;
    }
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
        // Requests still waiting on this device will never be answered over this link.
        for (const [key, r] of [...this.#relays]) if (r.to === c.deviceId) this.#failRelay(key, 503, 'offline');
        this.emit('offline', c.deviceId);
        this.#pushDirectory();
      }
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      c.lastSeen = this.#now();
      if (c.deviceId === null) {
        clearTimeout(authTimer);
        // An auth or join message is small; never parse a large blob from an unknown peer.
        const size = Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as ArrayBuffer).byteLength;
        if (size > MAX_PREAUTH_BYTES) return c.ws.close(CLOSE_AUTH);
        this.#handshake(c, data, isBinary, nonce, tlsPeer);
        return;
      }
      this.#onAuthed(c, data, isBinary);
    });
    ws.send(JSON.stringify({ t: 'hello', v: 1, hub: this.#opts.id.deviceId, nonce, hv: this.#opts.members.list().version }));
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
    if (typeof m !== 'object' || m === null || (m.t !== 'auth' && m.t !== 'join')) return fail();
    const joining = m.t === 'join';
    const { deviceId, cert, nonce, sig } = m;
    const mv = joining ? 0 : m.mv;
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return fail();
    if (typeof cert !== 'string' || !B64_RE.test(cert) || cert.length > 8192) return fail();
    if (typeof nonce !== 'string' || Buffer.from(nonce, 'base64').length !== 32) return fail();
    if (typeof sig !== 'string') return fail();
    if (!Number.isSafeInteger(mv) || (mv as number) < 0) return fail();
    const lan = parseLan(m.lan ?? []);
    if (lan === null) return fail();
    if (joining && (!isAlias(m.alias) || typeof m.proof !== 'string' || m.proof.length > 128 || typeof m.inviter !== 'string' || !DEVICE_ID_RE.test(m.inviter))) {
      return fail();
    }
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
    if (m.membership !== undefined) this.#adoptNewer(m.membership);
    if (joining && !members.isTrusted(deviceId)) {
      // A QR invite redeemed over the internet: the invite must be one this hub enforces.
      const inviter = m.inviter as string;
      const res = this.#opts.invites && members.isTrusted(inviter) ? this.#opts.invites.consume(deviceId, inviter, m.proof as string) : 'unknown';
      if (res !== 'ok' || members.isRevoked(deviceId)) {
        c.ws.send(JSON.stringify({ t: 'join-failed', error: res === 'ok' ? 'revoked' : res }));
        c.ws.close(CLOSE_REVOKED);
        return;
      }
      try {
        this.#addMemberSync({ deviceId, alias: m.alias as string, publicKeyPem: pub.export({ type: 'spki', format: 'pem' }) as string });
        // Redeemed here: tell the inviter to burn its own copy (single use across LAN and hub).
        this.sendTo(inviter, JSON.stringify({ t: 'invite-used' }));
      } catch {
        c.ws.send(JSON.stringify({ t: 'join-failed', error: 'refused' }));
        c.ws.close(CLOSE_REVOKED);
        return;
      }
    }
    const known = members.get(deviceId);
    if (!members.isTrusted(deviceId) || !known) return this.#reject(c, CLOSE_REVOKED);
    // The member entry pins the key: a cert for another key never authenticates as this device.
    if (canonicalSpki(known.publicKeyPem) !== canonicalSpki(pub.export({ type: 'spki', format: 'pem' }) as string)) return fail();

    const prev = this.#online.get(deviceId);
    c.deviceId = deviceId;
    this.#online.set(deviceId, c);
    this.#seen.set(deviceId, { lastSeen: this.#now(), lanAddrs: lan });
    if (prev && prev !== c) {
      // Whatever was sent on the old link is lost with it: fail it now (a replay then restarts on
      // the new link) instead of waiting for the relay timeout.
      for (const [key, r] of [...this.#relays]) if (r.to === deviceId) this.#failRelay(key, 503, 'offline');
      prev.ws.close(CLOSE_REPLACED);
    }

    const welcome: Record<string, unknown> = {
      t: 'welcome',
      sig: signDomain(HUB_AUTH_DOMAIN, `hub\0${deviceId}\0${nonce}`, this.#opts.id.privateKey),
      directory: this.directory(),
    };
    const current = members.current();
    if ((mv as number) < current.list.version) welcome.membership = current;
    if (joining) welcome.anchorPem = this.anchorPem;
    c.ws.send(JSON.stringify(welcome));
    this.emit('online', deviceId);
    this.#pushDirectory(deviceId);
    const held = this.#opts.held;
    if (held) {
      void held.takeNotices(deviceId).then((ns) => { for (const n of ns) this.sendTo(deviceId, JSON.stringify(n)); }, () => {});
      void this.#replay(deviceId);
    }
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
    if (m.t === 'invite') return this.#onInvite(deviceId, m);
    if (m.t === 'join') return this.#onMemberJoin(c, deviceId, m);
    this.emit('message', deviceId, m);
  }

  /** A member registers an invite it created, so the invited device can redeem it over the hub. */
  #onInvite(inviter: string, m: Record<string, unknown>): void {
    const invites = this.#opts.invites;
    if (!invites || typeof m.secret !== 'string') return;
    const secret = Buffer.from(m.secret, 'base64url');
    if (secret.length !== 16) return;
    const mesh = this.#opts.members.list().mesh;
    // The inviter's remaining lifetime, on our clock; never more than a fresh invite.
    const ttl = typeof m.ttlMs === 'number' && Number.isFinite(m.ttlMs) ? m.ttlMs : 0;
    invites.register({ secret, inviter, mesh, lan: [], hubUrls: [], expiresAt: 0 }, ttl);
  }

  /**
   * A member adds a device it has already admitted with a QR invite over the LAN (it checked the
   * proof). Any member may add a device; the hub signs it in and answers {t:'join-result'}.
   */
  #onMemberJoin(c: Conn, inviter: string, m: Record<string, unknown>): void {
    const reqId = typeof m.reqId === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(m.reqId) ? m.reqId : null;
    if (reqId === null) return;
    const nm = m.newMember as Record<string, unknown> | undefined;
    const answer = (o: Record<string, unknown>) => c.ws.send(JSON.stringify({ t: 'join-result', reqId, ...o }));
    if (!nm || typeof nm.deviceId !== 'string' || !DEVICE_ID_RE.test(nm.deviceId) || !isAlias(nm.alias) || typeof nm.publicKeyPem !== 'string') {
      return answer({ ok: false, error: 'bad-request' });
    }
    if (nm.deviceId === inviter) return answer({ ok: false, error: 'bad-request' });
    try {
      const s = this.#addMemberSync({ deviceId: nm.deviceId, alias: nm.alias as string, publicKeyPem: nm.publicKeyPem });
      // The inviter redeemed its live invite on the LAN: burn the copy registered here too.
      this.#opts.invites?.markUsed(inviter);
      answer({ ok: true, membership: s });
    } catch (e) {
      answer({ ok: false, error: e instanceof Error && /revoked/.test(e.message) ? 'revoked' : 'refused' });
    }
  }

  #reject(c: Conn, code: number): void {
    try {
      // The current root-signed list is the device's proof that it is out (it ignores a bare notice).
      c.ws.send(JSON.stringify({ t: 'revoked', s: this.#opts.members.current() }));
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
