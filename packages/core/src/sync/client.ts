// Folder sync: one round against one partner. Pull only: we fetch the partner's index, decide each
// path with merge.ts, and download or delete here; the partner does the same against us.
// Nothing is ever destroyed: a replaced or deleted file goes to the folder's Deleted folder (not
// synced, emptied by hand), and the losing side of a conflict is kept as a conflict copy.
import * as fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureDir } from '../guest/uploads.ts';
import { safeRelPath, uniqueName } from '../sanitize.ts';
import type { Transport } from '../transfer/transport.ts';
import { DELETED_DIR, ignored } from './ignore.ts';
import { conflictName, decide } from './merge.ts';
import { hashFile, scan, type FileState } from './scan.ts';
import { fileState, SYNC_SLICE } from './server.ts';
import type { SyncStore } from './store.ts';

/** Where 0.3.0–0.3.2 put removed files (hidden, per round, emptied after 30 days); still emptied, no longer filled. */
const TRASH_DIR = '.meshdrop-trash';
export const PARTIAL_DIR = '.meshdrop-partial';
const TRASH_DAYS = 30;
const HASH_RE = /^[0-9a-f]{64}$/;
const REQ_TIMEOUT_MS = 60_000;

export interface RoundOptions {
  folder: string;
  /** The folder's sync name (matches the partner's folder; sent as ?f=). */
  name: string;
  store: SyncStore;
  transport: Transport;
  /** This device's id and the partner's (for tie-breaks), and the partner's name (for conflict copies). */
  self: string;
  partner: string;
  partnerAlias: string;
  signal?: AbortSignal;
  now?: () => number;
}

export interface RoundResult {
  pulled: number;
  deleted: number;
  conflicts: number;
  /** Paths that could not be done this round (retried next round). */
  errors: { rel: string; error: string }[];
}

function parseIndex(j: unknown): Map<string, FileState> {
  const out = new Map<string, FileState>();
  const files = (j as { files?: unknown })?.files;
  if (!Array.isArray(files)) throw new Error('bad sync index');
  for (const f of files as Record<string, unknown>[]) {
    if (!f || typeof f.rel !== 'string' || typeof f.hash !== 'string' || !HASH_RE.test(f.hash)) continue;
    if (!Number.isSafeInteger(f.size) || (f.size as number) < 0 || typeof f.mtime !== 'number' || !Number.isFinite(f.mtime)) continue;
    let rel: string;
    try {
      rel = safeRelPath(f.rel);
    } catch {
      continue;
    }
    if (rel === '' || rel !== f.rel || ignored(rel)) continue;
    out.set(rel, { rel, size: f.size as number, mtime: Math.floor(f.mtime as number), hash: f.hash });
  }
  return out;
}

/**
 * Moves `rel` into the Deleted folder, keeping its path (a free name if that is taken). Deleted is
 * not synced, and nothing in it is removed automatically.
 */
async function toDeleted(folder: string, rel: string): Promise<void> {
  const parts = [DELETED_DIR, ...rel.split('/')];
  const base = parts.pop()!;
  const dir = await ensureDir(folder, parts);
  await fsp.rename(join(folder, rel), join(dir, await uniqueName(dir, base)));
}

/** Empties rounds of the old hidden trash (0.3.0–0.3.2) older than TRASH_DAYS. */
async function pruneTrash(folder: string, now: number): Promise<void> {
  const dir = join(folder, TRASH_DIR);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const st = await fsp.lstat(join(dir, n)).catch(() => null);
    if (st && now - st.mtimeMs > TRASH_DAYS * 86_400_000) await fsp.rm(join(dir, n), { recursive: true, force: true });
  }
}

async function download(o: RoundOptions, r: FileState): Promise<string> {
  const pdir = await ensureDir(o.folder, [PARTIAL_DIR]);
  const part = join(pdir, r.hash);
  let have = 0;
  try {
    const st = await fsp.lstat(part);
    if (st.isFile() && st.size <= r.size) have = st.size; // resume
  } catch {
    /* none yet */
  }
  const h = await fsp.open(part, have === 0 ? 'w' : 'r+');
  try {
    while (have < r.size) {
      const len = Math.min(SYNC_SLICE, r.size - have);
      const q = new URLSearchParams({ f: o.name, rel: r.rel, hash: r.hash, offset: String(have), len: String(len) });
      const res = await o.transport.request('GET', `/mesh/v1/sync/file?${q}`, undefined, {}, { timeoutMs: REQ_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) });
      if (res.status === 409) throw new Error('changed on the partner');
      if (res.status !== 200 || res.body.length === 0) throw new Error(`http-${res.status}`);
      await h.write(res.body, 0, res.body.length, have);
      have += res.body.length;
    }
  } finally {
    await h.close();
  }
  if ((await hashFile(part)) !== r.hash) {
    await fsp.rm(part, { force: true });
    throw new Error('integrity');
  }
  return part;
}

export async function syncRound(o: RoundOptions): Promise<RoundResult> {
  const now = (o.now ?? Date.now)();
  const cache = o.store.cache(o.name);
  const local = await scan(o.folder, cache);
  const res = await o.transport.request('GET', `/mesh/v1/sync/index?${new URLSearchParams({ f: o.name })}`, undefined, {}, { timeoutMs: REQ_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) });
  if (res.status !== 200) throw new Error(`sync: the partner answered ${res.status}${typeof (res.json as { error?: unknown })?.error === 'string' ? ` ${(res.json as { error: string }).error}` : ''}`);
  const remote = parseIndex(res.json);
  const base = o.store.base(o.name, o.partner);
  const out: RoundResult = { pulled: 0, deleted: 0, conflicts: 0, errors: [] };
  const rels = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const rel of [...rels].sort()) {
    if (o.signal?.aborted) break;
    const L = local.get(rel);
    const R = remote.get(rel);
    const d = decide({ hash: L?.hash ?? null, ...(L ? { mtime: L.mtime } : {}) }, { hash: R?.hash ?? null, ...(R ? { mtime: R.mtime } : {}) }, base.get(rel) ?? null, { local: o.self, remote: o.partner });
    try {
      if (d.kind === 'keep') continue;
      if (d.kind !== 'agree') {
        // Act only if the local file is still what the decision saw (else: next round).
        const cur = await fileState(o.folder, rel, cache);
        if ((cur?.hash ?? null) !== (L?.hash ?? null)) continue;
        if (d.kind === 'conflict-take' && L) {
          const dir = dirname(join(o.folder, rel));
          const copy = await uniqueName(dir, conflictName(rel.split('/').pop()!, o.partnerAlias, new Date(now)));
          await fsp.rename(join(o.folder, rel), join(dir, copy));
          local.delete(rel);
          out.conflicts++;
        }
        if (R) {
          const part = await download(o, R);
          const parts = rel.split('/');
          const name = parts.pop()!;
          const dir = await ensureDir(o.folder, parts);
          if (d.kind === 'take' && L) await toDeleted(o.folder, rel); // the replaced version
          const dest = join(dir, name);
          await fsp.rename(part, dest);
          await fsp.utimes(dest, new Date(now), new Date(R.mtime));
          local.set(rel, { ...R });
          out.pulled++;
        } else if (L) {
          await toDeleted(o.folder, rel);
          local.delete(rel);
          out.deleted++;
        }
      }
      if (d.base === null) base.delete(rel);
      else base.set(rel, d.base);
    } catch (e) {
      out.errors.push({ rel, error: e instanceof Error ? e.message : String(e) });
    }
  }
  o.store.setCache(o.name, local);
  o.store.setBase(o.name, o.partner, base);
  await pruneTrash(o.folder, now).catch(() => {});
  return out;
}
