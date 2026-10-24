// The hub's store of internet guest links (M5b): <dir>/<id>/{link.json, manifest, f<i>} with every file
// sealed under the link key (links/crypto.ts). The key itself is never stored: link.json keeps its
// SHA-256 to recognise it on uploads. Password (scrypt), expiry, download cap and revoke are enforced here.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { LINK_CHUNK, keyHash, linkChunkCount, newLinkId, newLinkKey, sealChunk, sealManifest, type LinkManifest } from './crypto.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const DEFAULT_LINK_QUOTA_BYTES = 10 * 1024 ** 3;
export const MIN_LINK_TTL_MS = 3_600_000;
export const MAX_LINK_TTL_MS = 30 * 24 * 3_600_000;
export const DEFAULT_LINK_TTL_MS = 7 * 24 * 3_600_000;
export const LINK_SESSION_MS = 3_600_000;
const MAX_TRIES = 5;
const TRY_WINDOW_MS = 600_000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

export class LinkError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'LinkError';
    this.status = status;
    this.code = code;
  }
}

interface LinkMeta {
  v: 1;
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  keyHash: string;
  files: { size: number }[];
  bytes: number;
  password?: { salt: string; hash: string };
  maxDownloads?: number;
  downloads: number;
  allowUploads: boolean;
}

export interface LinkInfo {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  files: number;
  bytes: number;
  downloads: number;
  maxDownloads?: number;
  hasPassword: boolean;
  allowUploads: boolean;
}

export interface LinkCreate {
  files: string[];
  text?: string;
  expiresInMs?: number;
  password?: string;
  maxDownloads?: number;
  allowUploads?: boolean;
}

const sealedSize = (size: number) => size + 16 * linkChunkCount(size);

export class LinkStore {
  readonly #dir: string;
  readonly #quota: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, { id: string; until: number }>();
  readonly #tries = new Map<string, number[]>();
  /** One open() at a time per link: the download cap is check-then-write. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(dir: string, opts: { quotaBytes?: number; now?: () => number } = {}) {
    this.#dir = dir;
    this.#quota = opts.quotaBytes ?? DEFAULT_LINK_QUOTA_BYTES;
    this.#now = opts.now ?? Date.now;
  }

  #path(id: string, ...rest: string[]): string {
    if (!ID_RE.test(id)) throw new LinkError(404, 'not-found');
    return join(this.#dir, id, ...rest);
  }

  async #meta(id: string): Promise<LinkMeta> {
    let m: LinkMeta;
    try {
      m = JSON.parse(await fsp.readFile(this.#path(id, 'link.json'), 'utf8')) as LinkMeta;
    } catch (e) {
      if (e instanceof LinkError) throw e;
      throw new LinkError(404, 'not-found');
    }
    if (this.#now() >= m.expiresAt) throw new LinkError(410, 'expired');
    return m;
  }

  async #write(m: LinkMeta, dir = this.#path(m.id)): Promise<void> {
    const tmp = join(dir, `link.json.${randomBytes(4).toString('hex')}`);
    await fsp.writeFile(tmp, JSON.stringify(m), { mode: 0o600 });
    await fsp.rename(tmp, join(dir, 'link.json'));
  }

  async #used(): Promise<number> {
    let n = 0;
    for (const l of await this.list()) n += l.bytes;
    return n;
  }

  /** Seals the files into a new link; returns its id and key (the key is not kept). */
  async create(c: LinkCreate): Promise<{ id: string; key: Buffer; expiresAt: number }> {
    const ttl = c.expiresInMs ?? DEFAULT_LINK_TTL_MS;
    if (!Number.isFinite(ttl) || ttl < MIN_LINK_TTL_MS || ttl > MAX_LINK_TTL_MS) throw new LinkError(400, 'bad-expiry');
    if (c.maxDownloads !== undefined && (!Number.isInteger(c.maxDownloads) || c.maxDownloads < 1 || c.maxDownloads > 1000)) throw new LinkError(400, 'bad-max-downloads');
    if (c.files.length === 0 && !c.text) throw new LinkError(400, 'empty');
    const stats = await Promise.all(c.files.map((p) => fsp.stat(p)));
    if (stats.some((s) => !s.isFile())) throw new LinkError(400, 'not-a-file');
    const bytes = stats.reduce((n, s) => n + sealedSize(s.size), 0);
    if (bytes > this.#quota - (await this.#used())) throw new LinkError(507, 'quota');

    const id = newLinkId();
    const key = newLinkKey();
    const now = this.#now();
    const tmp = join(this.#dir, `.new-${id}`);
    await fsp.mkdir(tmp, { recursive: true, mode: 0o700 });
    try {
      const manifest: LinkManifest = { v: 1, files: c.files.map((p, i) => ({ name: basename(p), size: stats[i]!.size })), ...(c.text ? { text: c.text } : {}) };
      await fsp.writeFile(join(tmp, 'manifest'), sealManifest(key, id, manifest));
      for (const [i, p] of c.files.entries()) await this.#sealFile(key, id, i, p, stats[i]!.size, join(tmp, `f${i}`));
      const meta: LinkMeta = {
        v: 1, id, label: c.files.length ? `${basename(c.files[0]!)}${c.files.length > 1 ? ` +${c.files.length - 1}` : ''}` : 'message',
        createdAt: now, expiresAt: now + ttl, keyHash: keyHash(key), files: stats.map((s) => ({ size: s.size })), bytes,
        downloads: 0, allowUploads: c.allowUploads === true,
        ...(c.maxDownloads !== undefined ? { maxDownloads: c.maxDownloads } : {}),
      };
      if (c.password) {
        const salt = randomBytes(16);
        meta.password = { salt: salt.toString('base64'), hash: (await scrypt(c.password, salt, 32, SCRYPT)).toString('base64') };
      }
      await this.#write(meta, tmp);
      await fsp.rename(tmp, join(this.#dir, id));
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true });
      throw e;
    }
    return { id, key, expiresAt: now + ttl };
  }

  async #sealFile(key: Buffer, id: string, i: number, src: string, size: number, dest: string): Promise<void> {
    const out = await fsp.open(dest, 'w', 0o600);
    try {
      const n = linkChunkCount(size);
      let idx = 0;
      let buf: Buffer = Buffer.alloc(0);
      for await (const c of createReadStream(src, { highWaterMark: LINK_CHUNK })) {
        buf = buf.length ? Buffer.concat([buf, c as Buffer]) : (c as Buffer);
        while (buf.length >= LINK_CHUNK && idx < n - 1) {
          await out.write(sealChunk(key, id, i, idx, false, buf.subarray(0, LINK_CHUNK)));
          buf = buf.subarray(LINK_CHUNK);
          idx++;
        }
      }
      if (idx !== n - 1 || buf.length !== size - idx * LINK_CHUNK) throw new LinkError(409, 'file-changed');
      await out.write(sealChunk(key, id, i, idx, true, buf));
    } finally {
      await out.close();
    }
  }

  async list(): Promise<LinkInfo[]> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.#dir);
    } catch {
      return [];
    }
    const out: LinkInfo[] = [];
    for (const n of names) {
      if (!ID_RE.test(n)) continue;
      try {
        const m = JSON.parse(await fsp.readFile(join(this.#dir, n, 'link.json'), 'utf8')) as LinkMeta;
        out.push({
          id: m.id, label: m.label, createdAt: m.createdAt, expiresAt: m.expiresAt, files: m.files.length, bytes: m.bytes,
          downloads: m.downloads, hasPassword: !!m.password, allowUploads: m.allowUploads,
          ...(m.maxDownloads !== undefined ? { maxDownloads: m.maxDownloads } : {}),
        });
      } catch {
        /* half-created: prune() removes it */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async revoke(id: string): Promise<void> {
    await fsp.rm(this.#path(id), { recursive: true, force: true });
    for (const [t, s] of this.#sessions) if (s.id === id) this.#sessions.delete(t);
  }

  /** Deletes expired links and leftovers of interrupted creates. */
  async prune(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.#dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(this.#dir, n);
      try {
        const m = JSON.parse(await fsp.readFile(join(p, 'link.json'), 'utf8')) as LinkMeta;
        if (this.#now() >= m.expiresAt) await fsp.rm(p, { recursive: true, force: true });
      } catch {
        await fsp.rm(p, { recursive: true, force: true });
      }
    }
  }

  /** The visitor opens the link (password checked, one download counted); returns a session token. */
  open(id: string, password?: string): Promise<{ session: string; allowUploads: boolean; keyHash: string }> {
    const prev = this.#locks.get(id) ?? Promise.resolve();
    const run = prev.then(() => this.#open(id, password));
    this.#locks.set(id, run.catch(() => {}));
    return run;
  }

  async #open(id: string, password?: string): Promise<{ session: string; allowUploads: boolean; keyHash: string }> {
    const m = await this.#meta(id);
    if (m.password) {
      const now = this.#now();
      const tries = (this.#tries.get(id) ?? []).filter((t) => now - t < TRY_WINDOW_MS);
      this.#tries.set(id, tries);
      if (tries.length >= MAX_TRIES) throw new LinkError(429, 'throttled');
      if (typeof password !== 'string' || password === '') throw new LinkError(401, 'password');
      const want = Buffer.from(m.password.hash, 'base64');
      const got = await scrypt(password, Buffer.from(m.password.salt, 'base64'), 32, SCRYPT);
      if (!timingSafeEqual(want, got)) {
        tries.push(now);
        throw new LinkError(401, 'bad-password');
      }
    }
    if (m.maxDownloads !== undefined && m.downloads >= m.maxDownloads) throw new LinkError(410, 'used-up');
    m.downloads++;
    await this.#write(m);
    const session = randomBytes(32).toString('base64url');
    this.#sessions.set(session, { id, until: this.#now() + LINK_SESSION_MS });
    return { session, allowUploads: m.allowUploads, keyHash: m.keyHash };
  }

  /** Whether the link needs a password (asked before open). */
  async needsPassword(id: string): Promise<boolean> {
    return !!(await this.#meta(id)).password;
  }

  async #check(id: string, session: string): Promise<LinkMeta> {
    const s = this.#sessions.get(session);
    if (!s || s.id !== id || this.#now() > s.until) throw new LinkError(401, 'session');
    return this.#meta(id);
  }

  async manifest(id: string, session: string): Promise<Buffer> {
    await this.#check(id, session);
    return fsp.readFile(this.#path(id, 'manifest')).catch(() => {
      throw new LinkError(404, 'not-found');
    });
  }

  async chunk(id: string, session: string, fileIdx: number, chunkIdx: number): Promise<Buffer> {
    const m = await this.#check(id, session);
    const f = Number.isInteger(fileIdx) ? m.files[fileIdx] : undefined;
    const n = f ? linkChunkCount(f.size) : 0;
    if (!f || !Number.isInteger(chunkIdx) || chunkIdx < 0 || chunkIdx >= n) throw new LinkError(404, 'not-found');
    const start = chunkIdx * (LINK_CHUNK + 16);
    const len = chunkIdx < n - 1 ? LINK_CHUNK + 16 : f.size - chunkIdx * LINK_CHUNK + 16;
    const fh = await fsp.open(this.#path(id, `f${fileIdx}`), 'r').catch(() => {
      throw new LinkError(404, 'not-found');
    });
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      if (bytesRead !== len) throw new LinkError(404, 'not-found');
      return buf;
    } finally {
      await fh.close();
    }
  }

  /** The upload check for a session (link must allow uploads); returns the key hash to verify the presented key. */
  async uploadKeyHash(id: string, session: string): Promise<string> {
    const m = await this.#check(id, session);
    if (!m.allowUploads) throw new LinkError(403, 'no-uploads');
    return m.keyHash;
  }
}
