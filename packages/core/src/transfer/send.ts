// Sender side of a MeshDrop transfer: manifest building, resumable sessions and the outbox.
//
// Session algorithm (see docs/protocol.md "Sender algorithm / resume"):
//   1. buildManifest walks the items, hashing every file with positional reads, and records each
//      source's size + mtimeMs. createOffer derives the HPKE context and seals the manifest.
//   2. With an Outbox, the entry {sessionId, target, offer, manifest, sources, ctxExport} is written
//      (atomically, 0600: ctxExport is key material) BEFORE the first request.
//   3. POST offer (always the byte-identical stored Offer, so the receiver recognises the resume):
//      200 {have} -> PUT only the missing chunks (default 3 in flight), POST complete per file,
//      POST finish. 200 {done:true} -> the receiver already finished this session: done.
//   4. 'done' deletes the outbox entry. 'failed' and 'cancelled' keep it so it can be resumed.
//
// Retries: transient failures (network errors, timeouts, any 5xx including 507) are retried 3 times
// with 0.5 s / 1 s / 2 s backoff; 4xx, pin mismatches, malformed replies and changed sources fail
// the session at once. Aborting `signal` means "pause": the session ends 'cancelled', nothing is
// posted to the receiver (no `cancel`), and the outbox entry stays resumable.
//
// Abandoned sessions: when a session can never complete (a terminal failure: source-changed, an
// integrity error, any 4xx such as 409 session-conflict) or an outbox entry is superseded by a new
// session, the sender posts `cancel` once (best effort: one attempt, short timeout, errors ignored)
// so the receiver drops its partial data instead of keeping it until its 30-day prune.
//
// Source safety: re-sealing different plaintext under the same (session, fileId, index) would reuse
// an AES-GCM nonce, so before every chunk read the source's size and mtime are compared with the
// values recorded at manifest time; any change fails the session with 'source-changed'.
import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CHUNK_SIZE,
  chunkCount,
  createOffer,
  exportCtx,
  importCtx,
  newSessionId,
  sealChunk,
  type DirEntry,
  type FileEntry,
  type Manifest,
  type Offer,
} from '../chunk.ts';
import type { HpkeContext } from '../crypto/hpke.ts';
import type { Identity } from '../identity.ts';
import { configDir } from '../paths.ts';
import { PinMismatchError, connectPinned, pinnedRequest, type PinnedResponse } from '../tls.ts';

export interface SendItem { kind: 'file' | 'dir' | 'text'; srcPath?: string; text?: string }
export interface Target { deviceId: string; host: string; port: number; publicKey: KeyObject }
export type SendResult = { deviceId: string; status: 'done' | 'failed' | 'cancelled'; sessionId: string; error?: string };
export interface SendProgress { fileId: number; sent: number; total: number } // plaintext bytes of that file

export interface SendOptions {
  onProgress?: (p: SendProgress) => void;
  /** Abort = pause: the result is 'cancelled' and the outbox entry is kept (no cancel is posted). */
  signal?: AbortSignal;
  /** Persist the session so it survives a restart; also lets a repeated sendTo resume it. */
  outbox?: Outbox;
  /** Chunk PUTs in flight (default 3). */
  concurrency?: number;
  /** Backoff before each retry of a transient failure (default [500, 1000, 2000]). */
  retryDelaysMs?: readonly number[];
  /** Idle timeout for offer and chunk requests (default 30 000 ms). */
  timeoutMs?: number;
  /** Idle timeout for complete/finish, which make the receiver hash whole files (default 10 min). */
  finalizeTimeoutMs?: number;
  /** TCP + TLS handshake + pin check timeout (default 10 000 ms). */
  connectTimeoutMs?: number;
}

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([500, 1000, 2000]);
export const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FINALIZE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Connect and request timeout of the best-effort `cancel`. */
export const CANCEL_TIMEOUT_MS = 3000;
const HASH_BUF = 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID_RE = /^[0-9a-f]{64}$/;
const PREFIX = '/mesh/v1/';
/** pinnedRequest's messages for a reply body we cannot use (bad JSON, oversized). */
const MALFORMED_REPLY = /^(invalid JSON in application\/json response|response body exceeds )/;

// ---- errors ------------------------------------------------------------------------------------

/** A non-2xx reply. 5xx is transient (retried); everything else fails the session. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`http-${status}${code ? ' ' + code : ''}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.code = code;
  }
}
/** A source file changed (size/mtime) after the manifest was built. Never retried. */
export class SourceChangedError extends Error {
  constructor(path: string) {
    super(`source changed: ${path}`);
    this.name = 'SourceChangedError';
  }
}
/** The receiver answered 2xx with a body we cannot use. Never retried. */
class ProtocolError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ProtocolError';
  }
}
class TargetMismatchError extends Error {
  constructor() {
    super('target-mismatch');
    this.name = 'TargetMismatchError';
  }
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** A failure after which this session can never complete, so the receiver's copy is garbage. */
function isTerminal(e: unknown): boolean {
  if (e instanceof SourceChangedError) return true;
  return e instanceof HttpStatusError && e.status >= 400 && e.status < 500;
}

/**
 * Best-effort `POST cancel/<sessionId>` so the receiver drops a session's partial data: one
 * attempt, at most ~`timeoutMs` for the connection and the request each, never throws. Resolves
 * true if the receiver acknowledged it (2xx).
 */
export async function postCancel(
  id: Identity,
  t: { deviceId: string; host: string; port: number },
  sessionId: string,
  timeoutMs: number = CANCEL_TIMEOUT_MS,
): Promise<boolean> {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  try {
    const sock = await connectPinned(t.host, t.port, id, t.deviceId, { timeoutMs });
    const res = await pinnedRequest(sock, 'POST', `${PREFIX}cancel/${sessionId}`, undefined, {}, {
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

function isTransient(e: unknown): boolean {
  if (e instanceof HttpStatusError) return e.status >= 500;
  if (e instanceof SourceChangedError || e instanceof PinMismatchError || e instanceof ProtocolError) return false;
  if ((e as Error)?.name === 'AbortError') return false;
  return true; // network errors, resets, timeouts
}

/** Short, stable error string for SendResult.error. */
export function errorString(e: unknown): string {
  if (e instanceof HttpStatusError) return e.message;
  if (e instanceof SourceChangedError) return 'source-changed';
  if (e instanceof PinMismatchError) return 'pin-mismatch';
  if (e instanceof ProtocolError) return 'bad-response';
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

// ---- manifest building -------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.csv': 'text/csv', '.json': 'application/json', '.js': 'text/javascript', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.heic': 'image/heic', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.apk': 'application/vnd.android.package-archive', '.deb': 'application/vnd.debian.binary-package',
};
const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

export interface SourceStat { size: number; mtimeMs: number }

/** Items hashed once, ready to become a manifest for any number of targets. @internal */
export interface PreparedItems {
  itemsKey: string;
  files: FileEntry[];
  dirs: DirEntry[];
  text?: string;
  sources: Map<number, string>;
  stats: Map<number, SourceStat>;
  /** Per-chunk plaintext SHA-256 (hex) for every fileId. */
  chunkHashes: Map<number, string[]>;
}

/**
 * Hashes a file with positional reads: the whole-file SHA-256 (for the manifest) plus one SHA-256
 * per CHUNK_SIZE chunk (kept by the sender only, to prove on resume that a chunk's plaintext is
 * unchanged before it is sealed again). Fails if the file changes while being read.
 */
async function hashFile(path: string, followSymlink: boolean, signal?: AbortSignal): Promise<{ sha256: string; chunks: string[]; stat: SourceStat }> {
  if (signal?.aborted) throw abortError();
  const flags = constants.O_RDONLY | (followSymlink ? 0 : (constants.O_NOFOLLOW ?? 0));
  const h = await fsp.open(path, flags);
  try {
    const st = await h.stat();
    if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
    const hash = createHash('sha256');
    const chunks: string[] = [];
    let chunkHash = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.min(HASH_BUF, Math.max(st.size, 1)));
    let pos = 0;
    while (pos < st.size) {
      // never let one read straddle a chunk boundary, so chunk hashes stay aligned
      if (signal?.aborted) throw abortError();
      const want = Math.min(buf.length, st.size - pos, CHUNK_SIZE - (pos % CHUNK_SIZE));
      const { bytesRead } = await h.read(buf, 0, want, pos);
      if (bytesRead === 0) throw new SourceChangedError(path);
      const piece = buf.subarray(0, bytesRead);
      hash.update(piece);
      chunkHash.update(piece);
      pos += bytesRead;
      if (pos % CHUNK_SIZE === 0 || pos === st.size) {
        chunks.push(chunkHash.digest('hex'));
        chunkHash = createHash('sha256');
      }
    }
    const st2 = await h.stat();
    if (st2.size !== st.size || st2.mtimeMs !== st.mtimeMs) throw new SourceChangedError(path);
    return { sha256: hash.digest('hex'), chunks, stat: { size: st.size, mtimeMs: st.mtimeMs } };
  } finally {
    await h.close();
  }
}

/**
 * Walks and hashes `items`. Rules:
 * - `file`: sent under its base name. An explicitly chosen path is followed if it is a symlink.
 * - `dir`: walked recursively under its base name; manifest paths use '/'. Inside the walk,
 *   symlinks (to files or dirs) and special files are skipped silently — they are never followed,
 *   so a link cannot pull files from outside the chosen folder. A directory that ends up with no
 *   entries is listed in `dirs` (only leaf dirs; the receiver creates parents).
 * - `text`: at most one per send.
 * Aborting `signal` stops the walk/hashing promptly (rejects with an AbortError).
 * @internal
 */
export async function prepareItems(items: SendItem[], signal?: AbortSignal): Promise<PreparedItems> {
  if (!Array.isArray(items) || items.length === 0) throw new Error('nothing to send');
  const files: FileEntry[] = [];
  const dirs: DirEntry[] = [];
  const sources = new Map<number, string>();
  const stats = new Map<number, SourceStat>();
  const chunkHashes = new Map<number, string[]>();
  let text: string | undefined;

  const addFile = async (abs: string, rel: string, follow: boolean) => {
    const { sha256, chunks, stat } = await hashFile(abs, follow, signal);
    const fileId = files.length;
    files.push({ fileId, path: rel, size: stat.size, mime: mimeOf(rel), sha256 });
    sources.set(fileId, abs);
    stats.set(fileId, stat);
    chunkHashes.set(fileId, chunks);
  };
  const walk = async (abs: string, rel: string): Promise<void> => {
    if (signal?.aborted) throw abortError();
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    ents.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    let emitted = 0;
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const childAbs = join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
        emitted++;
      } else if (e.isFile()) {
        await addFile(childAbs, childRel, false);
        emitted++;
      }
    }
    if (emitted === 0) dirs.push({ path: rel });
  };

  for (const it of items) {
    if (signal?.aborted) throw abortError();
    if (it?.kind === 'text') {
      if (typeof it.text !== 'string') throw new Error('text item without text');
      if (text !== undefined) throw new Error('only one text item per send');
      text = it.text;
      continue;
    }
    if ((it?.kind !== 'file' && it?.kind !== 'dir') || typeof it.srcPath !== 'string') throw new Error('invalid send item');
    const abs = resolve(it.srcPath);
    const name = basename(abs);
    if (!name) throw new Error(`cannot send ${abs}`);
    const st = await fsp.stat(abs);
    if (it.kind === 'file') {
      if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
      await addFile(abs, name, true);
    } else {
      if (!st.isDirectory()) throw new Error(`not a directory: ${abs}`);
      await walk(abs, name);
    }
  }
  const itemsKey = createHash('sha256')
    .update(JSON.stringify(items.map((i) => [i.kind, i.srcPath === undefined ? null : resolve(i.srcPath), i.text ?? null])))
    .digest('hex');
  const out: PreparedItems = { itemsKey, files, dirs, sources, stats, chunkHashes };
  if (text !== undefined) out.text = text;
  return out;
}

function manifestFor(p: PreparedItems, from: string, to: string, sessionId: string = newSessionId()): Manifest {
  const m: Manifest = {
    v: 1, sessionId, from, to, createdAt: Date.now(),
    files: p.files.map((f) => ({ ...f })),
    dirs: p.dirs.map((d) => ({ ...d })),
  };
  if (p.text !== undefined) m.text = p.text;
  return m;
}

/**
 * Builds a manifest (fresh sessionId) for `items`, hashing each file's plaintext while walking.
 * Also returns `stats` (size + mtimeMs per fileId, captured while hashing) for change detection.
 */
export async function buildManifest(
  items: SendItem[],
  from: string,
  to: string,
): Promise<{ manifest: Manifest; sources: Map<number, string>; stats: Map<number, SourceStat> }> {
  const p = await prepareItems(items);
  return { manifest: manifestFor(p, from, to), sources: p.sources, stats: p.stats };
}

// ---- outbox ------------------------------------------------------------------------------------

export interface OutboxSource {
  fileId: number;
  path: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 (hex) of each CHUNK_SIZE plaintext chunk, checked before any chunk is sealed. */
  chunks: string[];
}
export interface OutboxEntry {
  v: 1;
  sessionId: string;
  createdAt: number;
  target: { deviceId: string; host: string; port: number; publicKeyPem: string };
  /** Identifies the item list, so a repeated sendTo of the same items resumes this entry. */
  itemsKey: string;
  /** The exact Offer first posted; a resume re-posts it byte-for-byte (else 409 session-conflict). */
  offer: Offer;
  manifest: Manifest;
  sources: OutboxSource[];
  /** HPKE sender context (key material): the file is 0600. */
  ctxExport: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function validEntry(x: unknown, sessionId: string): OutboxEntry | null {
  if (!isObj(x) || x.v !== 1 || x.sessionId !== sessionId || typeof x.ctxExport !== 'string' || typeof x.itemsKey !== 'string') return null;
  const t = x.target;
  if (!isObj(t) || typeof t.deviceId !== 'string' || !DEVICE_ID_RE.test(t.deviceId)) return null;
  if (!isObj(x.offer) || x.offer.sessionId !== sessionId || !isObj(x.manifest) || x.manifest.sessionId !== sessionId) return null;
  if (!Array.isArray(x.manifest.files) || !Array.isArray(x.sources)) return null;
  for (const s of x.sources) {
    if (!isObj(s) || typeof s.fileId !== 'number' || typeof s.path !== 'string' || typeof s.size !== 'number' || typeof s.mtimeMs !== 'number') return null;
    if (!Number.isSafeInteger(s.size) || s.size < 0 || !Array.isArray(s.chunks) || s.chunks.length !== chunkCount(s.size)) return null;
    if (!s.chunks.every((c) => typeof c === 'string' && /^[0-9a-f]{64}$/.test(c))) return null;
  }
  return x as unknown as OutboxEntry;
}

/**
 * Persistent queue of unfinished sends: one `<sessionId>.json` (0600) per session in `dir`
 * (default `<config>/outbox`). Entries are removed when their send is done; failed and cancelled
 * (paused) sends stay until resumed or removed with `remove()`.
 */
export class Outbox {
  readonly dir: string;

  constructor(dir: string = join(configDir(), 'outbox')) {
    this.dir = dir;
  }

  private file(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid sessionId');
    return join(this.dir, `${sessionId}.json`);
  }

  async save(e: OutboxEntry): Promise<void> {
    const path = this.file(e.sessionId);
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const h = await fsp.open(tmp, 'wx', 0o600);
      try {
        await h.writeFile(JSON.stringify(e));
        await h.sync();
      } finally {
        await h.close();
      }
      await fsp.chmod(tmp, 0o600); // open() mode is subject to umask
      await fsp.rename(tmp, path);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async load(sessionId: string): Promise<OutboxEntry | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file(sessionId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      return validEntry(JSON.parse(raw), sessionId);
    } catch {
      return null;
    }
  }

  async remove(sessionId: string): Promise<void> {
    await fsp.rm(this.file(sessionId), { force: true });
  }

  /** Valid entries (oldest first) plus the session ids of unreadable ones. */
  private async scan(): Promise<{ entries: OutboxEntry[]; corrupt: string[] }> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], corrupt: [] };
      throw e;
    }
    const entries: OutboxEntry[] = [];
    const corrupt: string[] = [];
    for (const n of names.sort()) {
      const m = /^([A-Za-z0-9_-]{22})\.json$/.exec(n);
      if (!m) continue;
      const e = await this.load(m[1]!).catch(() => null);
      if (e) entries.push(e);
      else corrupt.push(m[1]!);
    }
    entries.sort((a, b) => a.createdAt - b.createdAt);
    return { entries, corrupt };
  }

  async list(): Promise<OutboxEntry[]> {
    return (await this.scan()).entries;
  }

  /** Newest entry for this target + item list, if any. */
  async findMatch(deviceId: string, itemsKey: string): Promise<OutboxEntry | null> {
    const hits = (await this.list()).filter((e) => e.target.deviceId === deviceId && e.itemsKey === itemsKey);
    return hits.at(-1) ?? null;
  }

  /**
   * Resumes every entry concurrently. Entries whose device `resolveTarget` cannot locate are
   * skipped (kept) and reported as failed 'target-unresolved'; unreadable entry files are kept and
   * reported as failed 'corrupt-entry' with an empty deviceId.
   */
  async resumeAll(
    id: Identity,
    resolveTarget: (deviceId: string) => Target | undefined | Promise<Target | undefined>,
    opts: Omit<SendOptions, 'outbox'> = {},
  ): Promise<SendResult[]> {
    const { entries, corrupt } = await this.scan();
    const results = await Promise.all(
      entries.map(async (e): Promise<SendResult> => {
        let t: Target | undefined;
        try {
          t = await resolveTarget(e.target.deviceId);
        } catch {
          t = undefined;
        }
        if (!t) return { deviceId: e.target.deviceId, status: 'failed', sessionId: e.sessionId, error: 'target-unresolved' };
        return runSession(id, t, e, { ...opts, outbox: this });
      }),
    );
    for (const sid of corrupt) results.push({ deviceId: '', status: 'failed', sessionId: sid, error: 'corrupt-entry' });
    return results;
  }
}

// ---- sessions ----------------------------------------------------------------------------------

/** Sessions currently running in this process; a second runner for the same session is refused. */
const active = new Set<string>();

/** Whether a session is being sent by this process right now. */
export function isSessionActive(sessionId: string): boolean {
  return active.has(sessionId);
}

function sameContent(e: OutboxEntry, p: PreparedItems): boolean {
  const a = JSON.stringify([
    e.manifest.files.map((f) => [f.fileId, f.path, f.size, f.sha256]),
    e.manifest.dirs.map((d) => d.path),
    e.manifest.text ?? null,
    [...e.sources].sort((x, y) => x.fileId - y.fileId).map((s) => [s.fileId, s.path, s.size, s.mtimeMs]),
  ]);
  const b = JSON.stringify([
    p.files.map((f) => [f.fileId, f.path, f.size, f.sha256]),
    p.dirs.map((d) => d.path),
    p.text ?? null,
    p.files.map((f) => [f.fileId, p.sources.get(f.fileId), p.stats.get(f.fileId)!.size, p.stats.get(f.fileId)!.mtimeMs]),
  ]);
  return a === b;
}

/**
 * Sends prepared items to one target, resuming a matching outbox entry when there is one: same
 * target and item list, and identical file contents/stat. A matching entry whose sources changed
 * is superseded: removed and replaced by a brand-new session (fresh keys, so no nonce reuse).
 * @internal
 */
export async function sendPrepared(id: Identity, t: Target, p: PreparedItems, opts: SendOptions = {}): Promise<SendResult> {
  let entry: OutboxEntry | null = null;
  let sessionId = '';
  try {
    if (opts.outbox) {
      const match = await opts.outbox.findMatch(t.deviceId, p.itemsKey);
      if (match && !active.has(match.sessionId)) {
        if (sameContent(match, p)) entry = match;
        else {
          // Superseded: the old session can never complete; let the receiver drop its partial data.
          await opts.outbox.remove(match.sessionId);
          await postCancel(id, t, match.sessionId);
        }
      }
    }
    if (!entry) {
      const manifest = manifestFor(p, id.deviceId, t.deviceId);
      sessionId = manifest.sessionId;
      const { offer, ctx } = createOffer(id, t.publicKey, manifest);
      entry = {
        v: 1,
        sessionId,
        createdAt: manifest.createdAt,
        target: {
          deviceId: t.deviceId,
          host: t.host,
          port: t.port,
          publicKeyPem: t.publicKey.export({ type: 'spki', format: 'pem' }) as string,
        },
        itemsKey: p.itemsKey,
        offer,
        manifest,
        sources: p.files.map((f) => ({
          fileId: f.fileId,
          path: p.sources.get(f.fileId)!,
          ...p.stats.get(f.fileId)!,
          chunks: p.chunkHashes.get(f.fileId)!,
        })),
        ctxExport: exportCtx(ctx),
      };
      if (opts.outbox) await opts.outbox.save(entry);
    }
  } catch (e) {
    return { deviceId: t.deviceId, status: 'failed', sessionId, error: errorString(e) };
  }
  return runSession(id, t, entry, opts);
}

/**
 * Sends `items` to one device. Never rejects: problems are reported in the SendResult. With
 * `opts.outbox`, calling sendTo again with the same items after a 'cancelled'/'failed' result
 * resumes the same session and PUTs only the chunks the receiver lacks.
 */
export async function sendTo(id: Identity, t: Target, items: SendItem[], opts: SendOptions = {}): Promise<SendResult> {
  let p: PreparedItems;
  try {
    p = await prepareItems(items, opts.signal);
  } catch (e) {
    if (opts.signal?.aborted) return { deviceId: t.deviceId, status: 'cancelled', sessionId: '' };
    return { deviceId: t.deviceId, status: 'failed', sessionId: '', error: errorString(e) };
  }
  return sendPrepared(id, t, p, opts);
}

function parseHave(x: unknown): Map<number, Set<number>> {
  if (!isObj(x)) throw new ProtocolError('bad have map');
  const out = new Map<number, Set<number>>();
  for (const [k, v] of Object.entries(x)) {
    if (!/^(0|[1-9][0-9]*)$/.test(k) || !Array.isArray(v) || !v.every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw new ProtocolError('bad have map');
    }
    out.set(Number(k), new Set(v as number[]));
  }
  return out;
}

function remoteCode(json: unknown): string {
  const c = isObj(json) ? json.error : undefined;
  return typeof c === 'string' && /^[a-z0-9-]{1,64}$/.test(c) ? c : '';
}

/** Runs (or resumes) one outbox entry against `t`. Never rejects. */
async function runSession(id: Identity, t: Target, entry: OutboxEntry, opts: SendOptions): Promise<SendResult> {
  const sessionId = entry.sessionId;
  const base = { deviceId: t.deviceId, sessionId };
  if (active.has(sessionId)) return { ...base, status: 'failed', error: 'already-running' };
  active.add(sessionId);
  const internal = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, internal.signal]) : internal.signal;
  try {
    if (t.deviceId !== entry.target.deviceId) throw new TargetMismatchError();
    const ctx = importCtx(entry.ctxExport);
    await checkSources(entry.sources);
    await transfer(id, t, entry, ctx, signal, internal, opts);
    if (opts.outbox) await opts.outbox.remove(sessionId).catch(() => {});
    return { ...base, status: 'done' };
  } catch (e) {
    if (opts.signal?.aborted) return { ...base, status: 'cancelled' }; // pause: resumable, no cancel
    if (isTerminal(e)) await postCancel(id, t, sessionId);
    return { ...base, status: 'failed', error: errorString(e) };
  } finally {
    internal.abort(); // releases AbortSignal.any's listener on the caller's signal
    active.delete(sessionId);
  }
}

async function checkSources(sources: OutboxSource[]): Promise<void> {
  for (const s of sources) {
    let st;
    try {
      st = await fsp.stat(s.path);
    } catch {
      throw new SourceChangedError(s.path);
    }
    if (!st.isFile() || st.size !== s.size || st.mtimeMs !== s.mtimeMs) throw new SourceChangedError(s.path);
  }
}

/**
 * Positional read of one chunk. Re-checks size/mtime on the open handle, then verifies the chunk's
 * SHA-256 against the one recorded at manifest time, so changed plaintext is never sealed under a
 * seq that may already have been used (size+mtime alone miss `cp -p`, `touch -r`, coarse clocks).
 */
async function readChunk(src: OutboxSource, index: number): Promise<Buffer> {
  const h = await fsp.open(src.path, 'r');
  try {
    const st = await h.stat();
    if (st.size !== src.size || st.mtimeMs !== src.mtimeMs) throw new SourceChangedError(src.path);
    const start = index * CHUNK_SIZE;
    const len = Math.min(CHUNK_SIZE, src.size - start);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await h.read(buf, off, len - off, start + off);
      if (bytesRead === 0) throw new SourceChangedError(src.path);
      off += bytesRead;
    }
    if (createHash('sha256').update(buf).digest('hex') !== src.chunks[index]) throw new SourceChangedError(src.path);
    return buf;
  } finally {
    await h.close();
  }
}

async function transfer(
  id: Identity,
  t: Target,
  entry: OutboxEntry,
  ctx: HpkeContext,
  signal: AbortSignal,
  internal: AbortController,
  opts: SendOptions,
): Promise<void> {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const finalizeTimeoutMs = opts.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY);
  const { sessionId, manifest } = entry;

  /** One request on a fresh pinned connection, with the retry policy. */
  const call = async (
    method: string,
    path: string,
    body: Buffer | undefined,
    headers: Record<string, string | number>,
    reqTimeout: number,
  ): Promise<PinnedResponse> => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError();
      try {
        const sock = await connectPinned(t.host, t.port, id, t.deviceId, { timeoutMs: connectTimeoutMs });
        let res: PinnedResponse;
        try {
          res = await pinnedRequest(sock, method, PREFIX + path, body, headers, { timeoutMs: reqTimeout, signal });
        } catch (e) {
          // tls.ts reports unusable reply bodies as plain Errors; they are not transient.
          if (e instanceof Error && MALFORMED_REPLY.test(e.message)) throw new ProtocolError(e.message);
          throw e;
        }
        if (res.status >= 200 && res.status < 300) return res;
        throw new HttpStatusError(res.status, remoteCode(res.json));
      } catch (e) {
        if (signal.aborted) throw abortError();
        if (!isTransient(e) || attempt >= delays.length) throw e;
        await delay(delays[attempt]!, undefined, { signal }).catch(() => {
          throw abortError();
        });
      }
    }
  };

  const progress = (p: SendProgress) => {
    try {
      opts.onProgress?.(p);
    } catch {
      /* a failing listener must not break the send */
    }
  };

  // 1. offer (the stored, byte-identical Offer)
  const offerRes = await call('POST', 'offer', Buffer.from(JSON.stringify(entry.offer)), { 'content-type': 'application/json' }, timeoutMs);
  const oj = offerRes.json;
  if (isObj(oj) && oj.done === true) return; // already delivered (tombstone)
  if (!isObj(oj)) throw new ProtocolError('bad offer reply');
  const have = parseHave(oj.have);

  // 2. chunks + per-file complete, `concurrency` requests in flight
  const srcById = new Map(entry.sources.map((s) => [s.fileId, s]));
  type Task = { file: FileEntry; index: number }; // index -1: complete only
  const tasks: Task[] = [];
  const remaining = new Map<number, number>();
  const sent = new Map<number, number>();
  for (const f of manifest.files) {
    const got = have.get(f.fileId) ?? new Set<number>();
    const n = chunkCount(f.size);
    let missing = 0;
    let bytes = 0;
    for (let i = 0; i < n; i++) {
      const len = Math.min(CHUNK_SIZE, f.size - i * CHUNK_SIZE);
      if (got.has(i)) bytes += len;
      else {
        tasks.push({ file: f, index: i });
        missing++;
      }
    }
    remaining.set(f.fileId, missing);
    sent.set(f.fileId, bytes);
    if (missing === 0) tasks.push({ file: f, index: -1 });
  }

  const complete = async (f: FileEntry) => {
    try {
      await call('POST', `complete/${sessionId}/${f.fileId}`, undefined, {}, finalizeTimeoutMs);
    } catch (e) {
      // The receiver's whole-file hash disagrees with the manifest (it has discarded the file):
      // the data we sent no longer matches what was hashed. Terminal; resending would reseal seqs.
      if (e instanceof HttpStatusError && e.status === 422 && e.code === 'integrity') {
        throw new SourceChangedError(srcById.get(f.fileId)?.path ?? `file ${f.fileId}`);
      }
      throw e;
    }
  };

  let next = 0;
  let firstErr: unknown;
  const worker = async () => {
    while (firstErr === undefined && !signal.aborted && next < tasks.length) {
      const { file, index } = tasks[next++]!;
      try {
        if (index < 0) {
          await complete(file);
          progress({ fileId: file.fileId, sent: file.size, total: file.size });
          continue;
        }
        const src = srcById.get(file.fileId);
        if (!src) throw new ProtocolError(`no source for file ${file.fileId}`);
        const pt = await readChunk(src, index);
        const ct = sealChunk(ctx, sessionId, file.fileId, index, pt);
        await call('PUT', `chunk/${sessionId}/${file.fileId}/${index}`, ct, { 'content-type': 'application/octet-stream' }, timeoutMs);
        const s = sent.get(file.fileId)! + pt.length;
        sent.set(file.fileId, s);
        progress({ fileId: file.fileId, sent: s, total: file.size });
        const left = remaining.get(file.fileId)! - 1;
        remaining.set(file.fileId, left);
        if (left === 0) await complete(file);
      } catch (e) {
        if (firstErr === undefined) firstErr = e;
        internal.abort(); // stop the other workers' in-flight requests
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(tasks.length, 1)) }, worker));
  if (firstErr !== undefined) throw firstErr;
  if (signal.aborted) throw abortError();

  // 3. finish
  await call('POST', `finish/${sessionId}`, undefined, {}, finalizeTimeoutMs);
}
