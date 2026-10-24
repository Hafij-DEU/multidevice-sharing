// Folder sync: the folder's file list with content hashes. A hash is recomputed only when the size
// or mtime changed since the last scan (the cache). Regular files only: symlinks and special files
// are skipped, and so are ignored names.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { ignored } from './ignore.ts';

export interface FileState {
  rel: string;
  size: number;
  /** Whole milliseconds. */
  mtime: number;
  hash: string;
}

export async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

/** Every syncable file under `root` by relative path; `cache` entries are reused when size and mtime match. */
export async function scan(root: string, cache: Map<string, FileState> = new Map()): Promise<Map<string, FileState>> {
  const out = new Map<string, FileState>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (ignored(rel)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs, rel);
      else if (e.isFile()) {
        let st;
        try {
          st = await fsp.lstat(abs);
        } catch {
          continue; // gone meanwhile
        }
        const mtime = Math.floor(st.mtimeMs);
        const c = cache.get(rel);
        if (c && c.size === st.size && c.mtime === mtime) {
          out.set(rel, c);
          continue;
        }
        let hash: string;
        try {
          hash = await hashFile(abs);
        } catch {
          continue;
        }
        out.set(rel, { rel, size: st.size, mtime, hash });
      }
    }
  };
  await walk(root, '');
  return out;
}
