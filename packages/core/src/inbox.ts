// Inbox: receives files from remote devices into <root>, with resumable partial state.
//
// Layout: <root>/.meshdrop-partial/<sessionId>/{state.json, progress.log, <fileId>.part}
//   state.json    manifest + ctxExport (key material -> mode 0600), written by begin().
//   progress.log  append-only, one fsynced JSON line per event (mode 0600):
//                   {"c":[fileId,index]}  chunk `index` is durably in <fileId>.part
//                   {"p":[fileId,"rel"]}  finalize is about to link/rename the part to <root>/rel
//                   {"d":[fileId,"rel"]}  file finalized at <root>/rel (rel: '/'-separated, inbox-relative)
//                   {"x":fileId}          file reset (hash mismatch / lost part): forget its chunks
//                 Rewritten compactly (atomic rename) on load and on a repeated begin(), and whenever it
//                 has grown to several times its live content, so the bytes written stay O(chunks + files)
//                 per session. A torn last line (crash mid-append) is ignored on load.
// A chunk is recorded only after its bytes were fsynced. Finalizing a file is crash-safe: record "p"
// (the chosen name), link (or rename) the part there, record "d", then unlink the part; a finalize that
// finds a "p" without a "d" adopts the earlier link/rename instead of creating "name (1)". Manifests are
// untrusted: begin() validates every path up front; finalize()/finalizeDirs() re-sanitize and never
// follow symlinks, so nothing is written outside <root>.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { CHUNK_SIZE, chunkCount, serializeManifest, type FileEntry, type HaveMap, type Manifest } from './chunk.ts';
import { safeRelPath, uniqueName, UnsafePathError } from './sanitize.ts';

export { UnsafePathError };

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}
/** fileId not in manifest, chunk index out of range, or chunk of the wrong length (server: HTTP 409). */
export class ChunkRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkRangeError';
  }
}
export class UnknownSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownSessionError';
  }
}
export class IncompleteFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteFileError';
  }
}

export interface InboxOptions { fs?: typeof nodeFs }
export const PARTIAL_DIR = '.meshdrop-partial';
/** Tombstones of finished sessions live in <root>/.meshdrop-partial/.finished/<sessionId>.json. */
const FINISHED_DIR = '.finished';
export const FINISHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Partial sessions not touched for this long are removed by prune() (default). */
export const PARTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOG = 'progress.log';
/** Compact the log once it holds more than LOG_SLACK x its live records (+ LOG_MIN_LINES). */
const LOG_SLACK = 4;
const LOG_MIN_LINES = 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HASH_BUF = 1024 * 1024;
const NO_HARDLINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EACCES']);

interface Session {
  manifest: Manifest;
  ctxExport: string;
  files: Map<number, FileEntry>;
  /** Chunks on disk per not-yet-finalized file. */
  have: Map<number, Set<number>>;
  /** Finalized fileId -> inbox-relative final path. */
  done: Map<number, string>;
  /** fileId -> inbox-relative path a finalize was about to link/rename to (no "d" yet). */
  pending: Map<number, string>;
  /** Lines in progress.log, and records a compacted log would hold (compaction trigger). */
  logLines: number;
  live: number;
  /**
   * Incoming top-level folder name -> local name, for folders whose name an existing non-directory
   * in the inbox already uses (decided once, at begin(), and kept in state.json for resume).
   */
  tops: Record<string, string>;
}
type LogRecord = { c: [number, number] } | { p: [number, string] } | { d: [number, string] } | { x: number };

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

const isTops = (x: unknown): x is Record<string, string> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every((v) => typeof v === 'string');

/** safeRelPath plus inbox-specific rules: non-empty, and never inside the partial area. */
function inboxRelParts(p: string): string[] {
  const rel = safeRelPath(p);
  if (rel === '') throw new UnsafePathError('empty path');
  const parts = rel.split('/');
  if (parts[0]!.toLowerCase() === PARTIAL_DIR) throw new UnsafePathError('reserved directory name');
  return parts;
}

export class Inbox {
  readonly root: string;
  private readonly fs: typeof nodeFs;
  private readonly sessions = new Map<string, Promise<Session | null>>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string, opts: InboxOptions = {}) {
    this.root = root;
    this.fs = opts.fs ?? nodeFs;
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private sessionDir(sessionId: string): string {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new UnsafePathError('invalid sessionId');
    return `${this.root}/${PARTIAL_DIR}/${sessionId}`;
  }

  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp`;
    const h = await this.fs.open(tmp, 'w', 0o600);
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
    await this.fs.rename(tmp, path);
  }

  /** Applies one log record to the in-memory state; false if the record is malformed. */
  private apply(s: Session, r: unknown): boolean {
    if (typeof r !== 'object' || r === null) return false;
    const o = r as Record<string, unknown>;
    const isId = (v: unknown): v is number => Number.isInteger(v) && s.files.has(v as number);
    if (Array.isArray(o.c) && isId(o.c[0]) && Number.isInteger(o.c[1])) {
      const [id, i] = o.c as [number, number];
      if (s.done.has(id)) return true;
      let set = s.have.get(id);
      if (!set) s.have.set(id, (set = new Set()));
      if (!set.has(i)) {
        set.add(i);
        s.live++;
      }
      return true;
    }
    if (Array.isArray(o.p) && isId(o.p[0]) && typeof o.p[1] === 'string') {
      if (s.done.has(o.p[0])) return true;
      if (!s.pending.has(o.p[0])) s.live++;
      s.pending.set(o.p[0], o.p[1]);
      return true;
    }
    if (Array.isArray(o.d) && isId(o.d[0]) && typeof o.d[1] === 'string') {
      const id = o.d[0];
      this.forget(s, id);
      if (!s.done.has(id)) s.live++;
      s.done.set(id, o.d[1]);
      return true;
    }
    if (isId(o.x)) {
      this.forget(s, o.x);
      return true;
    }
    return false;
  }

  /** Drops a file's chunk set and pending name from the in-memory state. */
  private forget(s: Session, id: number): void {
    s.live -= (s.have.get(id)?.size ?? 0) + (s.pending.has(id) ? 1 : 0);
    s.have.delete(id);
    s.pending.delete(id);
  }

  /** Rewrites progress.log with exactly the live records (atomic). */
  private async compact(sessionId: string, s: Session): Promise<void> {
    const lines: string[] = [];
    for (const [id, set] of s.have) for (const i of [...set].sort((a, b) => a - b)) lines.push(JSON.stringify({ c: [id, i] }));
    for (const [id, rel] of s.pending) lines.push(JSON.stringify({ p: [id, rel] }));
    for (const [id, rel] of s.done) lines.push(JSON.stringify({ d: [id, rel] }));
    await this.writeAtomic(`${this.sessionDir(sessionId)}/${LOG}`, lines.length ? lines.join('\n') + '\n' : '');
    s.logLines = s.live = lines.length;
  }

  /** Durably appends one record (call under lock(sessionId)), then applies it in memory. */
  private async append(sessionId: string, s: Session, r: LogRecord): Promise<void> {
    const h = await this.fs.open(`${this.sessionDir(sessionId)}/${LOG}`, 'a', 0o600);
    try {
      await h.write(JSON.stringify(r) + '\n');
      await h.sync();
    } finally {
      await h.close();
    }
    this.apply(s, r);
    s.logLines++;
    if (s.logLines > LOG_SLACK * s.live + LOG_MIN_LINES) await this.compact(sessionId, s);
  }

  private record(sessionId: string, s: Session, r: LogRecord): Promise<void> {
    return this.lock(sessionId, () => this.append(sessionId, s, r));
  }

  private async readText(path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(path, 'utf8');
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
  }

  private async readJson(path: string): Promise<unknown | null> {
    const text = await this.readText(path);
    return text === null ? null : JSON.parse(text);
  }

  // Cached as a promise so concurrent callers share one Session object (and one in-memory chunk set).
  private getSession(sessionId: string): Promise<Session | null> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const p = this.loadSession(sessionId);
    this.sessions.set(sessionId, p);
    p.then((s) => { if (!s && this.sessions.get(sessionId) === p) this.sessions.delete(sessionId); },
      () => { if (this.sessions.get(sessionId) === p) this.sessions.delete(sessionId); });
    return p;
  }

  private newSession(manifest: Manifest, ctxExport: string, tops: Record<string, string> = {}): Session {
    return {
      manifest,
      ctxExport,
      tops,
      files: new Map(manifest.files.map((f) => [f.fileId, f])),
      have: new Map(),
      done: new Map(),
      pending: new Map(),
      logLines: 0,
      live: 0,
    };
  }

  private async loadSession(sessionId: string): Promise<Session | null> {
    const dir = this.sessionDir(sessionId);
    const st = (await this.readJson(`${dir}/state.json`)) as { manifest: Manifest; ctxExport: string; tops?: Record<string, string> } | null;
    if (!st) return null;
    const s = this.newSession(st.manifest, st.ctxExport, isTops(st.tops) ? st.tops : {});
    const text = await this.readText(`${dir}/${LOG}`);
    if (text === null) return s;
    // Malformed lines (only ever a torn last line, since the log is compacted before anything is
    // appended to it again) are skipped: a lost "c" just means that chunk is requested again.
    let lines = 0;
    let bad = 0;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      lines++;
      let r: unknown;
      try {
        r = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      if (!this.apply(s, r)) bad++;
    }
    s.logLines = lines;
    if (bad > 0 || !text.endsWith('\n') || lines > s.live) await this.compact(sessionId, s);
    return s;
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const s = await this.getSession(sessionId);
    if (!s) throw new UnknownSessionError('unknown session');
    return s;
  }

  /** Create (walking from root, refusing symlinks) the directory for `parts`; returns its path. */
  private async ensureDir(parts: string[]): Promise<string> {
    await this.fs.mkdir(this.root, { recursive: true });
    let cur = this.root;
    for (const part of parts) {
      cur = `${cur}/${part}`;
      let st;
      try {
        st = await this.fs.lstat(cur);
      } catch (e) {
        if (code(e) !== 'ENOENT') throw e;
        try {
          await this.fs.mkdir(cur);
        } catch (e2) {
          if (code(e2) !== 'EEXIST') throw e2;
        }
        st = await this.fs.lstat(cur);
      }
      if (st.isSymbolicLink()) throw new UnsafePathError('symlink in destination path');
      if (!st.isDirectory()) throw Object.assign(new Error(`${cur} exists and is not a directory`), { code: 'ENOTDIR' });
    }
    return cur;
  }

  /**
   * Top-level folders of `m` whose name is taken in the inbox by something that is not a directory
   * (a file, a symlink): each gets a free name such as "Photos (1)" for this whole session.
   * An existing directory of that name is merged into as usual.
   */
  private async mapTops(m: Manifest): Promise<Record<string, string>> {
    const folders = new Set<string>();
    for (const f of m.files) {
      const parts = inboxRelParts(f.path);
      if (parts.length > 1) folders.add(parts[0]!);
    }
    for (const d of m.dirs) folders.add(inboxRelParts(d.path)[0]!);
    const tops: Record<string, string> = {};
    for (const name of folders) {
      const st = await this.statOrNullL(`${this.root}/${name}`);
      if (st && !st.isDirectory()) {
        await this.fs.mkdir(this.root, { recursive: true });
        tops[name] = await uniqueName(this.root, name, this.fs);
      }
    }
    return tops;
  }

  private async statOrNullL(p: string): Promise<Awaited<ReturnType<typeof nodeFs.lstat>> | null> {
    try {
      return await this.fs.lstat(p);
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
  }

  /** The inbox-relative parts for `p` in session `s` (its top-level folder mapped, if needed). */
  private destParts(s: Session, p: string, isDir: boolean): string[] {
    const parts = inboxRelParts(p);
    if ((parts.length > 1 || isDir) && s.tops[parts[0]!] !== undefined) parts[0] = s.tops[parts[0]!]!;
    return parts;
  }

  // ---- public API ------------------------------------------------------------------------------

  async begin(sessionId: string, manifest: Manifest, ctxExport: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    for (const f of manifest.files) inboxRelParts(f.path);
    for (const d of manifest.dirs) inboxRelParts(d.path);
    await this.lock(sessionId, async () => {
      const existing = await this.getSession(sessionId);
      if (existing && serializeManifest(existing.manifest) === serializeManifest(manifest)) {
        // Same manifest: keep the progress (compacted) and folder mapping, refresh the stored context.
        await this.writeAtomic(`${dir}/state.json`, JSON.stringify({ manifest, ctxExport, tops: existing.tops }));
        existing.ctxExport = ctxExport;
        await this.compact(sessionId, existing);
        return;
      }
      // A different manifest under the same sessionId invalidates any earlier progress.
      // (Also clears leftovers of a begin() that crashed before state.json was written.)
      this.sessions.delete(sessionId);
      await this.fs.rm(dir, { recursive: true, force: true });
      await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tops = await this.mapTops(manifest);
      await this.writeAtomic(`${dir}/state.json`, JSON.stringify({ manifest, ctxExport, tops }));
      this.sessions.set(sessionId, Promise.resolve(this.newSession(manifest, ctxExport, tops)));
    });
  }

  async load(sessionId: string): Promise<{ manifest: Manifest; ctxExport: string } | null> {
    const s = await this.getSession(sessionId);
    return s ? { manifest: s.manifest, ctxExport: s.ctxExport } : null;
  }

  /** Chunk indices on disk per file (a finalized file reports all of its chunks). */
  async have(sessionId: string): Promise<HaveMap> {
    const s = await this.getSession(sessionId);
    const out: HaveMap = {};
    if (!s) return out;
    for (const [id, set] of s.have) if (set.size) out[id] = [...set].sort((a, b) => a - b);
    for (const id of s.done.keys()) {
      const n = chunkCount(s.files.get(id)!.size);
      if (n > 0) out[id] = Array.from({ length: n }, (_, i) => i);
    }
    return out;
  }

  /** How many chunks of `fileId` are on disk (all of them once finalized); 0 for an unknown session. */
  async haveCount(sessionId: string, fileId: number): Promise<number> {
    const s = await this.getSession(sessionId);
    if (!s) return 0;
    const f = s.files.get(fileId);
    if (f && s.done.has(fileId)) return chunkCount(f.size);
    return s.have.get(fileId)?.size ?? 0;
  }

  /** Whether `fileId` has been finalized. */
  async isDone(sessionId: string, fileId: number): Promise<boolean> {
    const s = await this.requireSession(sessionId);
    return s.done.has(fileId);
  }

  /** `abs` relative to the inbox root ('/'-separated), as returned to peers on the wire. */
  relative(abs: string): string {
    return abs.startsWith(`${this.root}/`) ? abs.slice(this.root.length + 1) : abs;
  }

  async writeChunk(sessionId: string, fileId: number, index: number, pt: Buffer): Promise<void> {
    const s = await this.requireSession(sessionId);
    const file = s.files.get(fileId);
    if (!file) throw new ChunkRangeError(`unknown fileId ${fileId}`);
    const count = chunkCount(file.size);
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new ChunkRangeError(`chunk index ${index} out of range`);
    const expected = index === count - 1 ? file.size - index * CHUNK_SIZE : CHUNK_SIZE;
    if (pt.length !== expected) throw new ChunkRangeError(`chunk ${index} must be ${expected} bytes, got ${pt.length}`);
    if (s.done.has(fileId)) return; // already finalized; late duplicate

    const part = `${this.sessionDir(sessionId)}/${fileId}.part`;
    const h = await this.fs.open(part, constants.O_RDWR | constants.O_CREAT, 0o666);
    try {
      let off = 0;
      while (off < pt.length) {
        const { bytesWritten } = await h.write(pt, off, pt.length - off, index * CHUNK_SIZE + off);
        off += bytesWritten;
      }
      await h.sync();
    } finally {
      await h.close();
    }
    await this.lock(sessionId, async () => {
      if (s.done.has(fileId) || s.have.get(fileId)?.has(index)) return;
      await this.append(sessionId, s, { c: [fileId, index] });
    });
  }

  /** Forget a file's chunks (recorded first, then its part is removed) so the sender resends it. */
  private async resetFile(sessionId: string, s: Session, fileId: number): Promise<void> {
    await this.record(sessionId, s, { x: fileId });
    await this.fs.rm(`${this.sessionDir(sessionId)}/${fileId}.part`, { force: true });
  }

  private async statOrNull(path: string) {
    try {
      return await this.fs.lstat(path);
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * A previous finalize recorded "p" (about to link/rename to `rel`) but not "d". If that step
   * happened, adopt it: the part and `rel` are the same inode (crash after link), or the part is
   * gone and `rel` holds a file with the manifest's size and hash (crash after rename).
   */
  private async recover(sessionId: string, s: Session, file: FileEntry, rel: string): Promise<string | null> {
    const relParts = inboxRelParts(rel);
    if (relParts.join('/') !== rel) return null; // not something finalize() wrote
    await this.ensureDir(relParts.slice(0, -1)); // refuses symlinked parents
    const finalPath = `${this.root}/${rel}`;
    const part = `${this.sessionDir(sessionId)}/${file.fileId}.part`;
    const fst = await this.statOrNull(finalPath);
    if (!fst?.isFile()) return null;
    const pst = await this.statOrNull(part);
    if (pst) {
      if (pst.ino !== fst.ino || pst.dev !== fst.dev) return null; // someone else's file took the name
      await this.record(sessionId, s, { d: [file.fileId, rel] });
      await this.unlinkPart(part);
      return finalPath;
    }
    if (fst.size !== file.size || (await this.hashFile(finalPath, file.size)) !== file.sha256) return null;
    await this.record(sessionId, s, { d: [file.fileId, rel] });
    return finalPath;
  }

  private async unlinkPart(part: string): Promise<void> {
    try {
      await this.fs.unlink(part);
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e;
    }
  }

  async finalize(sessionId: string, fileId: number): Promise<string> {
    return this.lock(`${sessionId}/${fileId}`, async () => {
      const s = await this.requireSession(sessionId);
      const file = s.files.get(fileId);
      if (!file) throw new ChunkRangeError(`unknown fileId ${fileId}`);
      const doneAt = s.done.get(fileId);
      if (doneAt !== undefined) return `${this.root}/${doneAt}`;

      const pendingRel = s.pending.get(fileId);
      if (pendingRel !== undefined) {
        const recovered = await this.recover(sessionId, s, file, pendingRel);
        if (recovered !== null) return recovered;
      }

      const part = `${this.sessionDir(sessionId)}/${fileId}.part`;
      const count = chunkCount(file.size);
      const have = s.have.get(fileId) ?? new Set<number>();
      for (let i = 0; i < count; i++) if (!have.has(i)) throw new IncompleteFileError(`file ${fileId} is missing chunk ${i}`);
      if (file.size === 0) await (await this.fs.open(part, constants.O_RDWR | constants.O_CREAT, 0o666)).close();

      let actual: string;
      try {
        actual = await this.hashFile(part, file.size);
      } catch (e) {
        if (code(e) !== 'ENOENT') throw e;
        // The recorded chunks are gone (deleted behind our back): start this file over.
        await this.resetFile(sessionId, s, fileId);
        throw new IncompleteFileError(`file ${fileId}: partial data is missing`);
      }
      if (actual !== file.sha256) {
        // Corrupt data on disk: discard it so the sender restarts this file from scratch.
        await this.resetFile(sessionId, s, fileId);
        throw new IntegrityError(`sha256 mismatch for file ${fileId}`);
      }

      const parts = this.destParts(s, file.path, false);
      const base = parts.pop()!;
      const destDir = await this.ensureDir(parts);
      for (;;) {
        const name = await uniqueName(destDir, base, this.fs);
        const rel = [...parts, name].join('/');
        const finalPath = `${destDir}/${name}`;
        await this.record(sessionId, s, { p: [fileId, rel] });
        let linked = true;
        try {
          await this.fs.link(part, finalPath); // atomic, never overwrites
        } catch (e) {
          if (code(e) === 'EEXIST') continue; // lost a race for this name; pick the next
          if (!NO_HARDLINK.has(code(e) ?? '')) throw e;
          // Filesystem without hardlinks: plain rename (tiny overwrite window, name was just checked free).
          await this.fs.rename(part, finalPath);
          linked = false;
        }
        await this.record(sessionId, s, { d: [fileId, rel] });
        if (linked) await this.unlinkPart(part);
        return finalPath;
      }
    });
  }

  private async hashFile(path: string, size: number): Promise<string> {
    const h = await this.fs.open(path, 'r');
    try {
      const st = await h.stat();
      if (st.size !== size) return 'size-mismatch';
      const hash = createHash('sha256');
      const buf = Buffer.allocUnsafe(HASH_BUF);
      let pos = 0;
      while (pos < size) {
        const { bytesRead } = await h.read(buf, 0, Math.min(HASH_BUF, size - pos), pos);
        if (bytesRead === 0) return 'short-read';
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      return hash.digest('hex');
    } finally {
      await h.close();
    }
  }

  async finalizeDirs(sessionId: string): Promise<void> {
    const s = await this.requireSession(sessionId);
    for (const d of s.manifest.dirs) await this.ensureDir(this.destParts(s, d.path, true));
  }

  /** fileIds already finalized into their final path (idempotent `finalize` returns the path). */
  async completed(sessionId: string): Promise<number[]> {
    const s = await this.requireSession(sessionId);
    return [...s.done.keys()].sort((a, b) => a - b);
  }

  /**
   * Leaves a tombstone so a retried `finish` / re-offer of a delivered session can be answered
   * without re-receiving it (`files`: the inbox-relative paths sent on the wire). Written
   * atomically (0600); tombstones older than 7 days are pruned.
   */
  async markFinished(sessionId: string, info: { from: string; files: string[] }): Promise<void> {
    this.sessionDir(sessionId); // validates the id
    const dir = `${this.root}/${PARTIAL_DIR}/${FINISHED_DIR}`;
    await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.writeAtomic(`${dir}/${sessionId}.json`, JSON.stringify({ from: info.from, files: info.files }));
    await this.pruneTombstones();
  }

  /** Removes tombstones older than FINISHED_TTL_MS. Best effort, never throws. */
  private async pruneTombstones(): Promise<void> {
    const dir = `${this.root}/${PARTIAL_DIR}/${FINISHED_DIR}`;
    try {
      const cutoff = Date.now() - FINISHED_TTL_MS;
      for (const name of await this.fs.readdir(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          if ((await this.fs.stat(`${dir}/${name}`)).mtimeMs < cutoff) await this.fs.rm(`${dir}/${name}`, { force: true });
        } catch {
          /* raced with another prune */
        }
      }
    } catch {
      /* pruning is best effort */
    }
  }

  /**
   * Removes partial sessions whose state was last touched more than `partialMaxAgeMs` ago (default
   * 30 days: the sender abandoned them without a `cancel`), and tombstones older than 7 days.
   * "Touched" is the newest mtime of the session dir, state.json and progress.log (every recorded
   * chunk appends to the log). Returns the pruned session ids. Run it when the receiver starts.
   */
  async prune(opts: { partialMaxAgeMs?: number } = {}): Promise<string[]> {
    const maxAge = opts.partialMaxAgeMs ?? PARTIAL_TTL_MS;
    const base = `${this.root}/${PARTIAL_DIR}`;
    let names: string[];
    try {
      names = await this.fs.readdir(base);
    } catch (e) {
      if (code(e) === 'ENOENT') return [];
      throw e;
    }
    const cutoff = Date.now() - maxAge;
    const pruned: string[] = [];
    for (const name of names.sort()) {
      if (!SESSION_ID_RE.test(name)) continue;
      const dir = `${base}/${name}`;
      let newest = -Infinity;
      for (const p of [dir, `${dir}/state.json`, `${dir}/${LOG}`]) {
        const st = await this.statOrNull(p).catch(() => null);
        if (st) newest = Math.max(newest, st.mtimeMs);
      }
      if (newest === -Infinity || newest >= cutoff) continue;
      await this.lock(name, async () => {
        this.sessions.delete(name);
        await this.fs.rm(dir, { recursive: true, force: true });
      });
      pruned.push(name);
    }
    await this.pruneTombstones();
    return pruned;
  }

  async finished(sessionId: string): Promise<{ from: string; files: string[] } | null> {
    this.sessionDir(sessionId);
    const v = (await this.readJson(`${this.root}/${PARTIAL_DIR}/${FINISHED_DIR}/${sessionId}.json`)) as
      { from?: unknown; files?: unknown } | null;
    if (!v) return null;
    if (typeof v.from !== 'string' || !Array.isArray(v.files) || !v.files.every((f) => typeof f === 'string')) return null;
    return { from: v.from, files: v.files as string[] };
  }

  async drop(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await this.lock(sessionId, async () => {
      this.sessions.delete(sessionId);
      await this.fs.rm(dir, { recursive: true, force: true });
    });
  }
}
