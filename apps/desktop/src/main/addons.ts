// Add-on loader: finds add-on packages (separate .debs) in /usr/lib/meshdrop/addons/<id>/ and loads
// their transports for the engine. An add-on is code that runs inside MeshDrop, so only a folder that
// root owns and nobody else can write is read; MESHDROP_ADDON_DIR points at another folder instead
// (development and tests: whoever sets the environment already runs this process).
import { lstatSync, readFileSync, readdirSync, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ADDON_API_VERSION, type AddonModule, type AddonTransport } from '@meshdrop/core/src/addons.ts';

export const SYSTEM_ADDON_DIR = '/usr/lib/meshdrop/addons';

export interface AddonInfo {
  id: string;
  name: string;
  version: string;
  transports: string[];
}

interface Manifest {
  id: string;
  name: string;
  version: string;
  main: string;
  apiVersion: number;
}

const ID = /^[a-z0-9-]{1,32}$/;
const FILE = /^[A-Za-z0-9._-]{1,64}\.c?js$/;

/** Root-owned and not writable by group or others (checked on the folder chain and each file read). */
function locked(st: Stats): boolean {
  return st.uid === 0 && (st.mode & 0o022) === 0;
}

function readManifest(dir: string, strict: boolean): Manifest | null {
  const path = join(dir, 'manifest.json');
  const st = lstatSync(path);
  if (!st.isFile() || (strict && !locked(st))) return null;
  const m = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
  if (typeof m.id !== 'string' || !ID.test(m.id)) return null;
  if (typeof m.main !== 'string' || !FILE.test(m.main)) return null;
  if (m.apiVersion !== ADDON_API_VERSION) return null;
  return { id: m.id, name: typeof m.name === 'string' ? m.name.slice(0, 64) : m.id, version: typeof m.version === 'string' ? m.version.slice(0, 32) : '?', main: m.main, apiVersion: m.apiVersion };
}

/** Loads every usable add-on; one that is broken, unsafe or for another API version is skipped. */
export function loadAddons(opts: { dir?: string; log?: (msg: string) => void } = {}): { transports: AddonTransport[]; info: AddonInfo[] } {
  const log = opts.log ?? (() => {});
  const root = opts.dir ?? SYSTEM_ADDON_DIR;
  const strict = opts.dir === undefined;
  const transports: AddonTransport[] = [];
  const info: AddonInfo[] = [];
  let names: string[];
  try {
    const st = lstatSync(root);
    if (!st.isDirectory() || (strict && !locked(st))) return { transports, info };
    names = readdirSync(root).sort();
  } catch {
    return { transports, info };
  }
  const req = createRequire(__filename);
  for (const name of names) {
    const dir = join(root, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (strict && !locked(st))) continue;
      const m = readManifest(dir, strict);
      if (!m || m.id !== name) continue;
      const entry = join(dir, m.main);
      const est = lstatSync(entry);
      if (!est.isFile() || (strict && !locked(est))) continue;
      const loaded = req(entry) as AddonModule | { default: AddonModule };
      const mod = 'transports' in loaded ? loaded : loaded.default;
      if (mod?.apiVersion !== ADDON_API_VERSION || typeof mod.transports !== 'function') continue;
      const ts = mod.transports().filter((t) => typeof t?.id === 'string' && ID.test(t.id) && !transports.some((o) => o.id === t.id));
      transports.push(...ts);
      info.push({ id: m.id, name: m.name, version: m.version, transports: ts.map((t) => t.label) });
      log(`add-on ${m.id} ${m.version}: ${ts.map((t) => t.label).join(', ')}`);
    } catch (e) {
      log(`add-on ${name} skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { transports, info };
}
