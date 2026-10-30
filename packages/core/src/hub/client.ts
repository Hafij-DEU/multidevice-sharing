// Device side of the hub link (protocol v1): connects, authenticates (see hub/server.ts for the
// handshake), keeps the link alive, applies pushed membership lists, and serves relayed requests
// through the local receiver handler. A revoked device stops for good.
import { createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import WebSocket, { type RawData } from 'ws';
import type { MeshRequest, MeshResponse } from '../api/handler.ts';
import { deviceIdOf, type Identity } from '../identity.ts';
import { canonicalJson, signDomain, verifyDomain } from '../mesh/canonical.ts';
import { ReplayGuard, decodeFrame, encodeFrame, openEnvelope, sealEnvelope, type Envelope } from '../mesh/envelope.ts';
import type { MembershipStore } from '../mesh/members.ts';
import { verifySigned, type SignedMembership } from '../mesh/membership.ts';
import type { Invite } from '../mesh/invite.ts';
import { CLOSE_REVOKED, HUB_AUTH_DOMAIN, HUB_CTL_DOMAIN, HUB_PATH, MAX_FRAME_BYTES, type DirectoryEntry, type LanAddr } from './server.ts';

const DEFAULT_BACKOFF_MS: readonly number[] = Object.freeze([1000, 2000, 5000, 10000, 30000, 60000]);
const DEFAULT_PING_MS = 240_000;
/** An online link that lasts this long resets the backoff. */
const STABLE_LINK_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Answers kept for repeats; they are small JSON bodies (chunk PUTs answer 204 with no body). */
const ANSWER_CACHE_MAX = 1024;

export class HubOfflineError extends Error {
  constructor() {
    super('hub link is not online');
    this.name = 'HubOfflineError';
  }
}
class RelayTimeoutError extends Error {
  constructor() {
    super('relay request timed out');
    this.name = 'RelayTimeoutError';
  }
}

export interface HubClientOptions {
  id: Identity;
  members: MembershipStore;
  handler: (r: MeshRequest) => Promise<MeshResponse>;
  /** This device's LAN addresses, reported to the hub's directory. */
  lanAddrs: () => LanAddr[];
  /** The hub's LAN address if known (tried first, pinned to the hub's device id). */
  hubLan?: () => LanAddr | undefined;
  backoffMs?: readonly number[];
  pingMs?: number;
  /** Signed answers kept for repeated requests (default 1024). */
  answerCacheSize?: number;
  /**
   * Relay hubs from the verified, root-signed relay list (M9a). While the main hub is unreachable the
   * link goes to the first relay that answers; it moves back to the main hub once that answers again.
   */
  relays?: () => { deviceId: string; urls: string[] }[];
  /** How often a link on a relay tries the main hub again (default 5 min). */
  failbackMs?: number;
  /** How often, linked to the main hub, held files are fetched from each relay (default 10 min). */
  drainMs?: number;
}

const DEFAULT_FAILBACK_MS = 300_000;
const DEFAULT_DRAIN_MS = 600_000;
/** A drain link closes after this long without traffic (or after DRAIN_MAX_MS). */
const DRAIN_IDLE_MS = 15_000;
const DRAIN_MAX_MS = 120_000;

/** 'refused': the hub turned this device away without proof of revocation; the link stops, the mesh state stays. */
export type HubClientState = 'idle' | 'connecting' | 'online' | 'revoked' | 'refused';

/** `relay`: a relay hub's id (its hello must name it; its key is in the membership). */
interface Target { url: string; pinned: boolean; relay?: string }
interface Pending { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; cleanup: () => void }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class HubClient extends EventEmitter {
  readonly #o: HubClientOptions;
  readonly #backoff: readonly number[];
  readonly #pingMs: number;
  readonly #replay = new ReplayGuard();
  readonly #pending = new Map<string, Pending>();
  readonly #keys = new Map<string, KeyObject>();
  /** Signed answers to recently handled requests, by `${from}:${id}` (oldest evicted first). */
  readonly #answers = new Map<string, Buffer>();
  /** Requests being handled right now, by `${from}:${id}`. */
  readonly #inflight = new Set<string>();
  #state: HubClientState = 'idle';
  #lastRx = 0;
  #ws: WebSocket | null = null;
  #stopped = true;
  /** Bumped by start() and stop(): a connect loop or handshake from an older run must not go online. */
  #run = 0;
  /** Sockets still in the handshake, so stop() can cut them before a late welcome lands. */
  #handshakes = new Set<WebSocket>();
  #attempt = 0;
  #retry: NodeJS.Timeout | null = null;
  #ping: NodeJS.Timeout | null = null;
  #stable: NodeJS.Timeout | null = null;
  #failback: NodeJS.Timeout | null = null;
  #drain: NodeJS.Timeout | null = null;
  /** Short links to relays that only fetch held files. */
  readonly #drains = new Set<WebSocket>();
  /** The hub this link is on: the main hub's id, or a relay's. */
  #linkedTo: string | null = null;
  #directory: DirectoryEntry[] = [];

  constructor(opts: HubClientOptions) {
    super();
    this.#o = opts;
    this.#backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#pingMs = opts.pingMs ?? DEFAULT_PING_MS;
  }

  get state(): HubClientState {
    return this.#state;
  }

  /** The hub's device id per the current membership list. */
  get hubDeviceId(): string {
    return this.#o.members.list().hub.deviceId;
  }

  /** The hub this device is linked to now (the main hub, or a relay hub while the main one is away). */
  get linkedHub(): string | null {
    return this.#state === 'online' ? this.#linkedTo : null;
  }

  directory(): DirectoryEntry[] {
    return this.#directory.map((d) => ({ ...d, lanAddrs: d.lanAddrs.map((a) => ({ ...a })) }));
  }

  start(): void {
    if (this.#state === 'revoked' || !this.#stopped) return;
    this.#stopped = false;
    this.#run++;
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#run++;
    for (const h of this.#handshakes) h.terminate();
    this.#handshakes.clear();
    this.#clearTimers();
    for (const t of [this.#failback, this.#drain]) if (t) clearInterval(t);
    this.#failback = this.#drain = null;
    for (const d of this.#drains) d.terminate();
    this.#drains.clear();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) ws.terminate();
    this.#failPending(new HubOfflineError());
    if (this.#state !== 'revoked') this.#state = 'idle';
  }

  /** Sends a sealed req envelope through the hub and resolves with the matching res envelope. */
  request(e: Envelope, timeoutMs: number, signal?: AbortSignal): Promise<Envelope> {
    const ws = this.#ws;
    if (this.#state !== 'online' || !ws) return Promise.reject(new HubOfflineError());
    if (signal?.aborted) return Promise.reject(abortError());
    const id = e.header.id;
    return new Promise<Envelope>((resolve, reject) => {
      const onAbort = () => {
        this.#settle(id)?.reject(abortError());
      };
      const timer = setTimeout(() => this.#settle(id)?.reject(new RelayTimeoutError()), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve, reject, timer, cleanup });
      ws.send(encodeFrame(e), (err) => { if (err) this.#settle(id)?.reject(new HubOfflineError()); });
    });
  }

  /** Lets the hub enforce an invite this device created, so it can be redeemed over the hub. */
  registerInvite(i: Invite, uses = 1): boolean {
    const ttlMs = Math.max(0, i.expiresAt - Date.now());
    return this.sendControl(this.#signed({ t: 'invite', secret: i.secret.toString('base64url'), ttlMs, ...(uses > 1 ? { uses } : {}) }));
  }

  /**
   * Control messages that change the mesh (invite, join) are signed with this device's key, so a
   * party that terminates TLS in front of the hub (a tunnel, a proxy) cannot inject them.
   */
  #signed(m: Record<string, unknown>): Record<string, unknown> {
    const body = { ...m, ts: Date.now() };
    return { ...body, sig: signDomain(HUB_CTL_DOMAIN, canonicalJson(body), this.#o.id.privateKey) };
  }

  /**
   * Asks the hub to sign `newMember` into the mesh (this device already admitted it with a QR
   * invite). Resolves with the new list; rejects if the hub refuses or does not answer in time.
   */
  requestJoin(newMember: { deviceId: string; alias: string; publicKeyPem: string; cert: string }, timeoutMs = 10_000): Promise<SignedMembership> {
    const reqId = randomBytes(9).toString('base64url');
    return new Promise((resolve, reject) => {
      const onControl = (m: Record<string, unknown>) => {
        if (m.t !== 'join-result' || m.reqId !== reqId) return;
        done();
        if (m.ok === true) {
          const s = m.membership as SignedMembership;
          this.#applyMembership(s);
          resolve(s);
        } else reject(new Error(typeof m.error === 'string' ? m.error : 'join refused'));
      };
      const timer = setTimeout(() => { done(); reject(new HubOfflineError()); }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.off('control', onControl);
      };
      this.on('control', onControl);
      if (!this.sendControl(this.#signed({ t: 'join', reqId, newMember }))) {
        done();
        reject(new HubOfflineError());
      }
    });
  }

  /** Sends a JSON control message to the hub; false if not online. */
  sendControl(m: Record<string, unknown>): boolean {
    if (this.#state !== 'online' || !this.#ws) return false;
    this.#ws.send(JSON.stringify(m));
    return true;
  }

  // ---- connection ---------------------------------------------------------------------------

  #relayTargets(): Target[] {
    const me = this.#o.id.deviceId;
    const out: Target[] = [];
    for (const r of this.#o.relays?.() ?? []) {
      if (r.deviceId === me || !this.#o.members.isTrusted(r.deviceId)) continue;
      for (const u of r.urls) {
        try {
          const p = new URL(u);
          if (p.protocol === 'wss:' || (p.protocol === 'ws:' && LOOPBACK.has(p.hostname))) out.push({ url: u, pinned: false, relay: r.deviceId });
        } catch {
          /* skip malformed */
        }
      }
    }
    return out;
  }

  #targets(): Target[] {
    const out: Target[] = [];
    const lan = this.#o.hubLan?.();
    if (lan) out.push({ url: `wss://${lan.host.includes(':') ? `[${lan.host}]` : lan.host}:${lan.port}${HUB_PATH}`, pinned: true });
    for (const u of this.#o.members.list().hub.urls) {
      try {
        const p = new URL(u);
        // Public URLs use standard CA validation; plain ws:// only to a local ingress (dev, tests).
        if (p.protocol === 'wss:' || (p.protocol === 'ws:' && LOOPBACK.has(p.hostname))) out.push({ url: u, pinned: false });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  async #connect(): Promise<void> {
    if (this.#stopped || this.#state === 'revoked') return;
    const run = this.#run;
    this.#state = 'connecting';
    // The main hub first; only when none of its addresses answers, a relay hub.
    for (const t of [...this.#targets(), ...this.#relayTargets()]) {
      if (this.#stopped || run !== this.#run) return;
      const ok = await this.#tryTarget(t);
      if (ok || this.#stopped || run !== this.#run || (this.#state as HubClientState) === 'revoked') return;
    }
    this.#scheduleRetry();
  }

  /** On a relay: try the main hub; once it answers the link moves there (the relay link is dropped). */
  async #tryFailback(): Promise<void> {
    if (this.#stopped || this.#state !== 'online' || this.#linkedTo === this.hubDeviceId) return;
    for (const t of this.#targets()) {
      if (this.#stopped || this.#linkedTo === this.hubDeviceId) return;
      if (await this.#tryTarget(t)) return;
    }
  }

  /** Linked to the main hub: open a short link to each relay so it hands over what it held for us. */
  async #drainRelays(): Promise<void> {
    if (this.#stopped || this.#state !== 'online' || this.#linkedTo !== this.hubDeviceId) return;
    const done = new Set<string>();
    for (const t of this.#relayTargets()) {
      if (this.#stopped || done.has(t.relay!)) continue;
      if (await this.#tryTarget(t, true)) done.add(t.relay!);
    }
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#state === 'revoked') return;
    this.#state = 'connecting';
    const delay = this.#backoff[Math.min(this.#attempt, this.#backoff.length - 1)] ?? 60_000;
    this.#attempt++;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#connect();
    }, delay);
    this.#retry.unref();
  }

  /**
   * Resolves true once the link is online, false if this target failed before that. A `drain` link
   * only takes held deliveries: it never becomes the device's link and closes when it goes quiet.
   */
  #tryTarget(t: Target, drain = false): Promise<boolean> {
    const { id, members } = this.#o;
    const hubId = members.list().hub.deviceId;
    const run = this.#run;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#handshakes.delete(ws);
        resolve(ok);
      };
      const ws = new WebSocket(t.url, {
        key: id.keyPem,
        cert: id.certPem,
        // Pinned LAN link: the hub's self-signed cert is checked by device id below, not by a CA.
        rejectUnauthorized: !t.pinned,
        minVersion: 'TLSv1.3',
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
      this.#handshakes.add(ws);
      const timer = setTimeout(() => { ws.terminate(); done(false); }, HANDSHAKE_TIMEOUT_MS);
      const myNonce = randomBytes(32).toString('base64');
      let authed = false;
      let helloHub = hubId;
      ws.on('error', () => {});
      let pinnedId: string | null = null;
      ws.on('upgrade', (res: IncomingMessage) => {
        if (!t.pinned) return;
        const raw = (res.socket as TLSSocket).getPeerCertificate?.(true)?.raw;
        if (!raw) return ws.terminate();
        pinnedId = deviceIdOf(raw); // the hello must name this device (checked there)
      });
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (!authed) {
          if (isBinary) return ws.terminate();
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(data.toString());
          } catch {
            return ws.terminate();
          }
          if (m.t === 'hello') {
            if (typeof m.hub !== 'string' || !/^[0-9a-f]{64}$/.test(m.hub) || typeof m.nonce !== 'string') return ws.terminate();
            // A different hub id is only possible after a recovery (a new hub took over the mesh);
            // it must then hand us a newer list, signed by the mesh root, naming it as the hub.
            if (t.pinned && m.hub !== pinnedId) return ws.terminate();
            if (t.relay !== undefined && m.hub !== t.relay) return ws.terminate();
            helloHub = m.hub;
            const sig = signDomain(HUB_AUTH_DOMAIN, `${helloHub}\0${id.deviceId}\0${m.nonce}`, id.privateKey);
            const auth: Record<string, unknown> = {
              t: 'auth', deviceId: id.deviceId, cert: id.certDer.toString('base64'), nonce: myNonce, sig,
              lan: this.#o.lanAddrs(), mv: members.list().version,
            };
            // Our list is at least as new as the hub's: hand it over (e.g. a hub recovered from an
            // older export adopts it). The hub verifies it against the mesh root like anyone else.
            if (typeof m.hv === 'number' && members.list().version >= m.hv) auth.membership = members.current();
            ws.send(JSON.stringify(auth));
            return;
          }
          if (m.t === 'revoked') return this.#onRevokedNotice(m.s);
          if (m.t !== 'welcome') return ws.terminate();
          if (helloHub !== hubId && t.relay === undefined) {
            if (!m.membership) return ws.terminate();
            try {
              members.accept(m.membership as SignedMembership);
            } catch {
              return ws.terminate();
            }
            if (members.list().hub.deviceId !== helloHub) return ws.terminate();
            this.#keys.clear();
            this.emit('membership', members.current());
          }
          const hubPub = this.#pubOf(helloHub);
          if (!hubPub || typeof m.sig !== 'string' || !verifyDomain(HUB_AUTH_DOMAIN, `hub\0${id.deviceId}\0${myNonce}`, m.sig, hubPub)) {
            return ws.terminate();
          }
          if (this.#stopped || run !== this.#run) {
            ws.terminate();
            return done(false);
          }
          authed = true;
          if (m.membership) this.#applyMembership(m.membership as SignedMembership);
          if (m.relays) this.emit('relays', m.relays);
          if (drain) {
            this.#startDrain(ws);
            done(true);
            return;
          }
          if (Array.isArray(m.directory)) this.#directory = m.directory as DirectoryEntry[];
          this.#online(ws, helloHub);
          done(true);
          return;
        }
        this.#onMessage(ws, data, isBinary);
      });
      ws.on('close', (code: number) => {
        if (drain) {
          this.#drains.delete(ws);
          if (!authed) done(false);
          return;
        }
        if (code === CLOSE_REVOKED && this.#state !== 'revoked') this.#refused();
        if (!authed) return done(false);
        this.#offline(ws);
      });
    });
  }

  /** A drain link: answer what the relay replays, then close once quiet (or after DRAIN_MAX_MS). */
  #startDrain(ws: WebSocket): void {
    this.#drains.add(ws);
    let idle = setTimeout(() => ws.close(), DRAIN_IDLE_MS);
    const max = setTimeout(() => ws.close(), DRAIN_MAX_MS);
    max.unref();
    ws.on('message', () => {
      clearTimeout(idle);
      idle = setTimeout(() => ws.close(), DRAIN_IDLE_MS);
      idle.unref();
    });
    ws.on('close', () => {
      clearTimeout(idle);
      clearTimeout(max);
    });
    idle.unref();
  }

  #online(ws: WebSocket, hub: string): void {
    // Moving from a relay back to the main hub: the old link goes quietly (its close is ignored);
    // what was in flight on it fails now and is retried by its senders.
    const old = this.#ws;
    this.#clearTimers();
    if (old && old !== ws) {
      this.#ws = null;
      this.#failPending(new HubOfflineError());
      old.terminate();
    }
    this.#ws = ws;
    this.#linkedTo = hub;
    this.#state = 'online';
    const isMain = hub === this.hubDeviceId;
    for (const t of [this.#failback, this.#drain]) if (t) clearInterval(t);
    this.#failback = this.#drain = null;
    if (!isMain) {
      this.#failback = setInterval(() => void this.#tryFailback(), this.#o.failbackMs ?? DEFAULT_FAILBACK_MS);
      this.#failback.unref();
    } else if ((this.#o.relays?.() ?? []).length > 0) {
      const first = setTimeout(() => void this.#drainRelays(), 2000);
      first.unref();
      this.#drain = setInterval(() => void this.#drainRelays(), this.#o.drainMs ?? DEFAULT_DRAIN_MS);
      this.#drain.unref();
    }
    this.#lastRx = Date.now();
    this.#ping = setInterval(() => {
      // Nothing from the hub (not even a pong) for two ping periods: the link is dead (half-open
      // after a network change); drop it so we relink instead of believing we are online.
      if (Date.now() - this.#lastRx > 2 * this.#pingMs) {
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
    }, this.#pingMs);
    this.#ping.unref();
    this.#stable = setTimeout(() => { this.#attempt = 0; }, STABLE_LINK_MS);
    this.#stable.unref();
    this.emit('online');
  }

  #offline(ws: WebSocket): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#clearTimers();
    this.#failPending(new HubOfflineError());
    if (this.#state === 'revoked') return;
    this.#state = this.#stopped ? 'idle' : 'connecting';
    this.emit('offline');
    this.#scheduleRetry();
  }

  #revoked(): void {
    if (this.#state === 'revoked') return;
    this.#state = 'revoked';
    this.#stopped = true;
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    ws?.terminate();
    this.#failPending(new HubOfflineError());
    this.emit('revoked');
  }

  /**
   * A revocation counts only with proof: a list signed by the mesh root, at least as new as ours,
   * without this device. Anything else (no list, a foreign or older list) only stops the link.
   */
  #onRevokedNotice(s: unknown): void {
    const members = this.#o.members;
    const me = this.#o.id.deviceId;
    try {
      const list = verifySigned(s as SignedMembership, members.anchor);
      if (list.version >= members.list().version && !list.members.some((x) => x.deviceId === me)) {
        try {
          members.accept(s as SignedMembership);
        } catch {
          /* same version, other content: still proof that we are out */
        }
        this.#revoked();
        return;
      }
    } catch {
      /* not proof */
    }
    this.#refused();
  }

  #refused(): void {
    if (this.#state === 'revoked' || this.#state === 'refused') return;
    this.#state = 'refused';
    this.#stopped = true;
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    ws?.terminate();
    this.#failPending(new HubOfflineError());
    this.emit('refused');
  }

  #clearTimers(): void {
    for (const t of [this.#retry, this.#stable]) if (t) clearTimeout(t);
    if (this.#ping) clearInterval(this.#ping);
    this.#retry = this.#ping = this.#stable = null;
  }

  // ---- messages -----------------------------------------------------------------------------

  #onMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
    this.#lastRx = Date.now();
    if (isBinary) {
      void this.#onFrame(ws, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case 'membership':
        this.#applyMembership(m.s as SignedMembership);
        return;
      case 'directory':
        if (Array.isArray(m.devices)) {
          this.#directory = m.devices as DirectoryEntry[];
          this.emit('directory', this.directory());
        }
        return;
      case 'revoked':
        this.#onRevokedNotice(m.s);
        return;
      case 'invite-used':
        this.emit('invite-used');
        return;
      case 'held-delivered':
      case 'held-failed':
        this.emit(m.t, m);
        return;
      case 'relays':
        this.emit('relays', m.s);
        return;
      default:
        this.emit('control', m);
    }
  }

  #applyMembership(s: SignedMembership): void {
    try {
      if (this.#o.members.accept(s) === 'updated') {
        this.#keys.clear();
        this.emit('membership', s);
        if (this.#o.members.isRevoked(this.#o.id.deviceId)) this.#revoked();
      }
    } catch {
      /* stale, foreign or forked lists are ignored; the current list stands */
    }
  }

  #pubOf(deviceId: string): KeyObject | undefined {
    const cached = this.#keys.get(deviceId);
    if (cached) return cached;
    const d = this.#o.members.get(deviceId);
    if (!d) return undefined;
    const k = createPublicKey(d.publicKeyPem);
    this.#keys.set(deviceId, k);
    return k;
  }

  async #onFrame(ws: WebSocket, buf: Buffer): Promise<void> {
    let e: Envelope;
    try {
      e = decodeFrame(buf);
    } catch {
      return;
    }
    if (e.header.kind === 'res') {
      this.#settle(e.header.id)?.resolve(e);
      return;
    }
    const me = this.#o.id.deviceId;
    try {
      openEnvelope(e, (id) => this.#pubOf(id));
    } catch {
      // Forged or tampered: never reaches the handler, no answer. A sender that is simply not (or no
      // longer) in our list gets a signed refusal, so a hub replaying for it does not wait forever.
      const h = e.header;
      if (h.to === me && !this.#pubOf(h.from) && ws.readyState === WebSocket.OPEN) {
        const res = sealEnvelope({ v: 1, kind: 'res', id: h.id, from: me, to: h.from, status: 403, contentType: 'application/json' }, Buffer.from('{"error":"untrusted"}'), this.#o.id.privateKey);
        ws.send(encodeFrame(res));
      }
      return;
    }
    const h = e.header;
    if (h.to !== me) return;
    const key = `${h.from}:${h.id}`;
    if (this.#replay.seen(key)) {
      // A repeat (the hub replaying after a link drop): one still in flight gets its answer when it
      // ends; a finished one is answered from the cache. If its answer was evicted, run it again:
      // every receiver route is idempotent, and silence would stall the hub's replay.
      const cached = this.#answers.get(key);
      if (this.#inflight.has(key)) return;
      if (cached) {
        if (ws.readyState === WebSocket.OPEN) ws.send(cached);
        return;
      }
    }
    this.#inflight.add(key);
    const headers: Record<string, string> = { 'content-length': String(e.body.length) };
    if (h.contentType) headers['content-type'] = h.contentType;
    let r: MeshResponse;
    try {
      r = await this.#o.handler({ peer: h.from, method: h.method!, path: h.path!, headers, body: Readable.from([e.body]) });
    } catch {
      r = { status: 500, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"internal"}') };
    } finally {
      this.#inflight.delete(key);
    }
    if (r.noReply) return;
    const res: Parameters<typeof sealEnvelope>[0] = { v: 1, kind: 'res', id: h.id, from: me, to: h.from, status: r.status };
    if (r.headers['content-type']) res.contentType = r.headers['content-type'];
    const frame = encodeFrame(sealEnvelope(res, r.body, this.#o.id.privateKey));
    this.#answers.set(key, frame);
    while (this.#answers.size > (this.#o.answerCacheSize ?? ANSWER_CACHE_MAX)) this.#answers.delete(this.#answers.keys().next().value as string);
    const live = this.#drains.has(ws) ? ws : this.#ws;
    if (live && live.readyState === WebSocket.OPEN) live.send(frame);
  }

  #settle(id: string): Pending | undefined {
    const p = this.#pending.get(id);
    if (!p) return undefined;
    this.#pending.delete(id);
    p.cleanup();
    return p;
  }

  #failPending(err: Error): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id)?.reject(err);
  }
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
