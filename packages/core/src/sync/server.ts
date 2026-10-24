// Folder sync routes on the receiver API (mesh/v1/sync/...), for partners this device ticked only:
//   GET  sync/index                                  {v:1, files:[{rel,size,mtime,hash}]}
//   GET  sync/file?rel=&hash=&offset=&len=           raw bytes (len <= 4 MiB); 409 'changed' if the
//                                                    file no longer has that hash
//   POST sync/poke                                   "I changed": the partner pulls soon (204)
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { MeshResponse } from '../api/handler.ts';
import { safeRelPath } from '../sanitize.ts';
import { ignored } from './ignore.ts';
import { hashFile, scan, type FileState } from './scan.ts';
import type { SyncStore } from './store.ts';

export const SYNC_SLICE = 4 * 1024 * 1024;

const json = (status: number, body?: unknown): MeshResponse =>
  body === undefined ? { status, headers: {}, body: Buffer.alloc(0) } : { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };

export interface SyncRouteOptions {
  store: SyncStore;
  /** The partner asked us to pull from it. */
  onPoke: (peer: string) => void;
}

/** One file's current state (hash from the cache when size and mtime match), or null when it is not a syncable file. */
export async function fileState(folder: string, rel: string, cache: Map<string, FileState>): Promise<FileState | null> {
  let st;
  try {
    st = await fsp.lstat(join(folder, rel));
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const mtime = Math.floor(st.mtimeMs);
  const c = cache.get(rel);
  if (c && c.size === st.size && c.mtime === mtime) return c;
  return { rel, size: st.size, mtime, hash: await hashFile(join(folder, rel)) };
}

export function syncRoutes(o: SyncRouteOptions) {
  return async (peer: string, method: string, seg: string[], q: URLSearchParams): Promise<MeshResponse> => {
    const cfg = o.store.config();
    if (cfg.folder === '' || !cfg.partners.includes(peer)) return json(403, { error: 'not-a-sync-partner' });
    if (method === 'POST' && seg.length === 1 && seg[0] === 'poke') {
      o.onPoke(peer);
      return json(204);
    }
    if (method === 'GET' && seg.length === 1 && seg[0] === 'index') {
      const files = await scan(cfg.folder, o.store.cache());
      o.store.setCache(files);
      return json(200, { v: 1, files: [...files.values()] });
    }
    if (method === 'GET' && seg.length === 1 && seg[0] === 'file') {
      let rel: string;
      try {
        rel = safeRelPath(q.get('rel') ?? '');
      } catch {
        return json(400, { error: 'bad-path' });
      }
      const offset = Number(q.get('offset') ?? '0');
      const len = Number(q.get('len') ?? String(SYNC_SLICE));
      if (rel === '' || ignored(rel) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(len) || len < 1 || len > SYNC_SLICE) return json(400, { error: 'bad-request' });
      const st = await fileState(cfg.folder, rel, o.store.cache());
      if (!st) return json(404, { error: 'not-found' });
      if (st.hash !== q.get('hash')) return json(409, { error: 'changed' });
      const h = await fsp.open(join(cfg.folder, rel), 'r');
      try {
        const buf = Buffer.alloc(Math.max(0, Math.min(len, st.size - offset)));
        let off = 0;
        while (off < buf.length) {
          const { bytesRead } = await h.read(buf, off, buf.length - off, offset + off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: buf.subarray(0, off) };
      } finally {
        await h.close();
      }
    }
    return json(404, { error: 'not-found' });
  };
}
