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
import { signDomain, verifyDomain } from '../mesh/canonical.ts';
import { ReplayGuard, decodeFrame, encodeFrame, openEnvelope, sealEnvelope, type Envelope } from '../mesh/envelope.ts';
import type { MembershipStore } from '../mesh/members.ts';
import type { SignedMembership } from '../mesh/membership.ts';
import { CLOSE_REVOKED, HUB_AUTH_DOMAIN, HUB_PATH, MAX_FRAME_BYTES, type DirectoryEntry, type LanAddr } from './server.ts';

export const DEFAULT_BACKOFF_MS: readonly number[] = Object.freeze([1000, 2000, 5000, 10000, 30000, 60000]);
export const DEFAULT_PING_MS = 240_000;
/** An online link that lasts this long resets the backoff. */
export const STABLE_LINK_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Answers kept for repeats; they are small JSON bodies (chunk PUTs answer 204 with no body). */
const ANSWER_CACHE_MAX = 1024;

export class HubOfflineError extends Error {
  constructor() {
    super('hub link is not online');
    this.name = 'HubOfflineError';
  }
}
export class RelayTimeoutError extends Error {
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
}

export type HubClientState = 'idle' | 'connecting' | 'online' | 'revoked';

interface Target { url: string; pinned: boolean }
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
  #state: HubClientState = 'idle';
  #ws: WebSocket | null = null;
  #stopped = true;
  #attempt = 0;
  #retry: NodeJS.Timeout | null = null;
  #ping: NodeJS.Timeout | null = null;
  #stable: NodeJS.Timeout | null = null;
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

  directory(): DirectoryEntry[] {
    return this.#directory.map((d) => ({ ...d, lanAddrs: d.lanAddrs.map((a) => ({ ...a })) }));
  }

  start(): void {
    if (this.#state === 'revoked' || !this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimers();
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

  /** Sends a JSON control message to the hub; false if not online. */
  sendControl(m: Record<string, unknown>): boolean {
    if (this.#state !== 'online' || !this.#ws) return false;
    this.#ws.send(JSON.stringify(m));
    return true;
  }

  // ---- connection ---------------------------------------------------------------------------

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
    this.#state = 'connecting';
    for (const t of this.#targets()) {
      if (this.#stopped) return;
      const ok = await this.#tryTarget(t);
      if (ok || this.#stopped || (this.#state as HubClientState) === 'revoked') return;
    }
    this.#scheduleRetry();
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

  /** Resolves true once the link is online, false if this target failed before that. */
  #tryTarget(t: Target): Promise<boolean> {
    const { id, members } = this.#o;
    const hubId = members.list().hub.deviceId;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const ws = new WebSocket(t.url, {
        key: id.keyPem,
        cert: id.certPem,
        // Pinned LAN link: the hub's self-signed cert is checked by device id below, not by a CA.
        rejectUnauthorized: !t.pinned,
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
      const timer = setTimeout(() => { ws.terminate(); done(false); }, HANDSHAKE_TIMEOUT_MS);
      const myNonce = randomBytes(32).toString('base64');
      let authed = false;
      ws.on('error', () => {});
      ws.on('upgrade', (res: IncomingMessage) => {
        if (!t.pinned) return;
        const raw = (res.socket as TLSSocket).getPeerCertificate?.(true)?.raw;
        if (!raw || deviceIdOf(raw) !== hubId) ws.terminate();
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
            if (m.hub !== hubId || typeof m.nonce !== 'string') return ws.terminate();
            const sig = signDomain(HUB_AUTH_DOMAIN, `${hubId}\0${id.deviceId}\0${m.nonce}`, id.privateKey);
            ws.send(JSON.stringify({
              t: 'auth', deviceId: id.deviceId, cert: id.certDer.toString('base64'), nonce: myNonce, sig,
              lan: this.#o.lanAddrs(), mv: members.list().version,
            }));
            return;
          }
          if (m.t === 'revoked') return this.#revoked();
          if (m.t !== 'welcome') return ws.terminate();
          const hubPub = this.#pubOf(hubId);
          if (!hubPub || typeof m.sig !== 'string' || !verifyDomain(HUB_AUTH_DOMAIN, `hub\0${id.deviceId}\0${myNonce}`, m.sig, hubPub)) {
            return ws.terminate();
          }
          authed = true;
          if (m.membership) this.#applyMembership(m.membership as SignedMembership);
          if (Array.isArray(m.directory)) this.#directory = m.directory as DirectoryEntry[];
          this.#online(ws);
          done(true);
          return;
        }
        this.#onMessage(ws, data, isBinary);
      });
      ws.on('close', (code: number) => {
        if (code === CLOSE_REVOKED) this.#revoked();
        if (!authed) return done(false);
        this.#offline(ws);
      });
    });
  }

  #online(ws: WebSocket): void {
    this.#ws = ws;
    this.#state = 'online';
    this.#ping = setInterval(() => {
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

  #clearTimers(): void {
    for (const t of [this.#retry, this.#stable]) if (t) clearTimeout(t);
    if (this.#ping) clearInterval(this.#ping);
    this.#retry = this.#ping = this.#stable = null;
  }

  // ---- messages -----------------------------------------------------------------------------

  #onMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
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
        this.#revoked();
        return;
      case 'held-delivered':
      case 'held-failed':
        this.emit(m.t, m);
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
      return; // forged, unknown sender or tampered: never reaches the handler
    }
    const h = e.header;
    if (h.to !== me) return;
    const key = `${h.from}:${h.id}`;
    if (this.#replay.seen(key)) {
      // Already handled: answer a repeat (the hub replaying after a link drop) from the cache,
      // never by running the handler twice; one still in flight gets its answer when it ends.
      const cached = this.#answers.get(key);
      if (cached && ws.readyState === WebSocket.OPEN) ws.send(cached);
      return;
    }
    const headers: Record<string, string> = { 'content-length': String(e.body.length) };
    if (h.contentType) headers['content-type'] = h.contentType;
    let r: MeshResponse;
    try {
      r = await this.#o.handler({ peer: h.from, method: h.method!, path: h.path!, headers, body: Readable.from([e.body]) });
    } catch {
      r = { status: 500, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"internal"}') };
    }
    if (r.noReply) return;
    const res: Parameters<typeof sealEnvelope>[0] = { v: 1, kind: 'res', id: h.id, from: me, to: h.from, status: r.status };
    if (r.headers['content-type']) res.contentType = r.headers['content-type'];
    const frame = encodeFrame(sealEnvelope(res, r.body, this.#o.id.privateKey));
    this.#answers.set(key, frame);
    while (this.#answers.size > ANSWER_CACHE_MAX) this.#answers.delete(this.#answers.keys().next().value as string);
    const live = this.#ws;
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
