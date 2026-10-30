// Relay hubs (M9a): the main hub (holder of the mesh root key) names members that also run a hub
// server, so devices keep a hub while the main one is off. The list is its own document, signed by
// the root like the membership list but under another domain, so older apps (whose membership
// parser is strict) never see a new field: they ignore the {t:'relays'} control message.
//   {v:1, mesh, version, issuedAt, relays:[{deviceId, urls:[wss://…]}]}
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../trust.ts';
import { canonicalJson, signDomain, verifyDomain } from './canonical.ts';

const RELAYS_DOMAIN = 'meshdrop-relays-v1';
const MAX_RELAYS = 8;
const DEVICE_ID_RE = /^[0-9a-f]{64}$/;

export interface Relay {
  deviceId: string;
  urls: string[];
}
export interface RelayList {
  v: 1;
  mesh: string;
  version: number;
  issuedAt: number;
  relays: Relay[];
}
export interface SignedRelays {
  list: RelayList;
  /** Base64 DER ECDSA signature over the canonical JSON of `list`. */
  sig: string;
}

class RelayListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayListError';
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function validateRelays(x: unknown): RelayList {
  if (!isObj(x) || x.v !== 1) throw new RelayListError('invalid relay list');
  if (typeof x.mesh !== 'string' || x.mesh === '') throw new RelayListError('invalid relay list: mesh');
  if (!Number.isSafeInteger(x.version) || (x.version as number) < 1) throw new RelayListError('invalid relay list: version');
  if (!Number.isSafeInteger(x.issuedAt) || (x.issuedAt as number) < 0) throw new RelayListError('invalid relay list: issuedAt');
  if (!Array.isArray(x.relays) || x.relays.length > MAX_RELAYS) throw new RelayListError('invalid relay list: relays');
  const seen = new Set<string>();
  const relays = x.relays.map((r: unknown): Relay => {
    if (!isObj(r) || typeof r.deviceId !== 'string' || !DEVICE_ID_RE.test(r.deviceId) || seen.has(r.deviceId)) throw new RelayListError('invalid relay list: relay');
    seen.add(r.deviceId);
    if (!Array.isArray(r.urls) || r.urls.length > 4) throw new RelayListError('invalid relay list: urls');
    const urls = r.urls.map((u: unknown) => {
      if (typeof u !== 'string' || u.length > 512) throw new RelayListError('invalid relay list: url');
      let p: URL;
      try {
        p = new URL(u);
      } catch {
        throw new RelayListError('invalid relay list: url');
      }
      if (p.protocol !== 'wss:' && p.protocol !== 'ws:') throw new RelayListError('invalid relay list: url must be wss://');
      return u;
    });
    return { deviceId: r.deviceId, urls };
  });
  return { v: 1, mesh: x.mesh, version: x.version as number, issuedAt: x.issuedAt as number, relays };
}

export function signRelays(l: RelayList, rootKey: KeyObject): SignedRelays {
  const list = validateRelays(l);
  return { list, sig: signDomain(RELAYS_DOMAIN, canonicalJson(list), rootKey) };
}

/** The list, if `s` is a relay list for `mesh` signed by the mesh root `anchor`. */
export function verifyRelays(s: unknown, anchor: KeyObject, mesh: string): RelayList {
  if (!isObj(s) || typeof s.sig !== 'string') throw new RelayListError('malformed signed relay list');
  const list = validateRelays(s.list);
  if (list.mesh !== mesh) throw new RelayListError('relay list for another mesh');
  if (!verifyDomain(RELAYS_DOMAIN, canonicalJson(list), s.sig, anchor)) throw new RelayListError('relay list signature does not verify');
  return list;
}

/** The newest verified relay list this device has seen (`<home>/relays.json`). */
export class RelayStore {
  readonly #file: string;
  #signed: SignedRelays | null = null;

  constructor(home: string) {
    this.#file = join(home, 'relays.json');
    try {
      this.#signed = JSON.parse(readFileSync(this.#file, 'utf8')) as SignedRelays;
    } catch {
      this.#signed = null;
    }
  }

  /** Verified against the mesh: a stored list that no longer verifies (other mesh, other root) counts as none. */
  list(anchor: KeyObject, mesh: string): RelayList | null {
    if (!this.#signed) return null;
    try {
      return verifyRelays(this.#signed, anchor, mesh);
    } catch {
      return null;
    }
  }

  current(): SignedRelays | null {
    return this.#signed ? structuredClone(this.#signed) : null;
  }

  /** Keeps `s` if it verifies and is newer than what we have. */
  accept(s: unknown, anchor: KeyObject, mesh: string): 'updated' | 'same' | 'stale' {
    const l = verifyRelays(s, anchor, mesh);
    const cur = this.list(anchor, mesh);
    if (cur && cur.version > l.version) return 'stale';
    if (cur && cur.version === l.version) return 'same';
    this.#signed = { list: l, sig: (s as SignedRelays).sig };
    writeFileAtomic(this.#file, JSON.stringify(this.#signed));
    return 'updated';
  }
}
