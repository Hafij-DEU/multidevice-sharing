// Folder sync: what is kept between rounds, under <home>/sync/:
//   config.json            {folders:[{name, folder, partners}]}: each synced folder, the name that
//                          matches it with the partners' folders, and the devices it syncs with
//   index-<key>.json       per folder: the last scan (hash cache)
//   base-<key>-<id>.json   per folder and partner: {rel: hash} as both sides last agreed
// <key> is a short hash of the folder's name. 0.3.0 kept one folder ({folder, partners}, index.json,
// base-<id>.json): that config becomes one folder named after its directory, and its base files are
// still read until the new ones exist, so the upgrade does not see every file as a conflict.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { writeFileAtomic } from '../trust.ts';
import type { FileState } from './scan.ts';

export interface SyncFolderConfig {
  /** Matches this folder with the partners' folders of the same name. */
  name: string;
  /** Absolute path (Android: a picked folder's URI). */
  folder: string;
  /** Device ids it is synced with (each must also tick this device for this name). */
  partners: string[];
}

export interface SyncConfig {
  folders: SyncFolderConfig[];
}

export const MAX_SYNC_FOLDERS = 16;
const DEVICE_ID_RE = /^[0-9a-f]{64}$/;

/** A folder name: 1–64 characters, no control characters, no slash. */
export function validSyncName(n: unknown): n is string {
  return typeof n === 'string' && n.trim() === n && n.length >= 1 && n.length <= 64 && !/[\u0000-\u001f\u007f/\\]/.test(n);
}

/** A default name for a folder path or URI: its last segment. */
export function defaultSyncName(folder: string): string {
  const last = decodeURIComponent(folder.replace(/\/+$/, '').split(/[/:]/).pop() ?? '').trim();
  const n = (last || basename(folder) || 'Sync').replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 64).trim();
  return n || 'Sync';
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const keyOf = (name: string): string => createHash('sha256').update(name).digest('hex').slice(0, 16);

export class SyncStore {
  readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, 'sync');
  }

  #write(name: string, v: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.dir, name), JSON.stringify(v));
  }

  config(): SyncConfig {
    const j = readJson(join(this.dir, 'config.json')) as Record<string, unknown> | null;
    const partnersOf = (x: unknown): string[] => (Array.isArray(x) ? x.filter((p): p is string => typeof p === 'string' && DEVICE_ID_RE.test(p)) : []);
    if (j && typeof j.folder === 'string') {
      // 0.3.0: one folder
      return { folders: j.folder === '' ? [] : [{ name: defaultSyncName(j.folder), folder: j.folder, partners: partnersOf(j.partners) }] };
    }
    const folders: SyncFolderConfig[] = [];
    if (j && Array.isArray(j.folders)) {
      for (const f of j.folders as Record<string, unknown>[]) {
        if (!f || !validSyncName(f.name) || typeof f.folder !== 'string' || f.folder === '' || folders.some((x) => x.name === f.name)) continue;
        folders.push({ name: f.name, folder: f.folder, partners: partnersOf(f.partners) });
      }
    }
    return { folders };
  }

  /** True while the config is still the 0.3.0 single-folder one. */
  #legacy(): boolean {
    const j = readJson(join(this.dir, 'config.json')) as Record<string, unknown> | null;
    return !!j && typeof j.folder === 'string';
  }

  setConfig(c: SyncConfig): void {
    const legacyFirst = this.#legacy() ? this.config().folders[0]?.name : undefined;
    if (legacyFirst !== undefined) this.#write('legacy.json', { name: legacyFirst });
    this.#write('config.json', { folders: c.folders });
  }

  /** The folder that took over the 0.3.0 files (its old cache and bases are still read). */
  #legacyName(): string | undefined {
    if (this.#legacy()) return this.config().folders[0]?.name;
    const j = readJson(join(this.dir, 'legacy.json')) as { name?: unknown } | null;
    return typeof j?.name === 'string' ? j.name : undefined;
  }

  cache(name: string): Map<string, FileState> {
    let j = readJson(join(this.dir, `index-${keyOf(name)}.json`));
    if (j === null && this.#legacyName() === name) j = readJson(join(this.dir, 'index.json'));
    const m = new Map<string, FileState>();
    if (Array.isArray(j)) for (const f of j as FileState[]) if (f && typeof f.rel === 'string' && typeof f.hash === 'string') m.set(f.rel, f);
    return m;
  }

  setCache(name: string, m: Map<string, FileState>): void {
    this.#write(`index-${keyOf(name)}.json`, [...m.values()]);
  }

  base(name: string, partner: string): Map<string, string> {
    if (!DEVICE_ID_RE.test(partner)) throw new Error('invalid device id');
    let j = readJson(join(this.dir, `base-${keyOf(name)}-${partner}.json`));
    if (j === null && this.#legacyName() === name) j = readJson(join(this.dir, `base-${partner}.json`));
    return new Map(j && typeof j === 'object' ? Object.entries(j as Record<string, string>).filter(([, v]) => typeof v === 'string') : []);
  }

  setBase(name: string, partner: string, m: Map<string, string>): void {
    if (!DEVICE_ID_RE.test(partner)) throw new Error('invalid device id');
    this.#write(`base-${keyOf(name)}-${partner}.json`, Object.fromEntries(m));
  }

  /** Forgets a folder's cache and bases (it was removed from sync; its files stay where they are). */
  forget(name: string): void {
    if (!existsSync(this.dir)) return;
    const k = keyOf(name);
    for (const f of readdirSync(this.dir)) if (f === `index-${k}.json` || f.startsWith(`base-${k}-`)) rmSync(join(this.dir, f), { force: true });
  }
}
