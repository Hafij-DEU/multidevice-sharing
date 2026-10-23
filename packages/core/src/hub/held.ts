// Held files (protocol v1): signed request envelopes for an offline device, stored on the hub
// until it connects. The hub never opens them: it stores the sender's frames verbatim (chunk
// bodies are HPKE ciphertext) and replays them through the relay path later.
//
// Layout: <dir>/<to>/<sessionId>/{meta.json, offer.env, c-<fileId>-<index>.env, complete-<fileId>.env, finish.env}
// Every file is written tmp + fsync + rename. Delivery notices for an offline sender wait in
// <dir>/.notices/<from>/<sessionId>.json.
import { join } from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { decodeFrame, encodeFrame, type Envelope } from '../mesh/envelope.ts';

export const DEFAULT_HELD_QUOTA_BYTES = 20 * 1024 ** 3;
export const DEFAULT_HELD_TTL_MS = 7 * 24 * 3600 * 1000;
const NOTICES = '.notices';

export interface HeldReply { status: number; body: object | undefined }
export interface HeldSession { to: string; from: string; sessionId: string; envelopes: () => AsyncIterable<Envelope> }
export interface HeldStoreOptions { quotaBytes?: number; ttlMs?: number; now?: () => number; fs?: typeof nodeFs }

interface Meta {
  from: string;
  holdBytes: number;
  storedBytes: number;
  createdAt: number;
  completes: number[];
  finished: boolean;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID_RE = /^[0-9a-f]{64}$/;
const CHUNK_RE = /^\/mesh\/v1\/chunk\/([A-Za-z0-9_-]{22})\/(0|[1-9][0-9]{0,9})\/(0|[1-9][0-9]{0,9})$/;
const COMPLETE_RE = /^\/mesh\/v1\/complete\/([A-Za-z0-9_-]{22})\/(0|[1-9][0-9]{0,9})$/;
const FINISH_RE = /^\/mesh\/v1\/finish\/([A-Za-z0-9_-]{22})$/;
const CANCEL_RE = /^\/mesh\/v1\/cancel\/([A-Za-z0-9_-]{22})$/;
const CHUNK_FILE_RE = /^c-(\d+)-(\d+)\.env$/;
const COMPLETE_FILE_RE = /^complete-(\d+)\.env$/;

class QuotaExceeded extends Error {}

const reply = (status: number, body?: object): HeldReply => ({ status, body });

/** The session a held request belongs to, or null if it is not a held-session route. */
export function heldSessionOf(e: Envelope): string | null {
  const { method, path } = e.header;
  if (method === 'POST' && path === '/mesh/v1/offer') {
    try {
      const sid = (JSON.parse(e.body.toString('utf8')) as { sessionId?: unknown }).sessionId;
      return typeof sid === 'string' && SESSION_ID_RE.test(sid) ? sid : null;
    } catch {
      return null;
    }
  }
  for (const re of [CHUNK_RE, COMPLETE_RE, FINISH_RE, CANCEL_RE]) {
    const m = re.exec(path ?? '');
    if (m) return m[1]!;
  }
  return null;
}

export class HeldStore {
  readonly dir: string;
  readonly #fs: typeof nodeFs;
  readonly #quota: number;
  readonly #ttl: number;
  readonly #now: () => number;
  /** Serializes writes per session. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(dir: string, opts: HeldStoreOptions = {}) {
    this.dir = dir;
    this.#fs = opts.fs ?? nodeFs;
    this.#quota = opts.quotaBytes ?? DEFAULT_HELD_QUOTA_BYTES;
    this.#ttl = opts.ttlMs ?? DEFAULT_HELD_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  #sdir(to: string, sid: string): string {
    if (!DEVICE_ID_RE.test(to) || !SESSION_ID_RE.test(sid)) throw new Error('bad held session id');
    return join(this.dir, to, sid);
  }

  #lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.#locks.set(key, tail);
    void tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    return run;
  }

  async #write(path: string, data: Buffer | string): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fh = await this.#fs.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await this.#fs.rename(tmp, path);
    } catch (e) {
      await this.#fs.rm(tmp, { force: true });
      throw e;
    }
  }

  async #meta(to: string, sid: string): Promise<Meta | null> {
    try {
      return JSON.parse(await this.#fs.readFile(join(this.#sdir(to, sid), 'meta.json'), 'utf8')) as Meta;
    } catch {
      return null;
    }
  }

  /** True if an unfinished held session exists (later requests of it are stored, not relayed). */
  async isOpen(to: string, sid: string): Promise<boolean> {
    const m = await this.#meta(to, sid);
    return m !== null && !m.finished;
  }

  async has(to: string, sid: string): Promise<boolean> {
    return (await this.#meta(to, sid)) !== null;
  }

  /** Total bytes reserved by all held sessions. */
  async #used(): Promise<number> {
    let used = 0;
    for (const to of await this.#ls(this.dir)) {
      if (!DEVICE_ID_RE.test(to)) continue;
      for (const sid of await this.#ls(join(this.dir, to))) {
        if (!SESSION_ID_RE.test(sid)) continue;
        const m = await this.#meta(to, sid);
        if (m) used += m.holdBytes;
      }
    }
    return used;
  }

  async #ls(dir: string): Promise<string[]> {
    try {
      return await this.#fs.readdir(dir);
    } catch {
      return [];
    }
  }

  /** Stores one request of a held session and returns the hub's synthetic reply. */
  async put(e: Envelope): Promise<HeldReply> {
    const to = e.header.to;
    const sid = heldSessionOf(e);
    if (sid === null) return reply(503, { error: 'offline' });
    return this.#lock(`${to}/${sid}`, async () => {
      const sdir = this.#sdir(to, sid);
      try {
        return await this.#put(e, to, sid, sdir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (err instanceof QuotaExceeded || code === 'ENOSPC') {
          await this.#fs.rm(sdir, { recursive: true, force: true });
          return reply(507, { error: err instanceof QuotaExceeded ? 'hub-quota' : 'hub-no-space' });
        }
        throw err;
      }
    });
  }

  async #put(e: Envelope, to: string, sid: string, sdir: string): Promise<HeldReply> {
    const { method, path } = e.header;
    const frame = encodeFrame(e);
    let meta = await this.#meta(to, sid);
    if (meta && meta.from !== e.header.from) return reply(403, { error: 'forbidden' });

    if (method === 'POST' && path === '/mesh/v1/offer') {
      if (meta) {
        // Re-offer (sender restarted): same offer body or it is another session under the same id.
        const stored = decodeFrame(await this.#fs.readFile(join(sdir, 'offer.env')));
        if (!stored.body.equals(e.body)) return reply(409, { error: 'session-conflict' });
        return reply(200, { have: await this.#have(sdir), held: true });
      }
      const holdBytes = e.header.holdBytes;
      if (holdBytes === undefined) return reply(503, { error: 'offline' });
      // Reserving is check-then-write: one new offer at a time, so two cannot both fit the quota.
      return this.#lock('quota', async () => {
        if (holdBytes > this.#quota - (await this.#used())) return reply(507, { error: 'hub-quota' });
        await this.#fs.mkdir(sdir, { recursive: true, mode: 0o700 });
        const m: Meta = { from: e.header.from, holdBytes, storedBytes: frame.length, createdAt: this.#now(), completes: [], finished: false };
        await this.#write(join(sdir, 'offer.env'), frame);
        await this.#write(join(sdir, 'meta.json'), JSON.stringify(m));
        return reply(200, { have: {}, held: true });
      });
    }
    if (!meta) return reply(503, { error: 'offline' });

    const cancel = CANCEL_RE.exec(path ?? '');
    if (meta.finished) {
      // The upload is complete and owned by the hub. A repeated complete/finish (its reply was lost)
      // gets the same answer; nothing, not even a cancel, may delete it now.
      if (method === 'POST' && (FINISH_RE.test(path ?? '') || COMPLETE_RE.test(path ?? ''))) return reply(200, { held: true });
      return reply(409, { error: 'held-finished' });
    }
    if (method === 'POST' && cancel) {
      await this.#fs.rm(sdir, { recursive: true, force: true });
      return reply(204);
    }

    let name: string;
    let status = 200;
    let body: object | undefined = { held: true };
    const chunk = CHUNK_RE.exec(path ?? '');
    const complete = COMPLETE_RE.exec(path ?? '');
    if (method === 'PUT' && chunk) {
      name = `c-${chunk[2]}-${chunk[3]}.env`;
      status = 204;
      body = undefined;
    } else if (method === 'POST' && complete) {
      name = `complete-${complete[2]}.env`;
      const f = Number(complete[2]);
      if (!meta.completes.includes(f)) meta.completes.push(f);
    } else if (method === 'POST' && FINISH_RE.test(path ?? '')) {
      name = 'finish.env';
      meta.finished = true;
    } else {
      return reply(400, { error: 'bad-envelope' });
    }
    let prevSize = 0;
    try {
      prevSize = (await this.#fs.stat(join(sdir, name))).size;
    } catch {
      /* new file */
    }
    const stored = meta.storedBytes - prevSize + frame.length;
    // The sender declared holdBytes up front; it may not store more than that (plus framing).
    if (stored > meta.holdBytes) throw new QuotaExceeded();
    meta.storedBytes = stored;
    await this.#write(join(sdir, name), frame);
    await this.#write(join(sdir, 'meta.json'), JSON.stringify(meta));
    return reply(status, body);
  }

  async #have(sdir: string): Promise<Record<number, number[]>> {
    const have: Record<number, number[]> = {};
    for (const n of await this.#ls(sdir)) {
      const m = CHUNK_FILE_RE.exec(n);
      if (!m) continue;
      (have[Number(m[1])] ??= []).push(Number(m[2]));
    }
    for (const k of Object.keys(have)) have[Number(k)]!.sort((a, b) => a - b);
    return have;
  }

  /** Finished sessions for `to`, oldest first, ready to replay. */
  async pending(to: string): Promise<HeldSession[]> {
    if (!DEVICE_ID_RE.test(to)) return [];
    const out: { s: HeldSession; at: number }[] = [];
    for (const sid of await this.#ls(join(this.dir, to))) {
      if (!SESSION_ID_RE.test(sid)) continue;
      const meta = await this.#meta(to, sid);
      if (!meta?.finished) continue;
      const sdir = this.#sdir(to, sid);
      const fs = this.#fs;
      const ls = () => this.#ls(sdir);
      out.push({
        at: meta.createdAt,
        s: {
          to, from: meta.from, sessionId: sid,
          envelopes: async function* () {
            const names = await ls();
            const chunks = names.flatMap((n) => {
              const m = CHUNK_FILE_RE.exec(n);
              return m ? [{ n, f: Number(m[1]), i: Number(m[2]) }] : [];
            }).sort((a, b) => a.f - b.f || a.i - b.i);
            const completes = names.flatMap((n) => {
              const m = COMPLETE_FILE_RE.exec(n);
              return m ? [{ n, f: Number(m[1]) }] : [];
            }).sort((a, b) => a.f - b.f);
            for (const n of ['offer.env', ...chunks.map((c) => c.n), ...completes.map((c) => c.n), 'finish.env']) {
              yield decodeFrame(await fs.readFile(join(sdir, n)));
            }
          },
        },
      });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.s);
  }

  async remove(to: string, sid: string): Promise<void> {
    await this.#lock(`${to}/${sid}`, () => this.#fs.rm(this.#sdir(to, sid), { recursive: true, force: true }));
  }

  /** Deletes sessions older than the TTL (hub clock); returns how many. */
  async prune(): Promise<number> {
    return (await this.pruneExpired()).length;
  }

  /** Deletes sessions older than the TTL (hub clock) and returns them, so their senders can be told. */
  async pruneExpired(): Promise<{ from: string; to: string; sessionId: string }[]> {
    const out: { from: string; to: string; sessionId: string }[] = [];
    const now = this.#now();
    for (const to of await this.#ls(this.dir)) {
      if (!DEVICE_ID_RE.test(to)) continue;
      for (const sid of await this.#ls(join(this.dir, to))) {
        if (!SESSION_ID_RE.test(sid)) continue;
        const m = await this.#meta(to, sid);
        if (m && now - m.createdAt > this.#ttl) {
          await this.remove(to, sid);
          out.push({ from: m.from, to, sessionId: sid });
        }
      }
    }
    return out;
  }

  /** Removes every held session to or from `deviceId` (it was revoked). */
  async purgeDevice(deviceId: string): Promise<void> {
    if (!DEVICE_ID_RE.test(deviceId)) return;
    await this.#fs.rm(join(this.dir, deviceId), { recursive: true, force: true });
    for (const to of await this.#ls(this.dir)) {
      if (!DEVICE_ID_RE.test(to)) continue;
      for (const sid of await this.#ls(join(this.dir, to))) {
        if (!SESSION_ID_RE.test(sid)) continue;
        if ((await this.#meta(to, sid))?.from === deviceId) await this.remove(to, sid);
      }
    }
    await this.#fs.rm(join(this.dir, NOTICES, deviceId), { recursive: true, force: true });
  }

  // ---- delivery notices for an offline sender -------------------------------------------------

  async queueNotice(from: string, sid: string, notice: object): Promise<void> {
    if (!DEVICE_ID_RE.test(from) || !SESSION_ID_RE.test(sid)) return;
    const d = join(this.dir, NOTICES, from);
    await this.#fs.mkdir(d, { recursive: true, mode: 0o700 });
    await this.#write(join(d, `${sid}.json`), JSON.stringify(notice));
  }

  /** Returns and deletes the notices waiting for `from`. */
  async takeNotices(from: string): Promise<object[]> {
    if (!DEVICE_ID_RE.test(from)) return [];
    const d = join(this.dir, NOTICES, from);
    const out: object[] = [];
    for (const n of await this.#ls(d)) {
      if (!n.endsWith('.json')) continue;
      const p = join(d, n);
      try {
        out.push(JSON.parse(await this.#fs.readFile(p, 'utf8')) as object);
      } catch {
        /* skip a damaged notice */
      }
      await this.#fs.rm(p, { force: true });
    }
    return out;
  }
}
