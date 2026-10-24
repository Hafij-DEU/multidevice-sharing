// Folder sync: what is kept between rounds, under <home>/sync/:
//   config.json        {folder, partners}: the synced folder and the devices it is synced with
//   index.json         the last scan (hash cache)
//   base-<id>.json     per partner: {rel: hash} as both sides last agreed
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../trust.ts';
import type { FileState } from './scan.ts';

export interface SyncConfig {
  /** Absolute path of the synced folder; empty: sync is off. */
  folder: string;
  /** Device ids this folder is synced with (each must also tick this device). */
  partners: string[];
}

const DEVICE_ID_RE = /^[0-9a-f]{64}$/;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

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
    const j = readJson(join(this.dir, 'config.json')) as Partial<SyncConfig> | null;
    const folder = typeof j?.folder === 'string' ? j.folder : '';
    const partners = Array.isArray(j?.partners) ? j!.partners.filter((p): p is string => typeof p === 'string' && DEVICE_ID_RE.test(p)) : [];
    return { folder, partners };
  }

  setConfig(c: SyncConfig): void {
    this.#write('config.json', c);
  }

  cache(): Map<string, FileState> {
    const j = readJson(join(this.dir, 'index.json'));
    const m = new Map<string, FileState>();
    if (Array.isArray(j)) for (const f of j as FileState[]) if (f && typeof f.rel === 'string' && typeof f.hash === 'string') m.set(f.rel, f);
    return m;
  }

  setCache(m: Map<string, FileState>): void {
    this.#write('index.json', [...m.values()]);
  }

  base(partner: string): Map<string, string> {
    if (!DEVICE_ID_RE.test(partner)) throw new Error('invalid device id');
    const j = readJson(join(this.dir, `base-${partner}.json`));
    return new Map(j && typeof j === 'object' ? Object.entries(j as Record<string, string>).filter(([, v]) => typeof v === 'string') : []);
  }

  setBase(partner: string, m: Map<string, string>): void {
    if (!DEVICE_ID_RE.test(partner)) throw new Error('invalid device id');
    this.#write(`base-${partner}.json`, Object.fromEntries(m));
  }
}
