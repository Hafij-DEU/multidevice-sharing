// Receiver HTTP API (protocol v1), plain node:https. All routes live under /mesh/v1/.
//
// Trust: the TLS layer accepts any client certificate; here every route except `GET info`
// requires peerDeviceId(socket) to be in the TrustStore (else 403 {"error":"untrusted"}).
// A session belongs to the peer named in its manifest (`from`); no other peer may touch it.
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { hostname } from 'node:os';
import type { TLSSocket } from 'node:tls';
import {
  CHUNK_SIZE,
  acceptOffer,
  chunkCount,
  exportCtx,
  importCtx,
  openChunk,
  type Manifest,
  type Offer,
} from '../chunk.ts';
import { HpkeOpenError, type HpkeContext } from '../crypto/hpke.ts';
import type { Identity } from '../identity.ts';
import {
  ChunkRangeError,
  IncompleteFileError,
  Inbox,
  IntegrityError,
  PARTIAL_DIR,
  UnknownSessionError,
  UnsafePathError,
} from '../inbox.ts';
import { peerDeviceId, serverTlsOptions } from '../tls.ts';
import type { TrustStore } from '../trust.ts';

export type ReceiverEvent =
  | { type: 'offer'; sessionId: string; from: string; manifest: Manifest }
  | { type: 'progress'; sessionId: string; from: string; fileId: number; chunks: number; total: number }
  | { type: 'file'; sessionId: string; from: string; fileId: number; path: string }
  | { type: 'received'; sessionId: string; from: string; files: string[]; text?: string }
  | { type: 'error'; sessionId: string; from: string; code: string }
  | { type: 'cancelled'; sessionId: string; from: string };

export interface MeshServerOptions {
  id: Identity;
  trust: TrustStore;
  inbox: Inbox;
  onEvent: (e: ReceiverEvent) => void;
  /** Shown by GET info (default: the host name). */
  alias?: string;
  /** Shown by GET info (default: 'desktop'). */
  deviceType?: string;
}

/** Max request body per route (enforced while streaming). */
export const MAX_CHUNK_BODY = CHUNK_SIZE + 16;
export const MAX_OFFER_BODY = 64 * 1024 * 1024;

const PREFIX = '/mesh/v1/';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,15})$/;
const U32_MAX = 0xffffffff;

class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, error: string) {
    super(error);
    this.name = 'HttpError';
    this.status = status;
    this.body = { error };
  }
}
/** The request body exceeded its cap; the connection is closed after the 413 is sent. */
class BodyTooLarge extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLarge';
  }
}
/** The client went away while we were reading; there is nobody to answer. */
class ClientGone extends Error {
  constructor() {
    super('client disconnected');
    this.name = 'ClientGone';
  }
}

interface LiveSession {
  manifest: Manifest;
  ctx: HpkeContext;
  /** fileId -> final path, for files completed through this server instance. */
  done: Map<number, string>;
}

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

function send(res: ServerResponse, status: number, body?: unknown, close = false): void {
  if (res.headersSent || res.writableEnded) return;
  const headers: Record<string, string | number> = {};
  if (close) headers['connection'] = 'close';
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const json = Buffer.from(JSON.stringify(body));
  headers['content-type'] = 'application/json';
  headers['content-length'] = json.length;
  res.writeHead(status, headers);
  res.end(json);
}

/** Reads at most `cap` bytes. Rejects with BodyTooLarge as soon as the declared or actual size exceeds it. */
function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > cap) {
      reject(new BodyTooLarge());
      return;
    }
    const parts: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };
    const onData = (d: Buffer) => {
      size += d.length;
      if (size > cap) {
        cleanup();
        req.pause();
        parts.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      parts.push(d);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(parts));
    };
    const onError = () => {
      cleanup();
      reject(new ClientGone());
    };
    const onClose = () => {
      if (req.complete) return; // 'end' handles it
      cleanup();
      reject(new ClientGone());
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

function parseUint(s: string | undefined): number {
  if (s === undefined || !UINT_RE.test(s)) throw new HttpError(400, 'bad-request');
  return Number(s);
}

function sessionIdParam(s: string | undefined): string {
  if (s === undefined || !SESSION_ID_RE.test(s)) throw new HttpError(404, 'unknown-session');
  return s;
}

export function createMeshServer(opts: MeshServerOptions): Server {
  const { id, trust, inbox } = opts;
  const alias = opts.alias ?? hostname();
  const deviceType = opts.deviceType ?? 'desktop';
  const live = new Map<string, LiveSession>();
  const offerLocks = new Map<string, Promise<unknown>>();

  const emit = (e: ReceiverEvent): void => {
    try {
      opts.onEvent(e);
    } catch {
      /* a failing listener must not break the request */
    }
  };

  /** Serializes offers per sessionId so two racing offers cannot both create the session. */
  function withOfferLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = offerLocks.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    offerLocks.set(sessionId, tail);
    void tail.then(() => { if (offerLocks.get(sessionId) === tail) offerLocks.delete(sessionId); });
    return run;
  }

  /** In-memory session (ctx imported once, e.g. after a restart) or null if the inbox has none. */
  async function getLive(sessionId: string): Promise<LiveSession | null> {
    const cached = live.get(sessionId);
    if (cached) return cached;
    const st = await inbox.load(sessionId);
    if (!st) return null;
    const racing = live.get(sessionId);
    if (racing) return racing;
    const s: LiveSession = { manifest: st.manifest, ctx: importCtx(st.ctxExport), done: new Map() };
    live.set(sessionId, s);
    return s;
  }

  async function requireOwned(sessionId: string, peer: string): Promise<LiveSession> {
    const s = await getLive(sessionId);
    if (!s) throw new HttpError(404, 'unknown-session');
    if (s.manifest.from !== peer) throw new HttpError(403, 'forbidden');
    return s;
  }

  /** Completed files of a session: this instance's memory, plus what the inbox persisted earlier. */
  async function completedFiles(sessionId: string, s: LiveSession): Promise<Map<number, string>> {
    const out = new Map(s.done);
    if (out.size < s.manifest.files.length) {
      try {
        const raw = await readFile(`${inbox.root}/${PARTIAL_DIR}/${sessionId}/progress.json`, 'utf8');
        const pf = JSON.parse(raw) as { done?: Record<string, string> };
        for (const [k, v] of Object.entries(pf.done ?? {})) if (typeof v === 'string' && !out.has(Number(k))) out.set(Number(k), v);
      } catch {
        /* no progress file yet */
      }
    }
    return out;
  }

  // ---- routes ----------------------------------------------------------------------------------

  async function handleOffer(req: IncomingMessage, res: ServerResponse, peer: string, who: { sessionId?: string }): Promise<void> {
    const body = await readBody(req, MAX_OFFER_BODY);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad-json');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(422, 'bad-offer');
    const o = parsed as Offer;
    if (o.from !== peer) throw new HttpError(403, 'forbidden');
    const sessionId = o.sessionId;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new HttpError(422, 'bad-offer');
    who.sessionId = sessionId;
    const device = trust.get(peer);
    if (!device) throw new HttpError(403, 'untrusted');
    const senderPub = createPublicKey(device.publicKeyPem);

    await withOfferLock(sessionId, async () => {
      const existing = await getLive(sessionId);
      let accepted;
      try {
        accepted = acceptOffer(id, senderPub, o);
      } catch {
        throw new HttpError(422, 'bad-offer');
      }
      if (existing) {
        if (existing.manifest.from !== peer) throw new HttpError(403, 'forbidden');
        const stored = await inbox.load(sessionId);
        if (!stored || exportCtx(accepted.ctx) !== stored.ctxExport) throw new HttpError(409, 'session-conflict');
        send(res, 200, { have: await inbox.have(sessionId) });
        return;
      }
      await inbox.begin(sessionId, accepted.manifest, exportCtx(accepted.ctx));
      live.set(sessionId, { manifest: accepted.manifest, ctx: accepted.ctx, done: new Map() });
      emit({ type: 'offer', sessionId, from: peer, manifest: accepted.manifest });
      send(res, 200, { have: await inbox.have(sessionId) });
    });
  }

  async function handleChunk(req: IncomingMessage, res: ServerResponse, peer: string, seg: string[]): Promise<void> {
    const sessionId = sessionIdParam(seg[1]);
    const fileId = parseUint(seg[2]);
    const index = parseUint(seg[3]);
    const s = await requireOwned(sessionId, peer);
    const file = s.manifest.files.find((f) => f.fileId === fileId);
    if (!file || index >= chunkCount(file.size) || fileId > U32_MAX || index > U32_MAX) {
      throw new HttpError(409, 'range');
    }
    const ct = await readBody(req, MAX_CHUNK_BODY);
    let pt: Buffer;
    try {
      pt = openChunk(s.ctx, sessionId, fileId, index, ct);
    } catch (e) {
      if (e instanceof HpkeOpenError) throw new HttpError(422, 'decrypt');
      throw e;
    }
    await inbox.writeChunk(sessionId, fileId, index, pt);
    const have = (await inbox.have(sessionId))[fileId] ?? [];
    emit({ type: 'progress', sessionId, from: peer, fileId, chunks: have.length, total: chunkCount(file.size) });
    send(res, 204);
  }

  async function handleComplete(res: ServerResponse, peer: string, seg: string[]): Promise<void> {
    const sessionId = sessionIdParam(seg[1]);
    const fileId = parseUint(seg[2]);
    const s = await requireOwned(sessionId, peer);
    let path: string;
    try {
      path = await inbox.finalize(sessionId, fileId);
    } catch (e) {
      if (e instanceof IncompleteFileError) throw new HttpError(409, 'incomplete');
      throw e;
    }
    const first = !s.done.has(fileId);
    s.done.set(fileId, path);
    if (first) emit({ type: 'file', sessionId, from: peer, fileId, path });
    send(res, 200, { path });
  }

  async function handleFinish(res: ServerResponse, peer: string, seg: string[]): Promise<void> {
    const sessionId = sessionIdParam(seg[1]);
    const s = await requireOwned(sessionId, peer);
    const done = await completedFiles(sessionId, s);
    const files: string[] = [];
    for (const f of s.manifest.files) {
      const p = done.get(f.fileId);
      if (p === undefined) throw new HttpError(409, 'incomplete');
      files.push(p);
    }
    await inbox.finalizeDirs(sessionId);
    const ev: ReceiverEvent = { type: 'received', sessionId, from: peer, files };
    if (s.manifest.text !== undefined) ev.text = s.manifest.text;
    emit(ev);
    live.delete(sessionId);
    try {
      await inbox.drop(sessionId);
    } catch {
      /* the data is delivered; leftover partial state is harmless */
    }
    send(res, 200, { files });
  }

  async function handleCancel(res: ServerResponse, peer: string, seg: string[]): Promise<void> {
    const sessionId = sessionIdParam(seg[1]);
    const s = await getLive(sessionId);
    if (!s) {
      send(res, 204); // already gone: cancel is idempotent
      return;
    }
    if (s.manifest.from !== peer) throw new HttpError(403, 'forbidden');
    live.delete(sessionId);
    await inbox.drop(sessionId);
    emit({ type: 'cancelled', sessionId, from: peer });
    send(res, 204);
  }

  async function route(req: IncomingMessage, res: ServerResponse, who: { peer?: string; sessionId?: string }): Promise<void> {
    const method = req.method ?? 'GET';
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://meshdrop').pathname;
    } catch {
      throw new HttpError(400, 'bad-request');
    }
    if (!pathname.startsWith(PREFIX)) throw new HttpError(404, 'not-found');
    const seg = pathname.slice(PREFIX.length).split('/');

    if (method === 'GET' && seg.length === 1 && seg[0] === 'info') {
      send(res, 200, { v: 1, deviceId: id.deviceId, alias, deviceType });
      return;
    }

    const peer = peerDeviceId(req.socket as TLSSocket);
    if (peer === null || !trust.isTrusted(peer)) throw new HttpError(403, 'untrusted');
    who.peer = peer;
    if (seg.length > 1 && seg[1] !== undefined && SESSION_ID_RE.test(seg[1])) who.sessionId = seg[1];

    if (method === 'POST' && seg.length === 1 && seg[0] === 'offer') return handleOffer(req, res, peer, who);
    if (method === 'PUT' && seg.length === 4 && seg[0] === 'chunk') return handleChunk(req, res, peer, seg);
    if (method === 'POST' && seg.length === 3 && seg[0] === 'complete') return handleComplete(res, peer, seg);
    if (method === 'POST' && seg.length === 2 && seg[0] === 'finish') return handleFinish(res, peer, seg);
    if (method === 'POST' && seg.length === 2 && seg[0] === 'cancel') return handleCancel(res, peer, seg);
    throw new HttpError(404, 'not-found');
  }

  const server = createServer(serverTlsOptions(id), (req, res) => {
    const who: { peer?: string; sessionId?: string } = {};
    route(req, res, who).catch((e: unknown) => {
      if (e instanceof ClientGone) return;
      if (e instanceof BodyTooLarge) {
        send(res, 413, { error: 'too-large' }, true);
        // Stop the upload: close once the response is flushed.
        res.once('finish', () => req.socket.destroy());
        return;
      }
      if (e instanceof HttpError) return send(res, e.status, e.body);
      if (e instanceof ChunkRangeError) return send(res, 409, { error: 'range' });
      if (e instanceof UnknownSessionError) return send(res, 404, { error: 'unknown-session' });
      if (e instanceof IntegrityError) return send(res, 422, { error: 'integrity' });
      if (e instanceof UnsafePathError) return send(res, 422, { error: 'bad-offer' });
      if (code(e) === 'ENOSPC') {
        emit({ type: 'error', sessionId: who.sessionId ?? '', from: who.peer ?? '', code: 'ENOSPC' });
        return send(res, 507, { error: 'no-space' });
      }
      send(res, 500, { error: 'internal' });
    });
  });
  // A client that disconnects or botches the handshake must never surface as an uncaught error.
  server.on('tlsClientError', () => {});
  return server;
}
