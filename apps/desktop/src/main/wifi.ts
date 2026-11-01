// Desktop (Electron) counterpart of Android's WifiControl — the "View + copy / QR / share" side of the
// Wi-Fi module (M1–M5). The PC does not connect to Wi-Fi on the user's behalf and offers no OS integration:
// it shows the networks the user saved on their phone, synced across their own trusted devices over the mesh
// (M5), and lets the user copy a passphrase, show a join QR code, or copy the sharable details. Every saved
// network, with its passphrase, originates on a device where the user typed it in; this PC only mirrors them.
//
// Security posture, kept in step with Android:
//   * A passphrase (psk) and the enterprise password never reach the renderer. `toView` omits both and
//     reports only `hasPassword`. Copy / QR / share read the secret here in the main process and put it
//     straight on the clipboard or into the QR / share text; the value is never returned to the UI as a field.
//   * The store is sealed at rest when the OS keyring is available (Electron safeStorage, injected as
//     `seal`/`open`). When it is not, the file is written plaintext at mode 0600 via `writeFileAtomic` — the
//     same at-rest posture the engine already uses for this device's own private key and trust store, so this
//     is consistent with the app, not a downgrade.
//   * Wi-Fi sync travels only the pinned mutual-TLS mesh link between the user's own trusted devices (the
//     engine delivers app messages only from trusted peers). The passphrases ride that link so a synced
//     network is usable on the other device; each device re-seals them with its own key at rest.
//
// This module is deliberately free of any `electron` import so it stays unit-testable in plain Node, matching
// controller.ts. The clipboard write and the keyring seal/open are injected as callbacks.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';
import QRCode from 'qrcode';
import type { WifiEapMethod, WifiPhase2, WifiProfileView, WifiSecurity, WifiSyncResult } from '../shared/api.ts';

/** The app message kind for Wi-Fi sync, matching Android's WifiControl.SYNC_KIND. */
const SYNC_KIND = 'wifi-sync';
/** How long to wait for one trusted device to answer a sync request. Matches Android's SYNC_TIMEOUT_MS. */
const SYNC_TIMEOUT_MS = 12_000;
/** Drop a delete tombstone once it is this old; by then every device has long since caught up. 60 days. */
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * One saved Wi-Fi network as held on disk and sent over the mesh. The field set and defaults mirror Android's
 * WifiProfile exactly, so `toMap` here and `fromMap` on Android (and vice versa) interoperate on the wire.
 * `psk` and `eapPassword` are secrets: they live here only, never in a `WifiProfileView`.
 */
interface Profile {
  id: string;
  ssid: string;
  /** 'open', 'wpa2', 'wpa3' or 'enterprise' (WPA2-EAP, e.g. eduroam). */
  security: string;
  /** The passphrase (empty for open and enterprise networks). */
  psk: string;
  /** Lowercase AP MAC to pin (band lock), or null for any AP. The desktop only displays this; it never pins. */
  lockBssid: string | null;
  /** '2.4', '5' or '6': the pinned AP's band, shown in the UI; null when not pinned. */
  band: string | null;
  fallback: boolean;
  hidden: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
  /** Delete tombstone (M5): when the user removed this network, so the delete syncs. 0 while live. */
  deletedAt: number;
  // 802.1X / eduroam (only meaningful when security === 'enterprise').
  eapMethod: string;
  phase2: string;
  identity: string;
  anonymousIdentity: string;
  /** The enterprise password. A secret: never sent to the UI. */
  eapPassword: string;
  caCertPem: string;
  domainSuffixMatch: string;
  eapXml: string | null;
}

/** True once the user deleted this network: kept as a tombstone only so the delete can sync. */
function deleted(p: Profile): boolean {
  return p.deletedAt > 0;
}

function str(o: unknown): string | null {
  return o == null ? null : String(o);
}

function strOrEmpty(o: unknown): string {
  return o == null ? '' : String(o);
}

/** Parses one wire/stored map into a Profile, applying the same defaults as Android's WifiProfile.fromMap. */
function fromMap(m: Record<string, unknown>): Profile {
  return {
    id: str(m.id) ?? '',
    ssid: str(m.ssid) ?? '',
    security: m.security == null ? 'wpa2' : String(m.security),
    psk: strOrEmpty(m.psk),
    lockBssid: str(m.lockBssid),
    band: str(m.band),
    fallback: m.fallback === true,
    hidden: m.hidden === true,
    priority: typeof m.priority === 'number' ? Math.trunc(m.priority) : 2,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
    updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : 0,
    deletedAt: typeof m.deletedAt === 'number' ? m.deletedAt : 0,
    eapMethod: m.eapMethod == null ? 'peap' : String(m.eapMethod),
    phase2: m.phase2 == null ? 'mschapv2' : String(m.phase2),
    identity: strOrEmpty(m.identity),
    anonymousIdentity: strOrEmpty(m.anonymousIdentity),
    eapPassword: strOrEmpty(m.eapPassword),
    caCertPem: strOrEmpty(m.caCertPem),
    domainSuffixMatch: strOrEmpty(m.domainSuffixMatch),
    eapXml: str(m.eapXml),
  };
}

/** The full map, secrets included, for the store and for sync. Keys and order match Android's WifiProfile.toMap. */
function toMap(p: Profile): Record<string, unknown> {
  return {
    id: p.id,
    ssid: p.ssid,
    security: p.security,
    psk: p.psk,
    lockBssid: p.lockBssid,
    band: p.band,
    fallback: p.fallback,
    hidden: p.hidden,
    priority: p.priority,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    deletedAt: p.deletedAt,
    eapMethod: p.eapMethod,
    phase2: p.phase2,
    identity: p.identity,
    anonymousIdentity: p.anonymousIdentity,
    eapPassword: p.eapPassword,
    caCertPem: p.caCertPem,
    domainSuffixMatch: p.domainSuffixMatch,
    eapXml: p.eapXml,
  };
}

/** What the renderer gets: metadata only, never the passphrase or the enterprise password. Matches Android toView. */
function toView(p: Profile): WifiProfileView {
  const v: WifiProfileView = {
    id: p.id,
    ssid: p.ssid,
    security: (p.security || 'wpa2') as WifiSecurity,
    hasPassword: p.psk.length > 0 || p.eapPassword.length > 0,
    lockBssid: p.lockBssid,
    band: p.band,
    fallback: p.fallback,
    hidden: p.hidden,
    priority: p.priority,
    updatedAt: p.updatedAt,
    enterprise: p.security === 'enterprise',
  };
  if (p.security === 'enterprise') {
    v.eapMethod = p.eapMethod as WifiEapMethod;
    v.phase2 = p.phase2 as WifiPhase2;
    v.identity = p.identity;
    v.anonymousIdentity = p.anonymousIdentity;
    v.domainSuffixMatch = p.domainSuffixMatch;
    v.hasCaCert = p.caCertPem.length > 0;
  }
  return v;
}

/** Copies every synced field from one profile onto another, keeping the destination object's identity. */
function copyInto(dst: Profile, src: Profile): void {
  dst.ssid = src.ssid;
  dst.security = src.security;
  dst.psk = src.psk;
  dst.lockBssid = src.lockBssid;
  dst.band = src.band;
  dst.fallback = src.fallback;
  dst.hidden = src.hidden;
  dst.priority = src.priority;
  if (src.createdAt > 0) dst.createdAt = src.createdAt;
  dst.updatedAt = src.updatedAt;
  dst.deletedAt = src.deletedAt;
  dst.eapMethod = src.eapMethod;
  dst.phase2 = src.phase2;
  dst.identity = src.identity;
  dst.anonymousIdentity = src.anonymousIdentity;
  dst.eapPassword = src.eapPassword;
  dst.caCertPem = src.caCertPem;
  dst.domainSuffixMatch = src.domainSuffixMatch;
  dst.eapXml = src.eapXml;
}

/** Escapes the characters a Wi-Fi QR reserves: backslash, semicolon, comma, colon and double quote. */
function qrEscape(s: string): string {
  return s.replace(/([\\;,:"])/g, '\\$1');
}

/** A Wi-Fi QR payload (WIFI:...;;): open networks carry no password; hidden networks set H:true. Matches Android. */
function wifiUri(p: Profile): string {
  const open = p.security === 'open' || p.psk.length === 0;
  let b = 'WIFI:T:' + (open ? 'nopass' : 'WPA');
  b += ';S:' + qrEscape(p.ssid);
  if (!open) b += ';P:' + qrEscape(p.psk);
  if (p.hidden) b += ';H:true';
  return b + ';;';
}

/** The sealed-at-rest JSON store of saved profiles, mirroring Android's WifiStore (file `wifi-profiles.bin`). */
class WifiStore {
  readonly #file: string;
  readonly #seal: ((plaintext: string) => Buffer) | undefined;
  readonly #open: ((data: Buffer) => string) | undefined;

  constructor(file: string, seal?: (plaintext: string) => Buffer, open?: (data: Buffer) => string) {
    this.#file = file;
    this.#seal = seal;
    this.#open = open;
  }

  /** Every stored profile, or [] when the file is missing or unreadable (same forgiving load as Android). */
  load(): Profile[] {
    let raw: Buffer;
    try {
      raw = readFileSync(this.#file);
    } catch {
      return []; // no store yet
    }
    try {
      const text = this.#open ? this.#open(raw) : raw.toString('utf8');
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map(fromMap)
        .filter((p) => p.id.length > 0);
    } catch {
      // Unreadable (e.g. sealed with a key this run no longer has): start empty; the next sync refills it.
      return [];
    }
  }

  /** Writes the profiles back atomically, sealed when a key is available, else plaintext at mode 0600. */
  save(all: Profile[]): void {
    const jsonText = JSON.stringify(all.map(toMap));
    const data: Buffer | string = this.#seal ? this.#seal(jsonText) : jsonText;
    writeFileAtomic(this.#file, data);
  }
}

/** The seal/open pair for the store (Electron safeStorage), injected so this module stays electron-free. */
export interface WifiSeal {
  seal(plaintext: string): Buffer;
  open(data: Buffer): string;
}

export interface WifiControlOptions {
  /** The app's home directory; the store lives at `<home>/wifi-profiles.bin`. */
  home: string;
  /** Puts text on the system clipboard. The caller supplies the platform clipboard (never the renderer). */
  clip(text: string): void;
  /** The trusted devices to sync Wi-Fi with right now (device ids). */
  peers(): string[];
  /** Sends one app message to a device over the mesh and resolves with its reply. */
  send(deviceId: string, msg: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** Optional at-rest sealing (OS keyring). Absent: the store is plaintext at mode 0600. */
  seal?: WifiSeal;
}

/**
 * Desktop Wi-Fi control: view the user's saved networks, copy / QR / share one, and sync them across the
 * user's own trusted devices. It never connects to Wi-Fi or changes any OS network setting.
 */
export class WifiControl {
  readonly #store: WifiStore;
  readonly #clip: (text: string) => void;
  readonly #peers: () => string[];
  readonly #send: (deviceId: string, msg: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

  constructor(opts: WifiControlOptions) {
    this.#store = new WifiStore(join(opts.home, 'wifi-profiles.bin'), opts.seal?.seal.bind(opts.seal), opts.seal?.open.bind(opts.seal));
    this.#clip = opts.clip;
    this.#peers = opts.peers;
    this.#send = opts.send;
  }

  /** The live (non-deleted) saved networks as views — never the passphrase or the enterprise password. */
  list(): WifiProfileView[] {
    const out: WifiProfileView[] = [];
    for (const p of this.#store.load()) {
      if (!deleted(p)) out.push(toView(p)); // tombstones are kept only to sync the delete
    }
    return out;
  }

  /** The live profile with this id, or throws. */
  #require(id: string): Profile {
    for (const p of this.#store.load()) {
      if (p.id === id && !deleted(p)) return p;
    }
    throw new Error('That network is no longer saved.');
  }

  /**
   * Copies one saved network's passphrase to the clipboard so the user can paste it into their OS Wi-Fi
   * dialog (they connect manually). The passphrase is read here and placed straight on the clipboard; it
   * never passes through the UI as a field.
   */
  copyPassword(id: string): void {
    const p = this.#require(id);
    if (p.security === 'enterprise') {
      throw new Error('An eduroam / 802.1X login has no single password to copy.');
    }
    if (p.psk.length === 0) {
      throw new Error('This is an open network, so it has no password.');
    }
    this.#clip(p.psk);
  }

  /**
   * The Wi-Fi QR code (SVG string) for one saved network so another device's camera can join. The
   * passphrase goes only into the QR payload; it never reaches the UI as a field.
   */
  async qr(id: string): Promise<string> {
    const p = this.#require(id);
    if (p.security === 'enterprise') {
      throw new Error('A QR code cannot carry an eduroam / 802.1X login.');
    }
    return QRCode.toString(wifiUri(p), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  /**
   * Copies one saved network's sharable details to the clipboard (the desktop has no system share sheet),
   * so the user can paste them into any app. The passphrase is read here and placed only into that text.
   */
  share(id: string): void {
    const p = this.#require(id);
    if (p.security === 'enterprise') {
      throw new Error('An eduroam / 802.1X login cannot be shared this way.');
    }
    const open = p.security === 'open' || p.psk.length === 0;
    const text =
      `Wi-Fi network: ${p.ssid}\n` +
      (open ? 'No password (open network)\n' : `Password: ${p.psk}\n`) +
      `Or scan this QR text: ${wifiUri(p)}`;
    this.#clip(text);
  }

  // ---- M5: sync the user's networks across their own trusted devices ---------------------------

  /** Every stored profile as a full map, secrets included: this travels only the pinned TLS mesh link. */
  #exportAll(): Record<string, unknown>[] {
    return this.#store.load().map(toMap);
  }

  /**
   * Merges profiles received from another of the user's devices: for each id the newer timestamp wins, and
   * a delete tombstone removes a network the other device dropped. Returns how many local entries changed.
   */
  #merge(incoming: unknown[]): number {
    const all = this.#store.load();
    const byId = new Map<string, Profile>();
    for (const p of all) {
      if (p.id) byId.set(p.id, p);
    }
    let changed = 0;
    const now = Date.now();
    for (const it of incoming) {
      if (!it || typeof it !== 'object') continue;
      const inp = fromMap(it as Record<string, unknown>);
      if (!inp.id || !inp.ssid) continue;
      const cur = byId.get(inp.id);
      const inStamp = Math.max(inp.updatedAt, inp.deletedAt);
      const curStamp = cur ? Math.max(cur.updatedAt, cur.deletedAt) : -1;
      if (!cur) {
        if (deleted(inp) && now - inp.deletedAt > TOMBSTONE_TTL_MS) continue; // a stale tombstone for a network we never had
        byId.set(inp.id, inp);
        all.push(inp);
        changed++;
      } else if (inStamp > curStamp) {
        copyInto(cur, inp);
        changed++;
      }
    }
    if (changed > 0) {
      const kept = all.filter((p) => !(deleted(p) && now - p.deletedAt > TOMBSTONE_TTL_MS)); // prune old tombstones
      this.#store.save(kept);
    }
    return changed;
  }

  /**
   * Handles an incoming "wifi-sync" message from one of the user's trusted devices. The engine only
   * delivers app messages from trusted peers, so this path is inherently trusted-only.
   */
  onWifiSync(_peer: string, msg: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const op = typeof msg.op === 'string' ? msg.op : '';
    try {
      if (op === 'pull') {
        out.profiles = this.#exportAll();
      } else if (op === 'push') {
        out.merged = Array.isArray(msg.profiles) ? this.#merge(msg.profiles) : 0;
      } else {
        out.error = 'bad-op';
        return out;
      }
      out.ok = true;
    } catch (e) {
      out.error = e instanceof Error && e.message ? e.message : 'sync-failed';
    }
    return out;
  }

  /** Full two-way sync with every trusted device the user has, on demand ("Sync to my devices"). */
  async syncNow(): Promise<WifiSyncResult> {
    const peers = this.#peers();
    let reached = 0;
    let mergedIn = 0;
    let pushedTo = 0;
    for (const peer of peers) {
      try {
        const pull = await this.#send(peer, { kind: SYNC_KIND, op: 'pull' });
        reached++;
        const body = pull?.body;
        if (body && typeof body === 'object' && Array.isArray((body as { profiles?: unknown }).profiles)) {
          mergedIn += this.#merge((body as { profiles: unknown[] }).profiles);
        }
        await this.#send(peer, { kind: SYNC_KIND, op: 'push', profiles: this.#exportAll() });
        pushedTo++;
      } catch {
        // that device is not reachable now; the others still sync
      }
    }
    return { devices: peers.length, reached, pushed: pushedTo, merged: mergedIn };
  }
}

export { SYNC_TIMEOUT_MS };
