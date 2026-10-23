// Inbox: receives files from remote devices into <root>, with resumable partial state.
//
// Layout: <root>/.meshdrop-partial/<sessionId>/{state.json, progress.json, <fileId>.part}
//   state.json     manifest + ctxExport (key material -> mode 0600), written once by begin().
//   progress.json  chunk indices durably on disk per file + finalized files; rewritten atomically.
//                  (Kept apart from state.json so a 100k-file manifest is not rewritten per chunk.)
// A chunk is recorded in progress.json only after its bytes were fsynced. Manifests are untrusted:
// begin() validates every path up front; finalize()/finalizeDirs() re-sanitize and never follow
// symlinks, so nothing is written outside <root>.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { CHUNK_SIZE, chunkCount, serializeManifest, type HaveMap, type Manifest } from './chunk.ts';
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
const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HASH_BUF = 1024 * 1024;
const NO_HARDLINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EACCES']);

interface Session {
  manifest: Manifest;
  ctxExport: string;
  have: Map<number, Set<number>>;
  done: Map<number, string>; // finalized fileId -> final path
}
interface ProgressFile { have: { [fileId: string]: number[] }; done: { [fileId: string]: string } }

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

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

  private async persistProgress(sessionId: string, s: Session): Promise<void> {
    const pf: ProgressFile = { have: {}, done: {} };
    for (const [id, set] of s.have) if (set.size) pf.have[id] = [...set].sort((a, b) => a - b);
    for (const [id, p] of s.done) pf.done[id] = p;
    await this.writeAtomic(`${this.sessionDir(sessionId)}/progress.json`, JSON.stringify(pf));
  }

  private async readJson(path: string): Promise<unknown | null> {
    let text: string;
    try {
      text = await this.fs.readFile(path, 'utf8');
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
    return JSON.parse(text);
  }

  // Cached as a promise so concurrent callers share one Session object (and one in-memory chunk set).
  private getSession(sessionId: string): Promise<Session | null> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const dir = this.sessionDir(sessionId);
    const p = this.loadSession(dir);
    this.sessions.set(sessionId, p);
    p.then((s) => { if (!s && this.sessions.get(sessionId) === p) this.sessions.delete(sessionId); },
      () => { if (this.sessions.get(sessionId) === p) this.sessions.delete(sessionId); });
    return p;
  }

  private async loadSession(dir: string): Promise<Session | null> {
    const st = (await this.readJson(`${dir}/state.json`)) as { manifest: Manifest; ctxExport: string } | null;
    if (!st) return null;
    const pf = ((await this.readJson(`${dir}/progress.json`)) as ProgressFile | null) ?? { have: {}, done: {} };
    const s: Session = { manifest: st.manifest, ctxExport: st.ctxExport, have: new Map(), done: new Map() };
    for (const [id, arr] of Object.entries(pf.have)) s.have.set(Number(id), new Set(arr));
    for (const [id, p] of Object.entries(pf.done)) s.done.set(Number(id), p);
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

  // ---- public API ------------------------------------------------------------------------------

  async begin(sessionId: string, manifest: Manifest, ctxExport: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    for (const f of manifest.files) inboxRelParts(f.path);
    for (const d of manifest.dirs) inboxRelParts(d.path);
    await this.lock(sessionId, async () => {
      const existing = await this.getSession(sessionId);
      // A different manifest under the same sessionId invalidates any earlier progress.
      if (existing && serializeManifest(existing.manifest) !== serializeManifest(manifest)) {
        await this.fs.rm(dir, { recursive: true, force: true });
        this.sessions.delete(sessionId);
      }
      await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await this.writeAtomic(`${dir}/state.json`, JSON.stringify({ manifest, ctxExport }));
      this.sessions.delete(sessionId); // re-read lazily; keeps progress.json if the manifest matched
    });
  }

  async load(sessionId: string): Promise<{ manifest: Manifest; ctxExport: string } | null> {
    const s = await this.getSession(sessionId);
    return s ? { manifest: s.manifest, ctxExport: s.ctxExport } : null;
  }

  async have(sessionId: string): Promise<HaveMap> {
    const s = await this.getSession(sessionId);
    const out: HaveMap = {};
    if (!s) return out;
    for (const [id, set] of s.have) if (set.size) out[id] = [...set].sort((a, b) => a - b);
    return out;
  }

  async writeChunk(sessionId: string, fileId: number, index: number, pt: Buffer): Promise<void> {
    const s = await this.requireSession(sessionId);
    const file = s.manifest.files.find((f) => f.fileId === fileId);
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
      let set = s.have.get(fileId);
      if (!set) s.have.set(fileId, (set = new Set()));
      if (set.has(index)) return;
      set.add(index);
      try {
        await this.persistProgress(sessionId, s);
      } catch (e) {
        set.delete(index);
        throw e;
      }
    });
  }

  async finalize(sessionId: string, fileId: number): Promise<string> {
    return this.lock(`${sessionId}/${fileId}`, async () => {
      const s = await this.requireSession(sessionId);
      const file = s.manifest.files.find((f) => f.fileId === fileId);
      if (!file) throw new ChunkRangeError(`unknown fileId ${fileId}`);
      const doneAt = s.done.get(fileId);
      if (doneAt !== undefined) return doneAt;

      const dir = this.sessionDir(sessionId);
      const part = `${dir}/${fileId}.part`;
      const count = chunkCount(file.size);
      const have = s.have.get(fileId) ?? new Set<number>();
      for (let i = 0; i < count; i++) if (!have.has(i)) throw new IncompleteFileError(`file ${fileId} is missing chunk ${i}`);
      if (file.size === 0) await (await this.fs.open(part, constants.O_RDWR | constants.O_CREAT, 0o666)).close();

      const actual = await this.hashFile(part, file.size);
      if (actual !== file.sha256) {
        // Corrupt data on disk: discard it so the sender restarts this file from scratch.
        await this.fs.rm(part, { force: true });
        await this.lock(sessionId, async () => {
          s.have.delete(fileId);
          await this.persistProgress(sessionId, s);
        });
        throw new IntegrityError(`sha256 mismatch for file ${fileId}`);
      }

      const parts = inboxRelParts(file.path);
      const base = parts.pop()!;
      const destDir = await this.ensureDir(parts);
      let finalPath = '';
      for (;;) {
        finalPath = `${destDir}/${await uniqueName(destDir, base, this.fs)}`;
        try {
          await this.fs.link(part, finalPath); // atomic, never overwrites
          await this.fs.unlink(part);
          break;
        } catch (e) {
          if (code(e) === 'EEXIST') continue; // lost a race for this name; pick the next
          if (!NO_HARDLINK.has(code(e) ?? '')) throw e;
          // Filesystem without hardlinks: plain rename (tiny overwrite window, name was just checked free).
          await this.fs.rename(part, finalPath);
          break;
        }
      }
      await this.lock(sessionId, async () => {
        s.done.set(fileId, finalPath);
        await this.persistProgress(sessionId, s);
      });
      return finalPath;
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
    for (const d of s.manifest.dirs) await this.ensureDir(inboxRelParts(d.path));
  }

  async drop(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await this.lock(sessionId, async () => {
      this.sessions.delete(sessionId);
      await this.fs.rm(dir, { recursive: true, force: true });
    });
  }
}
