// Engine facade: one object that owns a device's identity, trust store, inbox, outbox, receiver
// server and LAN discovery, and offers send / pair / resume on top. Consumed by the CLI (src/cli.ts),
// and later by the hub (M2) and the desktop app (M3).
//
// Layout under `home` (default configDir()):
//   identity/{key.pem,cert.der}   device identity (identity.ts)
//   trust.json                    trusted devices (trust.ts); re-read when another process changes it
//   outbox/<sessionId>.json       unfinished sends (transfer/send.ts); every send goes through it;
//                                 listOutbox()/removeOutbox() manage it
//   manual-peers.json             addresses added by pairManual, re-probed on start()
//   mesh/{anchor.pem,membership.json}  the signed device list once this device is in a mesh (M2)
//   hub/root-key.pem, hub/held/   only on the hub: the mesh root key and held sessions
//   invite.json                   the latest QR invite created here (so a running `listen` honours
//                                 an invite printed by a separate `meshdrop invite`)
//   mesh-pending.json             a provisional join waiting for the hub to sign this device in
//
// Events: everything is emitted on the single 'event' channel as an EngineEvent.
import { X509Certificate, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, watch, writeSync, type FSWatcher } from 'node:fs';
import { copyFile, lstat, open, readdir } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { connect } from 'node:tls';
import { createMeshHandler, type MeshServerOptions, type TrustSource } from './api/handler.ts';
import { createMeshServer, type ReceiverEvent } from './api/server.ts';
import { BtLinks, DEFAULT_LINK_POLICY, type BtPlatform, type LinkMode, type LinkPolicy } from './bt/links.ts';
import { CHUNK_SIZE, chunkCount } from './chunk.ts';
import QRCode from 'qrcode';
import { GuestBook } from './guest/book.ts';
import { GUEST_PAGE } from './guest/page.ts';
import { createGuestServer, type SharedFile } from './guest/server.ts';
import { Room, type RoomPost } from './guest/room.ts';
import { WatchRooms, WatchError } from './watch/rooms.ts';
import { createWatchHandler } from './watch/server.ts';
import { WATCH_PAGE } from './watch/page.ts';
import { ensureDir, GuestUploads, land, type GuestEvent, type GuestFile } from './guest/uploads.ts';
import { LINK_PAGE } from './links/page.ts';
import { lsRegister, lsSend } from './localsend/client.ts';
import { LS_PORT, LocalSendDiscovery, type LsPeerInfo } from './localsend/discovery.ts';
import { LocalSendReceiver, type LsEvent, type LsInfo } from './localsend/server.ts';
import { ReachManager, type ReachConfig, type ReachEnv, type ReachStatus } from './reach/manager.ts';
import { createLinkHandler } from './links/server.ts';
import { LinkError, LinkStore, type LinkInfo } from './links/store.ts';
import { HubClient } from './hub/client.ts';
import { HeldStore } from './hub/held.ts';
import { DEFAULT_INGRESS_PORT, HubServer, type DirectoryEntry, type LanAddr } from './hub/server.ts';
import { spkiSha256 } from './mesh/canonical.ts';
import { INVITE_GROUP_USES, InviteBook, inviteUri, parseInviteUri, type Invite } from './mesh/invite.ts';
import { completeJoin, createJoinHandler, joinViaHub, joinViaLan } from './mesh/join.ts';
import { CompositeTrust, MembershipStore } from './mesh/members.ts';
import { signList, type Member, type MembershipList, type SignedMembership } from './mesh/membership.ts';
import { RelayStore, signRelays, type Relay, type RelayList } from './mesh/relays.ts';
import { pullMembership } from './mesh/propagate.ts';
import { exportRecovery as sealRecovery, importRecovery as openRecovery } from './mesh/recovery.ts';
import { hasRootKey, loadOrCreateRootKey, saveRootKey } from './mesh/rootkey.ts';
import { LanTransport, RelayTransport, type Transport } from './transfer/transport.ts';
import { syncRound } from './sync/client.ts';
import { ignored as syncIgnored } from './sync/ignore.ts';
import { syncRoutes } from './sync/server.ts';
import { MAX_SYNC_FOLDERS, SyncStore, defaultSyncName, validSyncName, type SyncConfig, type SyncFolderConfig } from './sync/store.ts';
import { pairingCode, writeFileAtomic } from './trust.ts';
import { DEFAULT_MESH_PORT, Discovery, MAX_ALIAS_CHARS, type Announce, type DiscoveryOptions, type PeerInfo } from './discovery.ts';
import { deviceIdOf, loadOrCreateIdentity, type Identity } from './identity.ts';
import { Inbox } from './inbox.ts';
import { configDir } from './paths.ts';
import { multiSend } from './transfer/multisend.ts';
import { Outbox, isSessionActive, postCancel, sendTo, type OutboxEntry, type SendItem, type SendResult, type Target } from './transfer/send.ts';

/** A send that failed for a reason another path might not hit (network, timeout, 5xx). */
function isTransientError(error: string | undefined): boolean {
  if (!error) return false;
  if (/^http-4\d\d/.test(error)) return false;
  return !['source-changed', 'pin-mismatch', 'bad-response', 'no-route', 'already-running', 'target-mismatch', 'target-unresolved', 'corrupt-entry'].includes(error);
}
import { TrustStore, type TrustedDevice } from './trust.ts';

export type { SendItem, SendResult } from './transfer/send.ts';
export type { TrustedDevice } from './trust.ts';

export type EngineEvent =
  | ({ source: 'receiver' } & ReceiverEvent)
  /** `tag`: the one given to send() (absent for resumes); `sessionId` names the outbox session. */
  | { source: 'sender'; type: 'progress'; deviceId: string; sessionId: string; fileId: number; sent: number; total: number; tag?: string }
  | ({ source: 'sender'; type: 'result'; tag?: string } & SendResult)
  | { source: 'discovery'; type: 'peer' | 'lost'; peer: PeerInfo }
  /** A Bluetooth link to a trusted device came up or went down (M14). */
  | { source: 'bt'; type: 'up' | 'down'; deviceId: string }
  /** A LocalSend app showed up on the LAN. */
  | { source: 'localsend'; type: 'peer'; fingerprint: string; alias: string }
  /** LAN guests: an offer waiting for the owner, a finished upload, one file of it, a rejected offer, the session ended. */
  /** `via: 'link'`: the visitor came through an internet guest link (`link` is its id). */
  | { source: 'guest'; type: 'offer'; id: string; files: GuestFile[]; text?: string; via?: 'link' | 'localsend'; link?: string; alias?: string }
  | { source: 'guest'; type: 'received'; id: string; files: string[]; text?: string; via?: 'localsend'; alias?: string }
  | { source: 'guest'; type: 'file'; id: string; path: string }
  | { source: 'guest'; type: 'rejected'; id: string }
  | { source: 'guest'; type: 'failed'; id: string; error: string }
  | { source: 'guest'; type: 'ended' | 'opened' | 'room' }
  /** Folder sync: a round with `partner` finished (counts are what changed here), or failed. */
  | { source: 'sync'; type: 'round'; folder: string; partner: string; pulled: number; deleted: number; conflicts: number; errors: number }
  | { source: 'sync'; type: 'error'; folder: string; partner: string; error: string }
  | {
      source: 'mesh';
      type: 'online' | 'offline' | 'membership' | 'directory' | 'revoked' | 'held-delivered' | 'held-failed' | 'joined' | 'relays';
      /** membership: the new list version. */
      version?: number;
      /** held-*: the target device and the session. */
      to?: string;
      sessionId?: string;
      files?: string[];
      status?: number;
      error?: string;
    };

export const DEFAULT_GUEST_PORT = 53320;
/** How long a guest link works: the owner's choice within these bounds (plain HTTP: keep it short). */
export const DEFAULT_GUEST_MINUTES = 60;
export const MIN_GUEST_MINUTES = 5;
export const MAX_GUEST_MINUTES = 24 * 60;

/** The LAN guest session as the app shows it. */
export interface GuestState {
  active: boolean;
  /** False when the guest server could not bind its port. */
  available: boolean;
  url?: string;
  expiresAt?: number;
  /** A browser has opened the link. */
  claimed?: boolean;
  shared: { id: string; name: string; size: number }[];
  /** Offers waiting for the owner's answer. */
  offers: { id: string; files: GuestFile[]; text?: string; via?: 'link' | 'localsend'; alias?: string }[];
}

/** An internet guest link as the owner's app lists it. */
export interface LinkView extends LinkInfo {
  /** The full link (with its key) as created on this device; absent if it was made elsewhere. */
  url?: string;
}

/** Where this device stands in its mesh. */
export interface HubStatus {
  role: 'hub' | 'member' | 'provisional' | 'none';
  /** This device's link to the hub is up (the hub device counts as online when running). */
  online: boolean;
  version: number;
  members: number;
  hubId: string | null;
  urls: string[];
  /** The hub this device's link is on: 'main', a relay hub while the main one is away, or null. */
  linkedTo?: 'main' | 'relay' | null;
  /** This device runs a relay hub for the mesh (named so by the main hub). */
  relayHub?: boolean;
}

/** A relay hub as the main hub lists it (M9). */
export interface RelayView {
  deviceId: string;
  alias: string;
  urls: string[];
}

/** An unfinished send waiting in the outbox (paused, failed, or interrupted by a crash). */
/** A folder sync partner as syncStatus() reports it. */
export interface SyncPartnerStatus {
  deviceId: string;
  alias?: string;
  /** On the LAN now (sync runs only then). */
  present: boolean;
  syncing: boolean;
  /** The last round: what changed here, or why it failed. */
  last?: { at: number; pulled: number; deleted: number; conflicts: number; errors: number; error?: string };
}

export interface OutboxItem {
  sessionId: string;
  /** Target device. */
  deviceId: string;
  /** The target's alias in the trust store (absent if it is no longer trusted). */
  alias?: string;
  createdAt: number;
  files: number;
  /** Total plaintext bytes of the files. */
  bytes: number;
  /** Whether the send carries a text item. */
  text: boolean;
  /** How the last attempt ended ('offline': the device was away), absent before the first try. */
  lastError?: string;
  /** Auto-resume sends it when the device is seen again (a pause or a transient failure). */
  waiting: boolean;
}

/** A session id prefix that matches no outbox entry, or several. */
export class UnknownOutboxEntryError extends Error {
  readonly query: string;
  readonly reason: 'unknown' | 'ambiguous';
  constructor(query: string, reason: 'unknown' | 'ambiguous', matches: string[] = []) {
    super(reason === 'unknown' ? `no outbox entry matches "${query}"` : `"${query}" matches ${matches.length} outbox entries (${matches.join(', ')})`);
    this.name = 'UnknownOutboxEntryError';
    this.query = query;
    this.reason = reason;
  }
}

/** A discovery peer annotated with what the trust store says about it. */
export type EnginePeer = PeerInfo & { trusted: boolean; trustedAlias?: string };

export interface EngineOptions {
  /** Config dir (default configDir(): $MESHDROP_HOME, $XDG_CONFIG_HOME/meshdrop, ~/.config/meshdrop). */
  home?: string;
  /** Inbox root (default ~/Downloads/MeshDrop). */
  inbox?: string;
  /** Photo backups from phones land in <backupDir>/<phone name>/ (default ~/Pictures/MeshDrop Backup). */
  backupDir?: string;
  /** Mesh HTTPS port (default 53318; 0 picks a free port, see `engine.port`). */
  port?: number;
  /** Shown to peers (default the host name, truncated to 64 chars). */
  alias?: string;
  deviceType?: Announce['deviceType'];
  /**
   * false: client-only engine (CLI `pair`/`send`/`resume` next to a running `listen` on the same
   * home): no receiver server and no multicast (it would announce a server it does not run, under
   * a possibly different alias). It sees the manually paired devices, which start() re-probes.
   */
  serve?: boolean;
  /** Multicast discovery overrides, or false to rely on manual peers only (default: on when serving). */
  discovery?: Pick<DiscoveryOptions, 'group' | 'port' | 'intervalMs' | 'ttlMs' | 'iface'> | false;
  /**
   * A serving engine's start() removes partial receive sessions untouched for longer than this
   * (default 30 days; their sender abandoned them without a cancel), plus tombstones older than 7 days.
   */
  partialMaxAgeMs?: number;
  /** Hub device settings (used when this home holds the mesh root key). */
  hub?: { ingressPort?: number; heldQuotaBytes?: number; heldTtlMs?: number };
  /** Hub link reconnect backoff (default 1 s .. 60 s). */
  hubBackoffMs?: number[];
  /** On a relay hub, how often to try the main hub again (default 5 min). */
  hubFailbackMs?: number;
  /** On the main hub, how often to fetch what relay hubs held for this device (default 10 min). */
  hubDrainMs?: number;
  /** LocalSend v2 interop (HTTPS port default 53317, multicast 224.0.0.167:53317); false: off. Only with serve. */
  localsend?: { port?: number; multicastPort?: number; iface?: string; answerTimeoutMs?: number } | false;
  /** Internet reach (M5c) seams for tests: fake CLIs, CA, DuckDNS and router. */
  reach?: Omit<ReachEnv, 'home' | 'ingressPort' | 'attachPublic' | 'publish'>;
  /** Total bytes internet guest links may keep on the hub (default 10 GiB). */
  linkQuotaBytes?: number;
  /** The LAN guest server (plain HTTP; default port 53320); false: no guest sessions. Only with serve. */
  guest?: { port?: number } | false;
  /** This device's LAN addresses as reported to the hub and put in invites (default: all non-internal IPv4). */
  lanAddrs?: () => LanAddr[];
  /**
   * Resume unfinished sends to a device by themselves when it shows up (LAN peer or online at the
   * hub), unless they failed for good (source changed, refused). Default: true when serving.
   */
  autoResume?: boolean;
  /** Accept ws:// loopback hub URLs (tests, local tunnels). Default false. */
  allowLoopbackHubUrls?: boolean;
  /**
   * serve: false only: still listen for discovery announcements (never announce), so a client next
   * to a running listener sees the LAN. Default false (one-shot CLI commands).
   */
  clientDiscovery?: boolean;
  /**
   * Bluetooth links (M14, No Wi-Fi): the platform's RFCOMM sockets and the starting policy. Only with
   * serve. Absent: no Bluetooth.
   */
  bt?: { platform: BtPlatform; policy?: LinkPolicy; tickMs?: number; idleMs?: number; backoffMs?: [number, number]; pingMs?: number; dialTimeoutMs?: number };
}

/** A device as the app shows it: who it is, whether we trust it, and how we can reach it now. */
export interface EngineDevice {
  deviceId: string;
  alias: string;
  /** localsend: a LocalSend app on the LAN (untrusted; sends to it go through its own protocol). */
  role: 'hub' | 'member' | 'paired' | 'nearby' | 'localsend';
  trusted: boolean;
  /** bt: over a Bluetooth link (M14). */
  reach: 'lan' | 'bt' | 'hub' | 'offline';
  deviceType?: string;
  lastSeen?: number;
  /** Nearby devices: where they announced themselves (to pair with one click). */
  host?: string;
  port?: number;
}

/** A device id prefix that is not a unique prefix (>= 4 hex chars) of exactly one trusted device. */
export class UnknownDeviceError extends Error {
  /** The prefix as given. */
  readonly query: string;
  readonly reason: 'invalid' | 'unknown' | 'ambiguous';
  /** For 'ambiguous': every trusted device id the prefix matches. */
  readonly matches: string[];
  constructor(query: string, reason: 'invalid' | 'unknown' | 'ambiguous', matches: string[] = []) {
    const what =
      reason === 'invalid'
        ? 'expected at least 4 hex characters of a device id'
        : reason === 'unknown'
          ? 'no trusted device has this id prefix'
          : `matches ${matches.length} trusted devices (${matches.map((m) => m.slice(0, 8)).join(', ')})`;
    super(`unknown device "${query}": ${what}`);
    this.name = 'UnknownDeviceError';
    this.query = query;
    this.reason = reason;
    this.matches = matches;
  }
}

const PREFIX_RE = /^[0-9a-f]{4,64}$/;
const PULL_INTERVAL_MS = 60_000;
const AUTO_RESUME_INTERVAL_MS = 30_000;
/** Folder sync: a round with every present partner this often, and the quiet time after a local change before poking them. */
const SYNC_INTERVAL_MS = 60_000;
const SYNC_DEBOUNCE_MS = 2000;
const SCAN_MAX_ADDRESSES = 512;
const INVITE_POLL_MS = 1000;
const PENDING_RETRY_MS = 10_000;
/** Generous per-frame bound for held sessions: envelope header + framing. */
const HELD_FRAME_OVERHEAD = 32 * 1024;
const PAIR_TIMEOUT_MS = 5000;
const REPROBE_TIMEOUT_MS = 2000;
/** On-demand Bluetooth dial when a send finds no other path (M14). */
const BT_DIAL_TIMEOUT_MS = 8000;

// ---- trust store that follows other processes' writes -------------------------------------------

function fileSig(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}

/**
 * A TrustStore that re-reads trust.json whenever the file changed on disk (TrustStore writes by
 * atomic rename, so the inode changes on every write). This lets a running `meshdrop listen`
 * accept a device that a separate `meshdrop pair` process just added. A corrupt file on reload
 * keeps the last good state.
 */
class LiveTrustStore extends TrustStore {
  readonly #file: string;
  #inner: TrustStore;
  #sig: string;

  constructor(file: string) {
    super(file);
    this.#file = file;
    this.#sig = fileSig(file);
    this.#inner = new TrustStore(file);
  }

  #current(): TrustStore {
    const sig = fileSig(this.#file);
    if (sig !== this.#sig) {
      try {
        this.#inner = new TrustStore(this.#file);
        this.#sig = sig;
      } catch {
        /* keep the last good state */
      }
    }
    return this.#inner;
  }

  list(): TrustedDevice[] {
    return this.#current().list();
  }
  get(deviceId: string): TrustedDevice | undefined {
    return this.#current().get(deviceId);
  }
  isTrusted(deviceId: string): boolean {
    return this.#current().isTrusted(deviceId);
  }
  add(d: TrustedDevice): void {
    this.#current().add(d);
    this.#sig = fileSig(this.#file);
  }
  remove(deviceId: string): void {
    this.#current().remove(deviceId);
    this.#sig = fileSig(this.#file);
  }
}

// ---- manual peer addresses ----------------------------------------------------------------------

interface ManualAddr {
  deviceId: string;
  host: string;
  port: number;
}

function readManual(file: string): ManualAddr[] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { peers?: unknown };
    if (!Array.isArray(j?.peers)) return [];
    return j.peers.filter(
      (p): p is ManualAddr =>
        typeof p === 'object' && p !== null &&
        typeof p.deviceId === 'string' && /^[0-9a-f]{64}$/.test(p.deviceId) &&
        typeof p.host === 'string' && p.host.length > 0 &&
        Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535,
    );
  } catch {
    return [];
  }
}

function writeManual(file: string, peers: ManualAddr[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify({ peers }, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * The listener (`meshdrop listen` or the desktop app) serving `home`, from its listen.pid: only if
 * the pid is alive AND the port answers with this home's own certificate (`deviceId`). A stale file
 * whose pid was reused by another process does not count.
 */
export async function liveListener(home: string, deviceId: string, timeoutMs = 1500): Promise<{ pid: number; port: number } | null> {
  let pid: number;
  let port: number;
  try {
    const j = JSON.parse(readFileSync(join(home, 'listen.pid'), 'utf8')) as { pid?: unknown; port?: unknown };
    if (!Number.isInteger(j.pid) || (j.pid as number) <= 0 || !Number.isInteger(j.port) || (j.port as number) < 1 || (j.port as number) > 65535) return null;
    pid = j.pid as number;
    port = j.port as number;
    process.kill(pid, 0);
  } catch {
    return null;
  }
  try {
    return deviceIdOf(await fetchPeerCert('127.0.0.1', port, timeoutMs)) === deviceId ? { pid, port } : null;
  } catch {
    return null;
  }
}

/** Unpinned TLS 1.3 handshake without a client certificate; returns the peer's certificate DER. */
function fetchPeerCert(host: string, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const sock = connect({
      host,
      port,
      minVersion: 'TLSv1.3',
      // Self-signed peers: there is nothing to validate against. The certificate itself is the
      // identity (deviceId = sha256(DER)); it is pinned on every later connection.
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    let done = false;
    const finish = (err: Error | null, der?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.on('error', () => {});
      sock.destroy();
      if (err) reject(err);
      else resolve(der!);
    };
    const timer = setTimeout(() => finish(new Error(`pair: ${host}:${port} timed out after ${timeoutMs} ms`)), timeoutMs);
    sock.on('error', (e) => finish(e));
    sock.on('secureConnect', () => {
      const cert = sock.getPeerCertificate(true);
      if (!cert || !cert.raw || cert.raw.length === 0) return finish(new Error('pair: peer presented no certificate'));
      finish(null, Buffer.from(cert.raw));
    });
  });
}

/** At most MAX_ALIAS_CHARS UTF-16 units (what Discovery checks), never splitting a code point. */
function truncateAlias(alias: string): string {
  let out = '';
  for (const ch of alias) {
    if (out.length + ch.length > MAX_ALIAS_CHARS) break;
    out += ch;
  }
  return out;
}

const DEVICE_TYPES: readonly string[] = ['desktop', 'mobile', 'headless'];

// ---- engine -------------------------------------------------------------------------------------

interface Running {
  server: Server | null;
  /** The LAN guest server and its port (null / 0: none). */
  guest: HttpServer | null;
  guestPort: number;
  /** The LocalSend server and its discovery (null: off). */
  ls: { server: Server; port: number; discovery: LocalSendDiscovery } | null;
  discovery: Discovery;
  abort: AbortController;
  port: number;
  hub: HubServer | null;
  /** This device is a relay hub for the mesh (no root key; see mesh/relays.ts). */
  relayHub: HubServer | null;
  ingressPort: number;
  client: HubClient | null;
  timers: NodeJS.Timeout[];
}

/** Sealed bytes per upload request of a link made on this member (M9b). */
const MEMBER_LINK_SLICE = 1024 * 1024;

/** A Bluetooth route is a LAN route to the link's local port (`via: 'bt'`), so every caller works unchanged. */
type Route =
  | { kind: 'lan'; host: string; port: number; via?: 'bt'; priorityPort?: number }
  | { kind: 'relay' }
  | { kind: 'held' }
  | { kind: 'unreachable' };

/** Bytes a held session may store on the hub: ciphertext (plaintext + 16 per chunk) plus framing. */
async function estimateHoldBytes(items: SendItem[]): Promise<number> {
  let bytes = 0;
  let frames = 4;
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const n of await readdir(p)) await walk(join(p, n));
      return;
    }
    if (!st.isFile()) return;
    const n = chunkCount(st.size);
    bytes += st.size + 16 * n;
    frames += n + 1;
  };
  for (const it of items) {
    if (it.kind === 'text') bytes += Buffer.byteLength(it.text ?? '');
    else if (it.srcPath) await walk(it.srcPath);
  }
  return bytes + frames * HELD_FRAME_OVERHEAD + CHUNK_SIZE;
}

/** The /24 of each non-internal IPv4 interface. */
function defaultSubnets(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const [a, b, c] = i.address.split('.');
      out.add(`${a}.${b}.${c}.0/24`);
    }
  }
  return [...out];
}

/** Host addresses of an IPv4 CIDR from /24 to /30 (network and broadcast excluded where they exist). */
function expandCidr(cidr: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(2[4-9]|30)$/.exec(cidr);
  if (!m) return [];
  const base = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const bits = Number(m[5]);
  const size = 2 ** (32 - bits);
  const net = (base & ~(size - 1)) >>> 0;
  const out: string[] = [];
  for (let i = 1; i < size - 1; i++) {
    const v = net + i;
    out.push(`${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`);
  }
  return out;
}

function defaultLanAddrs(port: number): LanAddr[] {
  const out: LanAddr[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push({ host: i.address, port });
  }
  return out.slice(0, 8);
}

/** The folder name for a device's photo backups: its name, never a path or "." / "..". */
export function backupFolderName(alias: string): string {
  const n = alias.replace(/[/\\\u0000-\u001f]/g, '_').trim();
  return n === '' || /^\.+$/.test(n) ? 'phone' : n;
}

export class Engine extends EventEmitter {
  readonly identity: Identity;
  readonly trust: TrustStore;
  readonly home: string;
  readonly inboxDir: string;
  readonly alias: string;
  readonly deviceType: Announce['deviceType'];
  private readonly inbox: Inbox;
  private readonly outbox: Outbox;
  private readonly opts: EngineOptions;
  private readonly manualFile: string;
  private running: Running | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private mesh: MembershipStore | null;
  private rootKey: KeyObject | null;
  private readonly invites = new InviteBook();
  /** The root-signed list of relay hubs (M9): kept by every device, signed on the main hub. */
  private readonly relayStore: RelayStore;
  private readonly guestBook = new GuestBook();
  private guestUploads: GuestUploads | null = null;
  private guestShared: SharedFile[] = [];
  private guestUrl: string | null = null;
  private guestTimer: NodeJS.Timeout | null = null;
  private lastInviteSecret = '';
  private joinHandler: ((peer: string, body: unknown) => Promise<{ status: number; body: object }>) | null = null;
  private readonly lastPull = new Map<string, number>();
  private readonly lastAutoResume = new Map<string, number>();
  /** Devices whose auto-resume check is running → whether another sighting came in meanwhile. */
  private readonly autoResuming = new Map<string, boolean>();
  private accepting = true;
  /** Trust for the receiver: mesh members first, then manually paired devices (never a revoked one). */
  private readonly trustSource: TrustSource = {
    isTrusted: (id) => new CompositeTrust(this.mesh, this.trust).isTrusted(id),
    get: (id) => new CompositeTrust(this.mesh, this.trust).get(id),
  };

  private constructor(identity: Identity, home: string, opts: EngineOptions, mesh: MembershipStore | null, rootKey: KeyObject | null) {
    super();
    this.identity = identity;
    this.home = home;
    this.opts = opts;
    this.trust = new LiveTrustStore(join(home, 'trust.json'));
    this.inboxDir = opts.inbox ?? join(homedir(), 'Downloads', 'MeshDrop');
    this.inbox = new Inbox(this.inboxDir);
    this.outbox = new Outbox(join(home, 'outbox'));
    this.manualFile = join(home, 'manual-peers.json');
    this.syncStore = new SyncStore(home);
    this.alias = truncateAlias(opts.alias ?? hostname());
    this.deviceType = opts.deviceType ?? 'desktop';
    this.mesh = mesh;
    this.rootKey = rootKey;
    this.relayStore = new RelayStore(home);
  }

  /** Loads (or creates) the identity under `home`. Opens no sockets: call start(). */
  static async create(opts: EngineOptions = {}): Promise<Engine> {
    const home = opts.home ?? configDir();
    const port = opts.port ?? DEFAULT_MESH_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port ${String(port)}`);
    if (opts.deviceType !== undefined && !DEVICE_TYPES.includes(opts.deviceType)) throw new Error(`invalid deviceType ${String(opts.deviceType)}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const identity = await loadOrCreateIdentity(home);
    const mesh = await MembershipStore.load(home);
    const rootKey = (await hasRootKey(home)) ? await loadOrCreateRootKey(home) : null;
    return new Engine(identity, home, opts, mesh, rootKey);
  }

  /** Mesh port: the bound port once started (also when created with port 0), else the configured one. */
  get port(): number {
    return this.running?.port ?? this.opts.port ?? DEFAULT_MESH_PORT;
  }

  private emitEvent(e: EngineEvent): void {
    try {
      this.emit('event', e);
    } catch {
      /* a throwing listener must not break the server, a send or discovery */
    }
  }

  /** Starts the receiver server (unless serve: false) and discovery, and re-probes manual peers. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.stopping) await this.stopping;
    let server: Server | null = null;
    let port = this.opts.port ?? DEFAULT_MESH_PORT;
    if (this.opts.serve !== false) {
      const prune: { partialMaxAgeMs?: number } = {};
      if (this.opts.partialMaxAgeMs !== undefined) prune.partialMaxAgeMs = this.opts.partialMaxAgeMs;
      await this.inbox.prune(prune).catch(() => {}); // housekeeping must never block receiving
      const s = createMeshServer(this.receiverOptions());
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error) => reject(e);
        s.once('error', onErr);
        s.listen(port, () => {
          s.removeListener('error', onErr);
          resolve();
        });
      });
      s.on('error', () => {}); // post-listen server errors must not crash the process
      server = s;
      port = (s.address() as { port: number }).port;
    }

    const dopts = this.opts.discovery;
    let discovery: Discovery;
    try {
      discovery = this.makeDiscovery(port, dopts, server !== null);
    } catch (e) {
      server?.close();
      throw e;
    }
    if (dopts !== false && (server || this.opts.clientDiscovery)) discovery.start();

    let hub: HubServer | null = null;
    let ingressPort = 0;
    // Requests the hub gets for this very device while it has no link of its own there (a relay
    // hub's link goes to the main hub; the main hub's self-link may not be up yet).
    const { sync: _noSync, ...localOpts } = this.receiverOptions();
    const localHandler = createMeshHandler(localOpts);
    const local = (q: Parameters<typeof localHandler.handle>[0]) => localHandler.handle(q);
    if (server && this.rootKey && this.mesh) {
      const hopts = this.opts.hub ?? {};
      const heldOpts: { quotaBytes?: number; ttlMs?: number } = {};
      if (hopts.heldQuotaBytes !== undefined) heldOpts.quotaBytes = hopts.heldQuotaBytes;
      if (hopts.heldTtlMs !== undefined) heldOpts.ttlMs = hopts.heldTtlMs;
      hub = new HubServer({
        id: this.identity, home: this.home, rootKey: this.rootKey, members: this.mesh,
        relays: () => this.relayStore.current(), local,
        held: new HeldStore(join(this.home, 'hub', 'held'), heldOpts), invites: this.invites,
        hubLan: () => this.lanAddrs(port),
        ingressHttp: this.ingressHandler(),
      });
      hub.attach(server);
      try {
        ingressPort = await hub.listenIngress(hopts.ingressPort ?? DEFAULT_INGRESS_PORT);
      } catch (e) {
        await hub.close();
        server.close();
        throw e;
      }
    }
    let relayHub: HubServer | null = null;
    if (server && !hub && this.mesh && this.isNamedRelay()) {
      const hopts = this.opts.hub ?? {};
      const heldOpts: { quotaBytes?: number; ttlMs?: number } = {};
      if (hopts.heldQuotaBytes !== undefined) heldOpts.quotaBytes = hopts.heldQuotaBytes;
      if (hopts.heldTtlMs !== undefined) heldOpts.ttlMs = hopts.heldTtlMs;
      relayHub = new HubServer({
        id: this.identity, home: this.home, members: this.mesh,
        relays: () => this.relayStore.current(), local,
        held: new HeldStore(join(this.home, 'hub', 'held'), heldOpts), invites: this.invites,
        hubLan: () => this.lanAddrs(port),
        ingressHttp: this.ingressHandler(),
      });
      relayHub.attach(server);
      try {
        ingressPort = await relayHub.listenIngress(hopts.ingressPort ?? DEFAULT_INGRESS_PORT);
      } catch {
        /* the ingress port is taken: the relay still serves on the LAN port */
      }
    }
    if (hub) {
      const h = hub;
      this.reach = new ReachManager({
        ...(this.opts.reach ?? {}),
        home: this.home,
        ingressPort: () => this.running?.ingressPort || ingressPort,
        attachPublic: (s) => h.attachPublic(s),
        publish: async (url, previous) => {
          const cur = this.mesh?.list().hub.urls ?? [];
          const next = cur.filter((u) => u !== previous);
          if (url && !next.includes(url)) next.unshift(url);
          if (next.join('\n') !== cur.join('\n')) await h.setUrls(next);
        },
      });
      void this.reach.start();
    }
    this.joinHandler = createJoinHandler({
      id: this.identity, invites: this.invites, members: () => this.mesh, manualTrust: this.trust,
      ...(hub ? { hub } : {}), hubClient: () => this.running?.client ?? null,
    });

    // The guest server is optional: a taken port leaves guest sessions unavailable, never the receiver.
    let guest: HttpServer | null = null;
    let guestPort = 0;
    if (server && this.opts.guest !== false) {
      rmSync(join(this.home, 'guest-partial'), { recursive: true, force: true }); // left by a crash: no session survives a restart
      const g = createGuestServer({
        book: this.guestBook,
        uploads: () => this.guestUploads,
        shared: () => this.guestShared,
        alias: () => this.alias,
        page: GUEST_PAGE,
        room: () => (this.room?.live ? this.room : null),
        watch: this.watchHandler,
        onClaim: () => this.emitEvent({ source: 'guest', type: 'opened' }),
      });
      const want = (this.opts.guest && this.opts.guest.port) ?? DEFAULT_GUEST_PORT;
      try {
        await new Promise<void>((resolve, reject) => {
          g.once('error', reject);
          g.listen(want, () => {
            g.removeListener('error', reject);
            resolve();
          });
        });
        g.on('error', () => {});
        guest = g;
        guestPort = (g.address() as { port: number }).port;
      } catch {
        /* port in use: no guest sessions */
      }
    }

    // LocalSend interop: optional too (its port may belong to the LocalSend app on this PC).
    let ls: Running['ls'] = null;
    if (server && this.opts.localsend !== false) {
      const lo = this.opts.localsend || {};
      this.lsReceiver = new LocalSendReceiver({
        self: () => this.lsSelf(), partialDir: join(this.home, 'localsend-partial'), inboxRoot: this.inboxDir,
        onEvent: (e) => this.onLocalSend(e), accepting: () => this.accepting,
        ...(lo.answerTimeoutMs !== undefined ? { answerTimeoutMs: lo.answerTimeoutMs } : {}),
      });
      const rcv = this.lsReceiver;
      const s = createHttpsServer({ key: this.identity.keyPem, cert: this.identity.certPem, minVersion: 'TLSv1.2' }, (req, res) => {
        if (!rcv.handle(req, res)) {
          res.writeHead(404);
          res.end();
        }
      });
      try {
        await new Promise<void>((resolve, reject) => {
          s.once('error', reject);
          s.listen(lo.port ?? LS_PORT, () => {
            s.removeListener('error', reject);
            resolve();
          });
        });
        s.on('error', () => {});
        s.on('tlsClientError', () => {});
        rmSync(join(this.home, 'localsend-partial'), { recursive: true, force: true });
        const lsPort = (s.address() as { port: number }).port;
        this.lsPort = lsPort;
        // The peer list always exists (peers also register over HTTPS); multicast only with discovery.
        const disc = new LocalSendDiscovery({
          self: () => this.lsSelf(), register: (p) => lsRegister(p, this.lsSelf()),
          ...(lo.multicastPort !== undefined ? { port: lo.multicastPort } : {}), ...(lo.iface ? { iface: lo.iface } : {}),
        });
        disc.on('error', () => {});
        disc.on('peer', (p: LsPeerInfo) => this.emitEvent({ source: 'localsend', type: 'peer', fingerprint: p.fingerprint, alias: p.alias }));
        if (dopts !== false || lo.iface) disc.start();
        ls = { server: s, port: lsPort, discovery: disc };
      } catch {
        this.lsReceiver = null; // port in use (the LocalSend app itself?): no interop this run
      }
    }

    this.running = { server, guest, guestPort, ls, discovery, abort: new AbortController(), port, hub, relayHub, ingressPort, client: null, timers: [] };
    if (server && this.opts.bt) await this.startBt(this.opts.bt);
    if (server) {
      if (this.mesh) this.startClient();
      const r = this.running;
      const poll = setInterval(() => {
        this.syncInvite();
        void this.pickUpMesh();
        void this.applyHubRequests();
      }, INVITE_POLL_MS);
      poll.unref();
      const pending = setInterval(() => void this.finishPendingJoin(), PENDING_RETRY_MS);
      pending.unref();
      r.timers.push(poll, pending);
      void this.finishPendingJoin();
      const syncTick = setInterval(() => this.syncPresent(), SYNC_INTERVAL_MS);
      syncTick.unref();
      r.timers.push(syncTick);
      this.restartSyncWatch();
    }

    // Manually paired devices are not announced to us by multicast (that is why they were paired
    // manually): look them up at their last known address. Failures are ignored.
    const trusted = new Set(this.trust.list().map((d) => d.deviceId));
    await Promise.allSettled(
      readManual(this.manualFile)
        .filter((m) => trusted.has(m.deviceId))
        .map((m) => discovery.probe(m.host, m.port, { timeoutMs: REPROBE_TIMEOUT_MS })),
    );
  }

  private makeDiscovery(port: number, dopts: EngineOptions['discovery'], announce: boolean): Discovery {
    const discovery = new Discovery({
      self: { v: 1, deviceId: this.identity.deviceId, alias: this.alias, deviceType: this.deviceType, port: port || DEFAULT_MESH_PORT },
      ...(dopts || {}),
      announce,
      isTrusted: (id) => this.trustSource.isTrusted(id),
    });
    discovery.on('error', () => {}); // per-interface socket failures are not fatal
    discovery.on('peer', (p: PeerInfo) => {
      this.emitEvent({ source: 'discovery', type: 'peer', peer: p });
      void this.maybePull(p);
      void this.maybeAutoResume(p.deviceId);
      if (this.syncStore.config().folders.some((f) => f.partners.includes(p.deviceId))) this.scheduleSync(undefined, p.deviceId, 1000);
    });
    discovery.on('lost', (p: PeerInfo) => this.emitEvent({ source: 'discovery', type: 'lost', peer: p }));
    return discovery;
  }

  /**
   * Closes the server and discovery and aborts in-flight sends (they end 'cancelled' and stay in
   * the outbox, resumable). Resolves once those sends have settled. Idempotent.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.doStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    const r = this.running;
    if (!r) return;
    this.running = null;
    r.abort.abort();
    for (const t of r.timers) clearInterval(t);
    this.btLinks?.stop();
    this.btLinks = null;
    for (const w of this.syncWatchers.values()) w.close();
    this.syncWatchers.clear();
    for (const t of this.syncDebounces.values()) clearTimeout(t);
    this.syncDebounces.clear();
    await r.client?.stop();
    await this.reach?.stop(false);
    this.reach = null;
    await r.hub?.close();
    await r.relayHub?.close();
    await this.endGuest(false);
    await this.roomEnd();
    await this.watchRooms?.stop();
    if (r.ls) {
      r.ls.discovery?.stop();
      const closed = new Promise<void>((resolve) => r.ls!.server.close(() => resolve()));
      r.ls.server.closeAllConnections();
      await closed;
      this.lsReceiver = null;
    }
    if (r.guest) {
      const closed = new Promise<void>((resolve) => r.guest!.close(() => resolve()));
      r.guest.closeAllConnections();
      await closed;
    }
    r.discovery.stop();
    r.discovery.removeAllListeners('peer');
    r.discovery.removeAllListeners('lost');
    if (r.server) {
      const closed = new Promise<void>((resolve) => r.server!.close(() => resolve()));
      r.server.closeAllConnections();
      await closed;
    }
    await Promise.allSettled([...this.inflight]);
  }

  private requireRunning(): Running {
    if (!this.running) throw new Error('engine not started');
    return this.running;
  }

  /** Current discovery peers (announced and manual), each marked trusted or not. */
  peers(): EnginePeer[] {
    if (!this.running) return [];
    return this.running.discovery.peers().map((p) => {
      const t = this.trustSource.get(p.deviceId);
      return t ? { ...p, trusted: true, trustedAlias: t.alias } : { ...p, trusted: false };
    });
  }

  /** Resolves a unique prefix (>= 4 hex chars, case-insensitive) of a trusted device id. */
  resolveDeviceId(query: string): string {
    const q = query.toLowerCase();
    if (!PREFIX_RE.test(q)) throw new UnknownDeviceError(query, 'invalid');
    const matches = this.trustedIds().filter((id) => id.startsWith(q));
    if (matches.length === 0) throw new UnknownDeviceError(query, 'unknown');
    if (matches.length > 1) throw new UnknownDeviceError(query, 'ambiguous', matches);
    return matches[0]!;
  }

  /** Every device this one may send to: mesh members and manually paired devices, never itself. */
  private trustedIds(): string[] {
    const ids = new Set<string>(this.trust.list().map((d) => d.deviceId));
    for (const m of this.mesh?.list().members ?? []) ids.add(m.deviceId);
    ids.delete(this.identity.deviceId);
    return [...ids].filter((id) => this.trustSource.isTrusted(id));
  }

  private directory(): DirectoryEntry[] {
    const r = this.running;
    return r?.hub ? r.hub.directory() : (r?.client?.directory() ?? []);
  }

  private hubOnline(): boolean {
    return this.running?.client?.state === 'online';
  }

  /**
   * How to reach `deviceId` now: LAN if discovery knows it (or one of its directory addresses
   * answers), else the hub relay if it is online there, else held on the hub, else unreachable.
   */
  private async route(deviceId: string): Promise<Route> {
    const r = this.requireRunning();
    const mode = this.linkMode(deviceId);
    const viaHubOk = this.mesh?.isTrusted(deviceId) === true; // only mesh members are reachable through the hub
    const known = (): PeerInfo | undefined => r.discovery.peers().find((p) => p.deviceId === deviceId);
    const dir = this.directory().find((d) => d.deviceId === deviceId);
    if (mode !== 'bt') {
      let peer = known();
      if (!peer && dir) {
        for (const a of dir.lanAddrs) {
          await r.discovery.probe(a.host, a.port, { timeoutMs: REPROBE_TIMEOUT_MS }).catch(() => {});
          peer = known();
          if (peer) break;
        }
      }
      if (peer) return { kind: 'lan', host: peer.host, port: peer.port };
    }
    if (mode !== 'wifi' && this.btLinks) {
      const l = this.btLinks.link(deviceId) ?? (await this.btLinks.ensure(deviceId, this.opts.bt?.dialTimeoutMs ?? BT_DIAL_TIMEOUT_MS));
      if (l?.ports) return { kind: 'lan', host: '127.0.0.1', port: l.ports.normal, via: 'bt', priorityPort: l.ports.priority };
    }
    if (mode !== 'bt' && viaHubOk && this.hubOnline()) return dir?.online ? { kind: 'relay' } : { kind: 'held' };
    return { kind: 'unreachable' };
  }

  // ---- Bluetooth links (M14) ----------------------------------------------------------------------

  private btLinks: BtLinks | null = null;
  private btPolicy: LinkPolicy = DEFAULT_LINK_POLICY;

  private async startBt(o: NonNullable<EngineOptions['bt']>): Promise<void> {
    if (o.policy) this.btPolicy = o.policy;
    const links = new BtLinks({
      platform: o.platform,
      selfId: this.identity.deviceId,
      meshPort: () => this.port,
      isTrusted: (id) => this.trustSource.isTrusted(id),
      trustedIds: () => this.trustedIds(),
      onLan: (id) => this.running?.discovery.peers().some((p) => p.deviceId === id) ?? false,
      file: join(this.home, 'bt-peers.json'),
      ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
      ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
      ...(o.backoffMs ? { backoffMs: o.backoffMs } : {}),
      ...(o.pingMs ? { pingMs: o.pingMs } : {}),
    });
    links.setPolicy(this.btPolicy);
    links.on('up', (id: string) => {
      this.emitEvent({ source: 'bt', type: 'up', deviceId: id });
      void this.maybeAutoResume(id);
    });
    links.on('down', (id: string) => this.emitEvent({ source: 'bt', type: 'down', deviceId: id }));
    try {
      await links.start();
      this.btLinks = links;
    } catch {
      links.stop(); // no adapter, or Bluetooth off: the LAN and hub paths still work
    }
  }

  /** The link policy (No Wi-Fi settings): Bluetooth on/off, everything over Bluetooth, per-device mode. */
  setLinkPolicy(p: LinkPolicy): void {
    this.btPolicy = { bluetooth: p.bluetooth, allBluetooth: p.allBluetooth, deviceLinks: { ...p.deviceLinks } };
    this.btLinks?.setPolicy(this.btPolicy);
  }

  linkPolicy(): LinkPolicy {
    return this.btPolicy;
  }

  /** How `deviceId` may be reached: 'wifi' whenever this engine has no Bluetooth. */
  linkMode(deviceId: string): LinkMode {
    return this.btLinks ? this.btLinks.mode(deviceId) : 'wifi';
  }

  /** Whether the device is reached over Bluetooth right now (live sound picks Opus then). */
  async viaBluetooth(deviceId: string): Promise<boolean> {
    const route = await this.route(this.resolveDeviceId(deviceId));
    return route.kind === 'lan' && route.via === 'bt';
  }

  /** Devices with a Bluetooth link up now. */
  btLinked(): string[] {
    return this.btLinks?.linked() ?? [];
  }

  /** Whether Bluetooth links run (a platform was given and it started). */
  btAvailable(): boolean {
    return this.btLinks !== null;
  }

  private transportFor(route: Route, target: Target, holdBytes: number): Transport {
    const client = this.running?.client;
    if (route.kind === 'lan') return new LanTransport(this.identity, { deviceId: target.deviceId, host: route.host, port: route.port });
    if ((route.kind === 'relay' || route.kind === 'held') && client) {
      const pubOf = (id: string): KeyObject | undefined => {
        const t = this.trustSource.get(id) ?? (id === client.hubDeviceId ? this.mesh?.get(id) : undefined);
        return t ? createPublicKey(t.publicKeyPem) : undefined;
      };
      return new RelayTransport(this.identity, client, target.deviceId, pubOf, route.kind, route.kind === 'held' ? holdBytes : undefined);
    }
    return new LanTransport(this.identity, { deviceId: target.deviceId }); // no address: fails 'no-route'
  }

  private lanAddrs(port: number): LanAddr[] {
    return this.opts.lanAddrs ? this.opts.lanAddrs() : defaultLanAddrs(port);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => {});
    return p;
  }

  /**
   * Sends `items` to each device (unique trusted id prefixes) or to 'all' (every trusted device
   * currently present; [] if there is none). Rejects with UnknownDeviceError for a bad prefix,
   * before anything is sent. A trusted device that is not present gets {status:'failed',
   * error:'offline'} and the send waits in the outbox until the device shows up (auto-resume).
   * Results are in request order; duplicates are sent once.
   */
  async send(deviceIds: string[] | 'all', items: SendItem[], opts: { tag?: string; backup?: boolean; clipboardFiles?: boolean; burn?: boolean; print?: boolean } = {}): Promise<SendResult[]> {
    const tag = opts.tag !== undefined ? { tag: opts.tag } : {};
    const r = this.requireRunning();
    let ids: string[];
    if (deviceIds === 'all') {
      const present = new Set(r.discovery.peers().map((p) => p.deviceId).filter((id) => this.linkMode(id) !== 'bt'));
      for (const d of this.directory()) if (d.online && this.linkMode(d.deviceId) !== 'bt') present.add(d.deviceId);
      for (const id of this.btLinked()) present.add(id);
      ids = this.trustedIds().filter((id) => present.has(id));
      if (ids.length === 0) return [];
    } else {
      ids = deviceIds.map((q) => this.resolveDeviceId(q));
    }
    const run = async (): Promise<SendResult[]> => {
      const unique = [...new Set(ids)];
      const routes = new Map<string, Route>();
      for (const id of unique) routes.set(id, await this.route(id));
      const holdBytes = unique.some((id) => routes.get(id)!.kind === 'held') ? await estimateHoldBytes(items) : 0;
      // A device that is away still gets its session: it fails 'offline' at once and stays in the
      // outbox, so auto-resume sends it when the device is seen again (LAN or hub directory).
      const targets: Target[] = [];
      for (const id of unique) {
        const t = this.trustSource.get(id);
        if (t) targets.push({ deviceId: id, publicKey: createPublicKey(t.publicKeyPem) });
      }
      const progress = (p: { deviceId: string; sessionId: string; fileId: number; sent: number; total: number }) => this.emitEvent({ source: 'sender', type: 'progress', ...p, ...tag });
      const sent =
        targets.length === 0
          ? []
          : await multiSend(this.identity, targets, items, {
              outbox: this.outbox,
              signal: r.abort.signal,
              onProgress: progress,
              ...(opts.backup ? { backup: true } : {}),
              ...(opts.clipboardFiles ? { clipboardFiles: true } : {}),
              ...(opts.burn ? { burn: true } : {}),
              ...(opts.print ? { print: true } : {}),
              transport: (t) => {
                const route = routes.get(t.deviceId)!;
                if (route.kind === 'unreachable') throw new Error('offline');
                return this.transportFor(route, t, holdBytes);
              },
            });
      // A LAN attempt that failed for a transient reason resumes the same session over the hub once.
      // A relay that found the target gone (our directory was stale) leaves it on the hub instead.
      for (const [i, res] of sent.entries()) {
        if (res.status !== 'failed' || !this.hubOnline() || this.mesh?.isTrusted(res.deviceId) !== true || this.linkMode(res.deviceId) === 'bt') continue;
        const was = routes.get(res.deviceId)?.kind;
        const lanHiccup = was === 'lan' && isTransientError(res.error);
        const relayGone = was === 'relay' && res.error === 'http-503 offline';
        if (!lanHiccup && !relayGone) continue;
        const dir = this.directory().find((d) => d.deviceId === res.deviceId);
        const route: Route = dir?.online && !relayGone ? { kind: 'relay' } : { kind: 'held' };
        const hb = route.kind === 'held' ? await estimateHoldBytes(items) : 0;
        const t = targets.find((x) => x.deviceId === res.deviceId)!;
        sent[i] = await sendTo(this.identity, t, items, {
          outbox: this.outbox, signal: r.abort.signal, ...(opts.backup ? { backup: true } : {}), ...(opts.clipboardFiles ? { clipboardFiles: true } : {}),
          ...(opts.burn ? { burn: true } : {}), ...(opts.print ? { print: true } : {}),
          onProgress: (p) => progress({ deviceId: t.deviceId, ...p }),
          transport: (tt) => this.transportFor(route, tt, hb),
        });
      }
      const byId = new Map(sent.map((s) => [s.deviceId, s]));
      const out = ids.map((id): SendResult => byId.get(id) ?? { deviceId: id, status: 'failed', sessionId: '', error: 'offline' });
      const seen = new Set<string>();
      for (const res of out) {
        if (seen.has(res.deviceId)) continue;
        seen.add(res.deviceId);
        this.emitEvent({ source: 'sender', type: 'result', ...res, ...tag });
      }
      return out;
    };
    return this.track(run());
  }

  /** Sends `text` as clipboard content (the receiving app puts it on its clipboard). */
  async sendClipboard(deviceIds: string[] | 'all', text: string, opts: { tag?: string } = {}): Promise<SendResult[]> {
    return this.send(deviceIds, [{ kind: 'text', text, clipboard: true }], opts);
  }

  /** Copied files (or an image saved to a file): the receiver saves them and puts them on its clipboard. */
  async sendClipboardFiles(deviceIds: string[] | 'all', paths: string[], opts: { tag?: string } = {}): Promise<SendResult[]> {
    if (paths.length === 0) throw new Error('nothing copied');
    return this.send(deviceIds, paths.map((p) => ({ kind: 'file' as const, srcPath: p })), { ...opts, clipboardFiles: true });
  }

  /**
   * Resumes every unfinished send in the outbox. Targets come from the trust store and the current
   * peers; an entry whose device is not trusted or not present stays in the outbox and is reported
   * as failed 'target-unresolved'.
   */
  async resumePending(): Promise<SendResult[]> {
    const r = this.requireRunning();
    const run = async (): Promise<SendResult[]> => {
      const routes = new Map<string, Route>();
      for (const e of await this.outbox.list()) if (!routes.has(e.target.deviceId)) routes.set(e.target.deviceId, await this.route(e.target.deviceId));
      const resolve = (id: string): Target | undefined => {
        const t = this.trustSource.get(id);
        const route = routes.get(id);
        if (!t || !route || route.kind === 'unreachable') return undefined;
        return { deviceId: id, publicKey: createPublicKey(t.publicKeyPem) };
      };
      const results = await this.outbox.resumeAll(this.identity, resolve, {
        signal: r.abort.signal,
        onProgress: (p) => this.emitEvent({ source: 'sender', type: 'progress', ...p }),
        // Held mode only for a fresh upload; a resumed entry goes live (relay) or over the LAN.
        transport: (t) => this.transportFor(routes.get(t.deviceId)!.kind === 'held' ? { kind: 'relay' } : routes.get(t.deviceId)!, t, 0),
      });
      for (const res of results) this.emitEvent({ source: 'sender', type: 'result', ...res });
      return results;
    };
    return this.track(run());
  }

  private outboxItem(e: OutboxEntry): OutboxItem {
    const item: OutboxItem = {
      sessionId: e.sessionId,
      deviceId: e.target.deviceId,
      createdAt: e.createdAt,
      files: e.manifest.files.length,
      bytes: e.manifest.files.reduce((n, f) => n + f.size, 0),
      text: e.manifest.text !== undefined,
      waiting: e.lastError === 'cancelled' || isTransientError(e.lastError),
    };
    if (e.lastError !== undefined) item.lastError = e.lastError;
    const t = this.trust.get(e.target.deviceId);
    if (t) item.alias = t.alias;
    return item;
  }

  /** Unfinished sends in the outbox, oldest first. Works without start(). */
  async listOutbox(): Promise<OutboxItem[]> {
    return (await this.outbox.list()).map((e) => this.outboxItem(e));
  }

  /**
   * Removes an unfinished send from the outbox (`sessionId` may be a unique prefix), so it is never
   * resumed, and posts a best-effort `cancel` to its receiver so it drops the partial data: at the
   * address discovery currently knows (when started), else the one recorded with the entry.
   * `cancelled` tells whether the receiver acknowledged. Rejects with UnknownOutboxEntryError for an
   * unknown or ambiguous prefix, and refuses a send that is running in this process.
   */
  async removeOutbox(sessionId: string): Promise<{ removed: OutboxItem; cancelled: boolean }> {
    const entries = await this.outbox.list();
    const exact = entries.find((e) => e.sessionId === sessionId);
    const matches = exact ? [exact] : entries.filter((e) => sessionId.length > 0 && e.sessionId.startsWith(sessionId));
    if (matches.length === 0) throw new UnknownOutboxEntryError(sessionId, 'unknown');
    if (matches.length > 1) throw new UnknownOutboxEntryError(sessionId, 'ambiguous', matches.map((e) => e.sessionId));
    const e = matches[0]!;
    if (isSessionActive(e.sessionId)) throw new Error(`outbox entry ${e.sessionId} is being sent right now; stop that send first`);
    await this.outbox.remove(e.sessionId);
    const peer = this.running?.discovery.peers().find((p) => p.deviceId === e.target.deviceId);
    const bt = this.btLinks?.link(e.target.deviceId)?.ports;
    const addr: { host?: string; port?: number } = peer && this.linkMode(e.target.deviceId) !== 'bt' ? { host: peer.host, port: peer.port } : bt ? { host: '127.0.0.1', port: bt.normal } : {};
    if (!peer && e.target.host !== undefined && e.target.port !== undefined) Object.assign(addr, { host: e.target.host, port: e.target.port });
    const cancelled = await postCancel(this.identity, { deviceId: e.target.deviceId, ...addr }, e.sessionId);
    return { removed: this.outboxItem(e), cancelled };
  }

  /**
   * M1 trust bootstrap (M2 replaces it with QR + hub membership): connects to host:port, takes the
   * device id and public key from the certificate it presents, adds it to the trust store under
   * `alias` and keeps it as a manual peer (also after a restart). The other side must pair back.
   */
  /**
   * Looks at the device at host:port without trusting it: its id, its name, and the pairing code to
   * compare with what that device shows (both compute it from the two ids).
   */
  async pairProbe(host: string, port: number): Promise<{ deviceId: string; alias: string; code: string }> {
    const r = this.requireRunning();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`pair: invalid port ${String(port)}`);
    const deviceId = deviceIdOf(await fetchPeerCert(host, port, PAIR_TIMEOUT_MS));
    if (deviceId === this.identity.deviceId) throw new Error('pair: that is this device; you cannot pair with yourself');
    await r.discovery.probe(host, port, { timeoutMs: PAIR_TIMEOUT_MS }).catch(() => {});
    const alias = r.discovery.peers().find((p) => p.deviceId === deviceId)?.alias ?? host;
    return { deviceId, alias, code: pairingCode(this.identity.deviceId, deviceId) };
  }

  /** The pairing code with a device (the same number that device shows for this one). */
  pairingCode(deviceId: string): string {
    return pairingCode(this.identity.deviceId, deviceId);
  }

  /**
   * Trusts the device at host:port. `expectDeviceId`: the device whose pairing code the user checked
   * (pairProbe); a different certificate answering now is refused.
   */
  async pairManual(host: string, port: number, alias: string, expectDeviceId?: string): Promise<TrustedDevice> {
    const r = this.requireRunning();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`pair: invalid port ${String(port)}`);
    const der = await fetchPeerCert(host, port, PAIR_TIMEOUT_MS);
    const deviceId = deviceIdOf(der);
    if (deviceId === this.identity.deviceId) throw new Error('pair: that is this device; you cannot pair with yourself');
    if (expectDeviceId !== undefined && deviceId !== expectDeviceId) throw new Error('pair: another device answered at that address than the one whose code you checked');
    const publicKeyPem = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'pem' }) as string;

    // Enter it in discovery as a manual peer; the probe derives the id from the certificate again,
    // so check that the same device answered both connections.
    await r.discovery.probe(host, port, { timeoutMs: PAIR_TIMEOUT_MS });
    const peer = r.discovery.peers().find((p) => p.deviceId === deviceId);
    if (!peer || peer.host !== host || peer.port !== port) {
      throw new Error(`pair: ${host}:${port} presented a different certificate on the second connection`);
    }

    this.trust.add({ deviceId, alias, publicKeyPem, addedAt: Date.now() }); // validates SPKI P-256
    const manual = readManual(this.manualFile).filter((m) => m.deviceId !== deviceId);
    manual.push({ deviceId, host, port });
    writeManual(this.manualFile, manual);
    return this.trust.get(deviceId)!;
  }

  // ---- device view, nearby, auto-resume (M3) ------------------------------------------------------

  /** Every device worth showing: mesh members, paired devices and LAN peers (never this one). */
  devices(): EngineDevice[] {
    const me = this.identity.deviceId;
    const peers = new Map((this.running?.discovery.peers() ?? []).map((p) => [p.deviceId, p]));
    const dir = new Map(this.directory().map((d) => [d.deviceId, d]));
    const out = new Map<string, EngineDevice>();
    const bt = new Set(this.btLinked());
    const reach = (id: string, viaHub: boolean): EngineDevice['reach'] => {
      const mode = this.linkMode(id);
      if (mode !== 'bt' && peers.has(id)) return 'lan';
      if (mode !== 'wifi' && bt.has(id)) return 'bt';
      return mode !== 'bt' && viaHub && this.hubOnline() && dir.get(id)?.online ? 'hub' : 'offline';
    };
    const list = this.mesh?.list();
    for (const m of list?.members ?? []) {
      if (m.deviceId === me) continue;
      out.set(m.deviceId, { deviceId: m.deviceId, alias: m.alias, role: m.role === 'hub' ? 'hub' : 'member', trusted: true, reach: reach(m.deviceId, true) });
    }
    for (const t of this.trust.list()) {
      if (t.deviceId === me || out.has(t.deviceId) || !this.trustSource.isTrusted(t.deviceId)) continue;
      out.set(t.deviceId, { deviceId: t.deviceId, alias: t.alias, role: 'paired', trusted: true, reach: reach(t.deviceId, false) });
    }
    for (const p of peers.values()) {
      if (p.deviceId === me) continue;
      const cur = out.get(p.deviceId);
      if (cur) {
        cur.deviceType = p.deviceType;
        cur.lastSeen = p.lastSeen;
      } else if (!this.mesh?.isRevoked(p.deviceId)) {
        out.set(p.deviceId, { deviceId: p.deviceId, alias: p.alias, role: 'nearby', trusted: false, reach: 'lan', deviceType: p.deviceType, lastSeen: p.lastSeen, host: p.host, port: p.port });
      }
    }
    for (const [id, d] of out) if (d.lastSeen === undefined && dir.get(id)?.lastSeen) d.lastSeen = dir.get(id)!.lastSeen;
    for (const p of this.localsendPeers()) {
      if (out.has(p.fingerprint) || p.fingerprint === this.identity.deviceId) continue;
      out.set(p.fingerprint, { deviceId: p.fingerprint, alias: p.alias, role: 'localsend', trusted: false, reach: 'lan', deviceType: p.deviceType ?? 'mobile', lastSeen: p.lastSeen });
    }
    return [...out.values()];
  }

  /** Looks for a MeshDrop device at host:port (it shows up as nearby until paired or in the mesh). */
  async addNearby(host: string, port: number = DEFAULT_MESH_PORT): Promise<void> {
    const r = this.requireRunning();
    await r.discovery.probe(host, port, { timeoutMs: PAIR_TIMEOUT_MS });
    const p = r.discovery.peers().find((x) => x.host === host && x.port === port);
    if (p) void this.maybeAutoResume(p.deviceId);
  }

  /**
   * Unpairs a manually paired device: it is no longer trusted, its saved address and its unfinished
   * sends are dropped. While it is on the LAN it shows as nearby again, so Pair re-pairs it. A mesh
   * member is removed on the hub instead (revoke).
   */
  async unpair(query: string): Promise<void> {
    const id = this.resolveDeviceId(query);
    if (this.mesh?.isTrusted(id)) throw new Error('This device is in your mesh: remove it on the hub PC (More → Mesh → Revoke).');
    this.trust.remove(id);
    writeManual(this.manualFile, readManual(this.manualFile).filter((m) => m.deviceId !== id));
    for (const o of await this.outbox.list()) if (o.target.deviceId === id) await this.outbox.remove(o.sessionId);
    const sc = this.syncStore.config();
    if (sc.folders.some((f) => f.partners.includes(id))) this.syncStore.setConfig({ folders: sc.folders.map((f) => ({ ...f, partners: f.partners.filter((p) => p !== id) })) });
  }

  /** Drops a device from the LAN peer table (it is still trusted; it reappears when seen). */
  forgetPeer(deviceId: string): void {
    this.running?.discovery.forget(deviceId);
  }

  /**
   * Probes every address of this device's /24 networks (or `subnets`) on the mesh port(s) and
   * returns how many devices it found that were not known before. At most 512 addresses.
   */
  async scanSubnet(opts: { subnets?: string[]; ports?: number[]; timeoutMs?: number; concurrency?: number } = {}): Promise<number> {
    const r = this.requireRunning();
    const ports = opts.ports ?? [...new Set([DEFAULT_MESH_PORT, r.port])];
    const subnets = opts.subnets ?? defaultSubnets();
    const hosts: string[] = [];
    for (const cidr of subnets) for (const h of expandCidr(cidr)) if (hosts.length < SCAN_MAX_ADDRESSES) hosts.push(h);
    const before = new Set(r.discovery.peers().map((p) => p.deviceId));
    const jobs = hosts.flatMap((h) => ports.map((p) => [h, p] as const));
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && this.running === r) {
        const [h, p] = jobs[next++]!;
        await r.discovery.probe(h, p, { timeoutMs: opts.timeoutMs ?? 400 }).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 32, jobs.length) }, worker));
    return r.discovery.peers().filter((p) => !before.has(p.deviceId) && p.deviceId !== this.identity.deviceId).length;
  }

  /**
   * A device just showed up: resume its unfinished sends that ended by a pause or a transient
   * failure (never a source change or a refusal). At most once per device every 30 s.
   */
  private async maybeAutoResume(deviceId: string): Promise<void> {
    const r = this.running;
    if (!r || !r.server || this.opts.autoResume === false) return;
    const last = this.lastAutoResume.get(deviceId) ?? 0;
    if (Date.now() - last < AUTO_RESUME_INTERVAL_MS) return;
    if (this.autoResuming.has(deviceId)) {
      this.autoResuming.set(deviceId, true); // check again when the running one found nothing to do
      return;
    }
    this.autoResuming.set(deviceId, false);
    try {
      let resumed = false;
      do {
        this.autoResuming.set(deviceId, false);
        resumed = await this.autoResume(r, deviceId);
      } while (!resumed && this.autoResuming.get(deviceId) === true && this.running === r);
    } finally {
      this.autoResuming.delete(deviceId);
    }
  }

  /** One auto-resume pass; true if it resumed something. */
  private async autoResume(r: Running, deviceId: string): Promise<boolean> {
    const entries = (await this.outbox.list()).filter(
      (e) => e.target.deviceId === deviceId && !isSessionActive(e.sessionId) && e.lastError !== undefined &&
        (e.lastError === 'cancelled' || isTransientError(e.lastError)),
    );
    if (entries.length === 0) return false;
    const t = this.trustSource.get(deviceId);
    if (!t) return false;
    const route = await this.route(deviceId);
    if (route.kind === 'unreachable') return false;
    this.lastAutoResume.set(deviceId, Date.now());
    const target: Target = { deviceId, publicKey: createPublicKey(t.publicKeyPem) };
    const run = async () => {
      for (const e of entries) {
        const res = await this.outbox.resumeEntry(this.identity, e.sessionId, target, {
          signal: r.abort.signal,
          onProgress: (p) => this.emitEvent({ source: 'sender', type: 'progress', ...p }),
          transport: (tt) => this.transportFor(route.kind === 'held' ? { kind: 'relay' } : route, tt, 0),
        });
        this.emitEvent({ source: 'sender', type: 'result', ...res });
      }
    };
    await this.track(run());
    return true;
  }

  private readHubAddr(): { deviceId: string; host: string; port: number } | null {
    try {
      const j = JSON.parse(readFileSync(join(this.home, 'hub-addr.json'), 'utf8')) as Record<string, unknown>;
      if (typeof j.deviceId === 'string' && typeof j.host === 'string' && Number.isInteger(j.port)) return { deviceId: j.deviceId, host: j.host, port: j.port as number };
    } catch {
      /* none */
    }
    return null;
  }

  private writeHubAddr(a: { deviceId: string; host: string; port: number }): void {
    writeFileAtomic(join(this.home, 'hub-addr.json'), JSON.stringify(a));
  }

  // ---- mesh (M2) --------------------------------------------------------------------------------

  private receiverOptions(): Parameters<typeof createMeshServer>[0] {
    return {
      id: this.identity,
      trust: this.trustSource,
      inbox: this.inbox,
      alias: this.alias,
      deviceType: this.deviceType,
      onEvent: (e) => void this.onReceiverEvent(e),
      onJoin: async (peer, body) => {
        this.syncInvite();
        if (!this.joinHandler) return { status: 404, body: { error: 'not-found' } };
        const r = await this.joinHandler(peer, body);
        if (r.status === 200) this.markInviteUsed(); // single use, also across restarts
        return r;
      },
      membership: () => this.mesh?.current() ?? null,
      accepting: () => this.accepting,
      sync: syncRoutes({ store: this.syncStore, onPoke: (peer, folder) => this.scheduleSync(folder, peer, 300) }),
      links: (peer, method, seg, q, body) => this.memberLinkRoutes(peer, method, seg, q, body),
      stream: (s) => this.streamHandler?.(s) ?? false,
      app: (peer, msg) => (this.appHandler ? this.appHandler(peer, msg) : Promise.resolve({ status: 404, body: { error: 'not-found' } })),
    };
  }

  /** The app's handler for app messages from trusted devices (M10). */
  private appHandler: ((peer: string, msg: unknown) => Promise<{ status: number; body: unknown }>) | null = null;

  setAppHandler(h: ((peer: string, msg: unknown) => Promise<{ status: number; body: unknown }>) | null): void {
    this.appHandler = h;
  }

  /** The app's handler for live streams (M10b, LAN only; see MeshServerOptions.stream). */
  private streamHandler: MeshServerOptions['stream'] | null = null;

  setStreamHandler(h: MeshServerOptions['stream'] | null): void {
    this.streamHandler = h;
  }

  /**
   * Pushes a live body (raw sound) to a paired device's stream handler: POST /mesh/v1/stream/<path>,
   * on the LAN or a Bluetooth link (its priority port), never through the hub (too slow). Resolves with
   * the answer's status once the body ends, or at once when the device refuses (403 when it does not
   * allow us).
   */
  async streamPost(deviceId: string, path: string, contentType: string, body: Readable, signal?: AbortSignal): Promise<number> {
    const id = this.resolveDeviceId(deviceId);
    const t = this.trustSource.get(id);
    if (!t) throw new Error('That device is not paired.');
    const route = await this.route(id);
    if (route.kind !== 'lan') throw new Error('Live sound works when both devices are on the same Wi-Fi or linked over Bluetooth.');
    const live: Route = route.priorityPort ? { ...route, port: route.priorityPort } : route;
    const tr = this.transportFor(live, { deviceId: id, publicKey: createPublicKey(t.publicKeyPem) }, 0);
    const r = await tr.request('POST', `/mesh/v1/stream/${path}`, body, { 'content-type': contentType }, { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
    return r.status;
  }

  /**
   * Sends an app message (M10: remote input, ring, status...) to a trusted device, over the LAN when it
   * is there, else through the hub. Throws when the device cannot be reached now.
   */
  async appSend(deviceId: string, msg: Record<string, unknown>, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
    const id = this.resolveDeviceId(deviceId);
    const t = this.trustSource.get(id);
    if (!t) throw new Error('That device is not paired.');
    const route = await this.route(id);
    if (route.kind !== 'lan' && route.kind !== 'relay') throw new Error('That device is not reachable now.');
    const tr = this.transportFor(route, { deviceId: id, publicKey: createPublicKey(t.publicKeyPem) }, 0);
    const r = await tr.request('POST', '/mesh/v1/app', Buffer.from(JSON.stringify(msg)), { 'content-type': 'application/json' }, { timeoutMs });
    return { status: r.status, body: r.json ?? null };
  }

  /**
   * Internet links made on members (M9b), served by a hub (main or relay): the member seals the link
   * on its own device and uploads only ciphertext; the key stays in the member's URL fragment.
   *   POST   links                      {id, keyHash, label, expiresInMs, files:[{size}], manifest(b64), password?, maxDownloads?}
   *   PUT    links/<id>/<i>/<offset>    sealed bytes of file i               -> {have}
   *   POST   links/<id>/done                                                 -> {base}
   *   GET    links                      this member's links
   *   POST   links/<id>/revoke
   * (Relay envelopes carry only GET/POST/PUT and plain paths, so no query and no DELETE.)
   */
  private async memberLinkRoutes(peer: string, method: string, seg: string[], _q: URLSearchParams, body: (cap: number) => Promise<Buffer>): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const json = (status: number, v: unknown) => ({ status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(v)) });
    const r = this.running;
    if (!r || (!r.hub && !r.relayHub)) return json(404, { error: 'not-a-hub' });
    if (!this.mesh?.isTrusted(peer)) return json(403, { error: 'not-a-member' });
    const store = this.links();
    const root = seg.length === 0 || (seg.length === 1 && seg[0] === '');
    try {
      if (method === 'GET' && root) return json(200, await store.listOwned(peer));
      if (method === 'POST' && root) {
        const x = JSON.parse((await body(2 * 1024 * 1024)).toString('utf8')) as Record<string, unknown>;
        if (typeof x.id !== 'string' || typeof x.keyHash !== 'string' || typeof x.label !== 'string' || typeof x.expiresInMs !== 'number' || !Array.isArray(x.files) || typeof x.manifest !== 'string') return json(400, { error: 'bad-request' });
        await store.importBegin(peer, {
          id: x.id, keyHash: x.keyHash, label: x.label, expiresInMs: x.expiresInMs,
          files: (x.files as { size?: unknown }[]).map((f) => ({ size: Number(f?.size) })),
          manifest: Buffer.from(x.manifest, 'base64'),
          ...(x.password && typeof x.password === 'object' ? { password: x.password as { salt: string; hash: string } } : {}),
          ...(typeof x.maxDownloads === 'number' ? { maxDownloads: x.maxDownloads } : {}),
        });
        return json(201, { id: x.id });
      }
      const id = seg[0] ?? '';
      if (method === 'PUT' && seg.length === 3 && /^\d{1,4}$/.test(seg[1]!) && /^\d{1,15}$/.test(seg[2]!)) {
        const have = await store.importPut(peer, id, Number(seg[1]), Number(seg[2]), await body(MEMBER_LINK_SLICE + 1024));
        return json(200, { have });
      }
      if (method === 'POST' && seg.length === 2 && seg[1] === 'done') {
        await store.importDone(peer, id);
        return json(200, { base: this.servedLinkBase() });
      }
      if (method === 'POST' && seg.length === 2 && seg[1] === 'revoke') {
        await store.revokeOwned(peer, id);
        return json(200, { ok: true });
      }
      return json(404, { error: 'not-found' });
    } catch (e) {
      if (e instanceof LinkError) return json(e.status, { error: e.code });
      if (e instanceof SyntaxError) return json(400, { error: 'bad-json' });
      throw e;
    }
  }

  /** The public base links on this hub are served at: the main hub's, or this relay hub's own address. */
  private servedLinkBase(): string {
    if (this.running?.relayHub) {
      const u = this.relayList()?.relays.find((x) => x.deviceId === this.identity.deviceId)?.urls[0];
      if (u) {
        const p = new URL(u);
        return `${p.protocol === 'wss:' ? 'https:' : 'http:'}//${p.host}`;
      }
    }
    return this.linkBase();
  }

  /** Sessions that are photo backups (manifest `backup`), by session id → sender. */
  private readonly backupSessions = new Map<string, string>();

  get backupDir(): string {
    return this.opts.backupDir ?? join(homedir(), 'Pictures', 'MeshDrop Backup');
  }

  /**
   * Receiver events go out as they are, except a finished photo backup: its files move from the
   * inbox to <backupDir>/<sender name>/ first (free names, never over a file), and the event
   * carries the new paths and `backup: true`.
   */
  private async onReceiverEvent(e: ReceiverEvent): Promise<void> {
    if (e.type === 'offer' && e.manifest.backup === true) this.backupSessions.set(e.sessionId, e.from);
    if (e.type === 'received' && this.backupSessions.has(e.sessionId)) {
      this.backupSessions.delete(e.sessionId);
      const alias = backupFolderName(this.devices().find((d) => d.deviceId === e.from)?.alias ?? e.from.slice(0, 8));
      const files: string[] = [];
      for (const f of e.files) {
        try {
          const dir = await ensureDir(this.backupDir, [alias]);
          files.push(await land(f, dir, basename(f)));
        } catch {
          files.push(f); // stays in the inbox
        }
      }
      this.emitEvent({ source: 'receiver', ...e, files, backup: true });
      return;
    }
    this.emitEvent({ source: 'receiver', ...e });
  }

  /** Whether new offers are accepted (false: paused, offers get 503 and stay with their senders). */
  get receiving(): boolean {
    return this.accepting;
  }

  /** Pauses or resumes receiving. The server, discovery and the hub link keep running. */
  setReceiving(on: boolean): void {
    this.accepting = on;
  }

  /** Starts the link to the hub (the hub device links to itself over loopback, to send and receive relayed). */
  private startClient(): void {
    const r = this.running;
    if (!r || r.client || !this.mesh || !r.server) return;
    const { sync: _lanOnly, ...relayOpts } = this.receiverOptions(); // folder sync never goes through the hub
    const handler = createMeshHandler(relayOpts);
    const port = r.port;
    const isHub = r.hub !== null;
    const client = new HubClient({
      id: this.identity, members: this.mesh, handler: (q) => handler.handle(q),
      lanAddrs: () => this.lanAddrs(port),
      hubLan: () => {
        if (isHub) return { host: '127.0.0.1', port };
        const hubId = this.mesh?.list().hub.deviceId;
        const p = r.discovery.peers().find((x) => x.deviceId === hubId);
        if (p) return { host: p.host, port: p.port };
        // Not announced (multicast off or blocked): the address we last reached the hub at.
        const saved = this.readHubAddr();
        return saved && saved.deviceId === hubId ? { host: saved.host, port: saved.port } : undefined;
      },
      ...(this.opts.hubBackoffMs ? { backoffMs: this.opts.hubBackoffMs } : {}),
      relays: () => this.relayList()?.relays ?? [],
      ...(this.opts.hubFailbackMs !== undefined ? { failbackMs: this.opts.hubFailbackMs } : {}),
      ...(this.opts.hubDrainMs !== undefined ? { drainMs: this.opts.hubDrainMs } : {}),
    });
    const mesh = (type: Extract<EngineEvent, { source: 'mesh' }>['type'], extra: Record<string, unknown> = {}) =>
      this.emitEvent({ source: 'mesh', type, ...extra } as EngineEvent);
    client.on('online', () => {
      mesh('online');
      this.lastInviteSecret = ''; // re-register the current invite with the (possibly new) hub
      this.syncInvite();
    });
    client.on('offline', () => mesh('offline'));
    client.on('membership', (sm: SignedMembership) => {
      mesh('membership', { version: sm.list.version });
      r.relayHub?.setMembership(sm); // a relay hub hands the main hub's lists on to its own links
    });
    client.on('relays', (s: unknown) => this.onRelays(s));
    client.on('directory', (devs: DirectoryEntry[]) => {
      mesh('directory');
      for (const d of devs ?? []) if (d.online) void this.maybeAutoResume(d.deviceId);
    });
    client.on('revoked', () => void this.leaveMesh());
    client.on('invite-used', () => {
      this.invites.markUsed(this.identity.deviceId);
      this.markInviteUsed();
    });
    for (const t of ['held-delivered', 'held-failed'] as const) {
      client.on(t, (n: Record<string, unknown>) => {
        const extra: Record<string, unknown> = {};
        for (const k of ['to', 'sessionId', 'files', 'status', 'error']) if (n[k] !== undefined) extra[k] = n[k];
        mesh(t, extra);
      });
    }
    r.client = client;
    client.start();
  }

  /** This device was revoked: drop the mesh state (the identity stays) and tell the app once. */
  private async leaveMesh(): Promise<void> {
    if (!this.mesh) return;
    const client = this.running?.client;
    if (this.running) this.running.client = null;
    await client?.stop();
    this.mesh = null;
    rmSync(join(this.home, 'mesh'), { recursive: true, force: true });
    this.emitEvent({ source: 'mesh', type: 'revoked' });
  }

  /** While the hub is unreachable, a peer with a newer list version shares it over the LAN. */
  private async maybePull(p: PeerInfo): Promise<void> {
    if (!this.running?.server) return; // a client next to a listener leaves the list to it
    const mesh = this.mesh;
    // Any LAN peer may hand us a newer list (e.g. a hub recovered under a new id): it only counts
    // if it verifies against our anchor.
    if (!mesh || this.hubOnline()) return;
    const last = this.lastPull.get(p.deviceId) ?? 0;
    if (Date.now() - last < PULL_INTERVAL_MS) return;
    this.lastPull.set(p.deviceId, Date.now());
    try {
      if ((await pullMembership(this.identity, mesh, p)) === 'updated') {
        this.emitEvent({ source: 'mesh', type: 'membership', version: mesh.list().version });
        if (mesh.isRevoked(this.identity.deviceId)) await this.leaveMesh();
      }
    } catch {
      /* a peer with a bad or foreign list is ignored */
    }
  }

  private readInvite(): { secret: string; expiresAt: number; used: boolean; uses: number } | null {
    try {
      const j = JSON.parse(readFileSync(join(this.home, 'invite.json'), 'utf8')) as Record<string, unknown>;
      if (typeof j.secret !== 'string' || typeof j.expiresAt !== 'number') return null;
      return { secret: j.secret, expiresAt: j.expiresAt, used: j.used === true, uses: typeof j.uses === 'number' ? j.uses : 1 };
    } catch {
      return null;
    }
  }

  /** The invite in invite.json was redeemed: it must never be registered again (restart, relink). */
  private markInviteUsed(): void {
    const cur = this.readInvite();
    // A group invite counts its uses in the invite book; one redemption does not end it.
    if (cur && !cur.used && cur.uses <= 1) writeFileAtomic(join(this.home, 'invite.json'), JSON.stringify({ ...cur, used: true }));
  }

  /**
   * Picks up an invite written by another process on this home (`meshdrop invite`) and registers it
   * here and with the hub, with its remaining lifetime. A used or expired invite is never registered.
   */
  private syncInvite(): void {
    if (!this.mesh) return;
    const j = this.readInvite();
    if (!j || j.used || Date.now() >= j.expiresAt || j.secret === this.lastInviteSecret) return;
    const secret = Buffer.from(j.secret, 'base64url');
    if (secret.length !== 16) return;
    this.lastInviteSecret = j.secret;
    const invite: Invite = { secret, inviter: this.identity.deviceId, mesh: this.mesh.list().mesh, lan: [], hubUrls: [], expiresAt: j.expiresAt };
    this.invites.register(invite, j.expiresAt - Date.now(), j.uses);
    this.running?.client?.registerInvite(invite, j.uses);
  }

  /** A `meshdrop join` run by another process on this home: load the new mesh and link to the hub. */
  private async pickUpMesh(): Promise<void> {
    if (this.mesh || !existsSync(join(this.home, 'mesh', 'membership.json'))) return;
    try {
      this.mesh = await MembershipStore.load(this.home);
      if (this.mesh) {
        this.emitEvent({ source: 'mesh', type: 'joined', version: this.mesh.list().version });
        this.startClient();
      }
    } catch {
      /* half-written: next poll */
    }
  }

  /**
   * Hub administration requested by another process on this home while this one runs the hub
   * (`meshdrop hub revoke`): <home>/hub/requests/<id>.json → <id>.done.json.
   */
  private async applyHubRequests(): Promise<void> {
    if (!this.running?.hub) return;
    const dir = join(this.home, 'hub', 'requests');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const m = /^([A-Za-z0-9_-]{8,32})\.json$/.exec(n);
      if (!m) continue;
      const file = join(dir, n);
      let result: Record<string, unknown>;
      try {
        const req = JSON.parse(readFileSync(file, 'utf8')) as { op?: unknown; prefix?: unknown; relays?: unknown };
        if (req.op === 'relays' && Array.isArray(req.relays)) {
          const rs = await this.relaysSet(this.resolveRelays(req.relays));
          result = { ok: true, relays: rs.length };
        } else {
          if (req.op !== 'revoke' || typeof req.prefix !== 'string') throw new Error('bad request');
          const sm = await this.revoke(req.prefix);
          result = { ok: true, version: sm.list.version };
        }
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      rmSync(file, { force: true });
      writeFileAtomic(join(dir, `${m[1]}.done.json`), JSON.stringify(result));
    }
  }

  private async finishPendingJoin(): Promise<void> {
    if (this.mesh || !existsSync(join(this.home, 'mesh-pending.json'))) return;
    try {
      this.mesh = await completeJoin(this.identity, this.home);
      this.emitEvent({ source: 'mesh', type: 'joined', version: this.mesh.list().version });
      this.startClient();
    } catch {
      /* not signed in yet: retried */
    }
  }

  /** Makes this device the hub of a new mesh (root key + list v1). Call before start(). */
  /** Hub URLs must be wss:// (CA-validated); ws:// to this machine only when allowed (tests, local tunnels). */
  private checkHubUrls(urls: string[]): void {
    for (const u of urls) {
      let p: URL;
      try {
        p = new URL(u);
      } catch {
        throw new Error(`invalid hub URL ${JSON.stringify(u)}: expected wss://…`);
      }
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname);
      if (p.protocol === 'wss:' && u.length <= 512) continue;
      if (p.protocol === 'ws:' && loopback && this.opts.allowLoopbackHubUrls) continue;
      throw new Error(`invalid hub URL ${JSON.stringify(u)}: expected wss://…`);
    }
  }

  async hubInit(urls: string[]): Promise<SignedMembership> {
    this.checkHubUrls(urls);
    if (this.running) throw new Error('hub init: stop the engine first');
    if (this.mesh || (await hasRootKey(this.home))) throw new Error('hub init: this device is already in a mesh');
    const rootKey = await loadOrCreateRootKey(this.home);
    const anchor = createPublicKey(rootKey);
    const list: MembershipList = {
      v: 1, mesh: spkiSha256(anchor), version: 1, issuedAt: Date.now(),
      hub: { deviceId: this.identity.deviceId, urls: [...urls] },
      members: [{ deviceId: this.identity.deviceId, alias: this.alias, publicKeyPem: this.identity.publicKey.export({ type: 'spki', format: 'pem' }) as string, role: 'hub', addedAt: Date.now() }],
      revoked: [],
    };
    const s = signList(list, rootKey);
    this.mesh = await MembershipStore.init(this.home, anchor, s);
    this.rootKey = rootKey;
    return s;
  }

  private requireHub(): HubServer {
    const hub = this.running?.hub;
    if (!hub) throw new Error('this device is not a running hub');
    return hub;
  }

  /** Hub only: the public wss:// URLs devices use to reach the hub from outside the LAN. */
  async setHubUrls(urls: string[]): Promise<SignedMembership> {
    this.checkHubUrls(urls);
    return this.requireHub().setUrls(urls);
  }

  /** The hub's loopback ingress port (for tunnels), 0 if this is not a running hub. */
  get hubIngressPort(): number {
    return this.running?.ingressPort ?? 0;
  }

  /** The hub's device directory (who is online, last-known LAN addresses). */
  hubDirectory(): DirectoryEntry[] {
    return this.directory();
  }

  /**
   * A QR invite: single use for 5 min, or with `group` one QR for up to INVITE_GROUP_USES devices
   * for 15 min. Also written to invite.json so a running `listen` honours it.
   */
  createInvite(opts: { group?: boolean } = {}): { invite: Invite; uri: string } {
    if (!this.mesh) throw new Error('invite: this device is not in a mesh (run `meshdrop hub init` or join one)');
    const list = this.mesh.list();
    const uses = opts.group ? INVITE_GROUP_USES : 1;
    const invite = this.invites.create(this.identity.deviceId, list.mesh, this.lanAddrs(this.port), list.hub.urls, uses);
    const secret = invite.secret.toString('base64url');
    writeFileAtomic(join(this.home, 'invite.json'), JSON.stringify({ secret, expiresAt: invite.expiresAt, used: false, uses }));
    this.lastInviteSecret = secret;
    this.running?.client?.registerInvite(invite, uses);
    return { invite, uri: inviteUri(invite) };
  }

  // ---- folder sync (M8a, LAN only) ---------------------------------------------------------------

  private readonly syncStore: SyncStore;
  /** One watcher per folder (by name), and one debounce per folder. */
  private readonly syncWatchers = new Map<string, FSWatcher>();
  private readonly syncDebounces = new Map<string, NodeJS.Timeout>();
  /** Rounds by `${name}\0${partner}`: one at a time; a request during one runs one more after it. */
  private readonly syncRuns = new Map<string, Promise<void>>();
  private readonly syncAgain = new Set<string>();
  private readonly syncLast = new Map<string, SyncPartnerStatus['last']>();

  syncConfig(): SyncConfig {
    return this.syncStore.config();
  }

  /**
   * Adds or changes a synced folder. `name` matches it with the partners' folders (default: the
   * folder's own name); `previousName` renames an existing entry. The folder is created if needed;
   * it may not be /, the home folder, overlap the inbox, or overlap another synced folder.
   */
  syncPut(c: { name?: string; folder: string; partners: string[] }, previousName?: string): SyncFolderConfig {
    if (!isAbsolute(c.folder.trim())) throw new Error('Choose a folder (a full path).');
    const folder = resolve(c.folder.trim());
    if (folder === sep || folder === resolve(homedir())) throw new Error('Choose a dedicated folder for syncing, not your home folder.');
    const overlaps = (x: string) => folder === x || folder.startsWith(x + sep) || x.startsWith(folder + sep);
    if (overlaps(resolve(this.inboxDir))) throw new Error('The sync folder must be separate from the folder received files go to.');
    const name = (c.name ?? defaultSyncName(folder)).trim();
    if (!validSyncName(name)) throw new Error('A sync name is 1–64 characters, without "/".');
    const cfg = this.syncStore.config();
    const others = cfg.folders.filter((f) => f.name !== (previousName ?? name));
    if (others.some((f) => f.name === name)) throw new Error(`Another synced folder is already called "${name}".`);
    if (others.some((f) => overlaps(resolve(f.folder)))) throw new Error('That folder is inside (or holds) another synced folder.');
    if (others.length >= MAX_SYNC_FOLDERS) throw new Error(`At most ${MAX_SYNC_FOLDERS} synced folders.`);
    mkdirSync(folder, { recursive: true });
    const partners = [...new Set(c.partners.map((q) => this.resolveDeviceId(q)))];
    const entry: SyncFolderConfig = { name, folder, partners };
    const at = cfg.folders.findIndex((f) => f.name === (previousName ?? name));
    const folders = [...cfg.folders];
    if (at >= 0) folders[at] = entry;
    else folders.push(entry);
    this.syncStore.setConfig({ folders });
    if (previousName !== undefined && previousName !== name) this.syncStore.forget(previousName);
    this.restartSyncWatch();
    for (const p of partners) this.scheduleSync(name, p, 500);
    return entry;
  }

  /** Stops syncing a folder (its files stay where they are). */
  syncRemove(name: string): void {
    const cfg = this.syncStore.config();
    this.syncStore.setConfig({ folders: cfg.folders.filter((f) => f.name !== name) });
    this.syncStore.forget(name);
    this.restartSyncWatch();
  }

  /** Each folder, and per partner whether it is on the LAN now and how its last round went. */
  syncStatus(): { folders: { name: string; folder: string; partners: SyncPartnerStatus[] }[] } {
    const present = new Set(this.running?.discovery.peers().map((p) => p.deviceId) ?? []);
    const devs = this.devices();
    return {
      folders: this.syncStore.config().folders.map((f) => ({
        name: f.name,
        folder: f.folder,
        partners: f.partners.map((id) => {
          const key = `${f.name}\0${id}`;
          const last = this.syncLast.get(key);
          const alias = devs.find((d) => d.deviceId === id)?.alias;
          return { deviceId: id, ...(alias !== undefined ? { alias } : {}), present: present.has(id), syncing: this.syncRuns.has(key), ...(last ? { last } : {}) };
        }),
      })),
    };
  }

  /** Runs a round now with every partner on the LAN, for one folder or all of them. */
  async syncNow(name?: string): Promise<void> {
    const r = this.requireRunning();
    const present = new Set(r.discovery.peers().map((p) => p.deviceId));
    const jobs: Promise<void>[] = [];
    for (const f of this.syncStore.config().folders) {
      if (name !== undefined && f.name !== name) continue;
      for (const p of f.partners) if (present.has(p)) jobs.push(this.runSync(f.name, p));
    }
    await Promise.all(jobs);
  }

  private syncPresent(): void {
    const present = new Set(this.running?.discovery.peers().map((p) => p.deviceId) ?? []);
    for (const f of this.syncStore.config().folders) for (const p of f.partners) if (present.has(p)) void this.runSync(f.name, p);
  }

  /** Schedules rounds with `partner`: for folder `name`, or (undefined) every folder shared with it. */
  private scheduleSync(name: string | undefined, partner: string, delayMs: number): void {
    const t = setTimeout(() => {
      for (const f of this.syncStore.config().folders) {
        if ((name === undefined || f.name === name) && f.partners.includes(partner)) void this.runSync(f.name, partner);
      }
    }, delayMs);
    t.unref();
  }

  private runSync(name: string, partner: string): Promise<void> {
    const key = `${name}\0${partner}`;
    const cur = this.syncRuns.get(key);
    if (cur) {
      this.syncAgain.add(key);
      return cur;
    }
    const p = (async () => {
      do {
        this.syncAgain.delete(key);
        await this.syncOnce(name, partner);
      } while (this.syncAgain.has(key) && this.running);
    })().finally(() => this.syncRuns.delete(key));
    this.syncRuns.set(key, p);
    return this.track(p);
  }

  private async syncOnce(name: string, partner: string): Promise<void> {
    const r = this.running;
    const f = this.syncStore.config().folders.find((x) => x.name === name);
    if (!r || !r.server || !f || !f.partners.includes(partner) || !this.trustSource.isTrusted(partner)) return;
    const peer = r.discovery.peers().find((p) => p.deviceId === partner);
    if (!peer) return; // LAN only
    const alias = this.devices().find((d) => d.deviceId === partner)?.alias ?? partner.slice(0, 8);
    const key = `${name}\0${partner}`;
    try {
      const res = await syncRound({
        folder: f.folder, name, store: this.syncStore, self: this.identity.deviceId, partner, partnerAlias: alias, signal: r.abort.signal,
        transport: new LanTransport(this.identity, { deviceId: partner, host: peer.host, port: peer.port }),
      });
      this.syncLast.set(key, { at: Date.now(), pulled: res.pulled, deleted: res.deleted, conflicts: res.conflicts, errors: res.errors.length });
      this.emitEvent({ source: 'sync', type: 'round', folder: name, partner, pulled: res.pulled, deleted: res.deleted, conflicts: res.conflicts, errors: res.errors.length });
    } catch (e) {
      if (r.abort.signal.aborted) return;
      const error = e instanceof Error ? e.message : String(e);
      this.syncLast.set(key, { at: Date.now(), pulled: 0, deleted: 0, conflicts: 0, errors: 0, error });
      this.emitEvent({ source: 'sync', type: 'error', folder: name, partner, error });
    }
  }

  /** Watches each folder: a local change pokes its partners (they pull), 2 s after the last change. */
  private restartSyncWatch(): void {
    for (const w of this.syncWatchers.values()) w.close();
    this.syncWatchers.clear();
    for (const t of this.syncDebounces.values()) clearTimeout(t);
    this.syncDebounces.clear();
    const r = this.running;
    if (!r || !r.server) return;
    for (const f of this.syncStore.config().folders) {
      try {
        const w = watch(f.folder, { recursive: true }, (_ev, file) => {
          if (file && syncIgnored(String(file).split(sep).join('/'))) return;
          const old = this.syncDebounces.get(f.name);
          if (old) clearTimeout(old);
          const t = setTimeout(() => void this.pokePartners(f.name), SYNC_DEBOUNCE_MS);
          t.unref();
          this.syncDebounces.set(f.name, t);
        });
        w.on('error', () => {});
        this.syncWatchers.set(f.name, w);
      } catch {
        // not watchable here: the timer still syncs every minute
      }
    }
  }

  private async pokePartners(name: string): Promise<void> {
    const r = this.running;
    const f = this.syncStore.config().folders.find((x) => x.name === name);
    if (!r || !f) return;
    for (const p of r.discovery.peers()) {
      if (!f.partners.includes(p.deviceId)) continue;
      await new LanTransport(this.identity, { deviceId: p.deviceId, host: p.host, port: p.port })
        .request('POST', `/mesh/v1/sync/poke?${new URLSearchParams({ f: name })}`, undefined, {}, { timeoutMs: 10_000 })
        .catch(() => {});
    }
  }

  // ---- LAN guests (M5a) -------------------------------------------------------------------------

  /**
   * Opens a guest session (ending any earlier one): a one-time link for a browser on the LAN, shown as
   * a QR code. The guest can send to this device (after guestAccept) and download what guestShare offers.
   */
  /** `ttlMs` overrides `minutes` (tests and embedders; at least 100 ms). */
  async guestStart(opts: { minutes?: number; ttlMs?: number } = {}): Promise<{ url: string; qrSvg: string; expiresAt: number }> {
    const r = this.requireRunning();
    if (!r.guest) throw new Error(`guest sessions are not available: port ${(this.opts.guest && this.opts.guest.port) ?? DEFAULT_GUEST_PORT} is in use`);
    await this.endGuest(false);
    const minutes = Math.min(MAX_GUEST_MINUTES, Math.max(MIN_GUEST_MINUTES, Math.round(opts.minutes ?? DEFAULT_GUEST_MINUTES)));
    const ttl = opts.ttlMs !== undefined ? Math.max(100, opts.ttlMs) : minutes * 60_000;
    const { token, expiresAt } = this.guestBook.open(ttl);
    // At the end of its time the session ends for real: unfinished uploads are deleted now, not later.
    this.guestTimer = setTimeout(() => void this.endGuest(true), ttl);
    this.guestTimer.unref();
    this.guestUploads = new GuestUploads(join(this.home, 'guest-partial'), this.inboxDir, (ev) => this.onGuest(ev));
    const host = this.lanAddrs(r.port)[0]?.host ?? '127.0.0.1';
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${r.guestPort}/g/${token}`;
    this.guestUrl = url;
    return { url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1 }), expiresAt };
  }

  // ---- M12 watch party ----------------------------------------------------------------------

  /** Watch-party rooms on this device (served on the LAN guest server and, on a hub, the internet ingress). */
  private watchRooms: WatchRooms | null = null;
  get watch(): WatchRooms {
    this.watchRooms ??= new WatchRooms(join(this.home, 'watch'));
    return this.watchRooms;
  }
  private readonly watchHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): boolean => {
    this.watchRouter ??= createWatchHandler({ rooms: this.watch, page: WATCH_PAGE });
    return this.watchRouter(req, res);
  };
  private watchRouter: ReturnType<typeof createWatchHandler> | null = null;

  /** The hub's internet ingress: watch parties, then internet links. */
  private ingressHandler(): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean {
    const links = createLinkHandler({ store: this.links(), uploads: (id) => this.linkUploads(id), page: LINK_PAGE });
    return (req, res) => this.watchHandler(req, res) || links(req, res);
  }

  /** Where people open a room: the hub's internet address (if it has one), then this PC on the LAN. */
  watchLinks(code: string): string[] {
    const r = this.running;
    const out: string[] = [];
    if (r?.hub || r?.relayHub) {
      const base = this.servedLinkBase();
      if (!/^http:\/\/127\.0\.0\.1/.test(base)) out.push(`${base}/w/${code}`);
    }
    if (r?.guest) {
      const host = this.lanAddrs(r.port)[0]?.host ?? '127.0.0.1';
      out.push(`http://${host.includes(':') ? `[${host}]` : host}:${r.guestPort}/w/${code}`);
    }
    return out;
  }

  /** Opens a watch party here; the host key opens it as host (the creator's link carries it in #h=). */
  watchCreate(name: string): { code: string; hostToken: string; links: string[] } {
    const r = this.requireRunning();
    if (!r.guest && !r.hub && !r.relayHub) throw new Error('Watch parties need the MeshDrop PC (its guest port is in use).');
    this.watch.start();
    const room = this.watch.create(name);
    return { code: room.code, hostToken: room.hostToken, links: this.watchLinks(room.code) };
  }

  watchList(): { code: string; name: string; people: number; playing?: string; links: string[] }[] {
    return this.watch.list().map((w) => {
      const v = w.view();
      return { code: w.code, name: w.name, people: v.members.length, ...(v.state.source ? { playing: v.state.source.title } : {}), links: this.watchLinks(w.code) };
    });
  }

  async watchEnd(code: string): Promise<void> {
    await this.watch.end(code);
  }

  /** The host PC plays one of its own files in the room (no copy: it is read where it is). */
  async watchPlayLocal(code: string, path: string): Promise<void> {
    const room = this.watch.get(code);
    if (!room) throw new WatchError(404, 'no-such-room');
    const st = await lstat(path);
    if (!st.isFile()) throw new Error('Pick a video file.');
    const id = randomBytes(9).toString('base64url');
    room.media.set(id, { path, name: basename(path), size: st.size, owned: false });
    room.playMedia(id, '');
  }

  // ---- M11 room mode ------------------------------------------------------------------------

  private room: Room | null = null;
  private roomUrl: string | null = null;
  private roomTimer: NodeJS.Timeout | null = null;

  /** Opens a room: one QR for everyone on this Wi-Fi to share photos and files on one board. */
  async roomStart(opts: { minutes?: number; title?: string } = {}): Promise<{ url: string; qrSvg: string; expiresAt: number }> {
    const r = this.requireRunning();
    if (!r.guest) throw new Error(`rooms are not available: port ${(this.opts.guest && this.opts.guest.port) ?? DEFAULT_GUEST_PORT} is in use`);
    await this.roomEnd();
    const minutes = Math.min(24 * 60, Math.max(5, Math.round(opts.minutes ?? 180)));
    const title = (opts.title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) || `${this.alias}'s room`;
    this.room = await Room.open(join(this.home, 'room'), title, minutes * 60_000, () => this.emitEvent({ source: 'guest', type: 'room' }));
    this.roomTimer = setTimeout(() => void this.roomEnd(), minutes * 60_000);
    this.roomTimer.unref();
    const host = this.lanAddrs(r.port)[0]?.host ?? '127.0.0.1';
    this.roomUrl = `http://${host.includes(':') ? `[${host}]` : host}:${r.guestPort}/r/${this.room.token}`;
    return { url: this.roomUrl, qrSvg: await QRCode.toString(this.roomUrl, { type: 'svg', margin: 1 }), expiresAt: this.room.expiresAt };
  }

  /** Ends the room: the link stops and everything posted in it is deleted (saved copies stay). */
  async roomEnd(): Promise<void> {
    if (this.roomTimer) clearTimeout(this.roomTimer);
    this.roomTimer = null;
    const room = this.room;
    this.room = null;
    this.roomUrl = null;
    await room?.close();
  }

  roomState(): { active: boolean; url?: string; title?: string; expiresAt?: number; posts: RoomPost[] } {
    const room = this.room;
    if (!room?.live) return { active: false, posts: [] };
    return { active: true, url: this.roomUrl!, title: room.title, expiresAt: room.expiresAt, posts: room.posts() };
  }

  /** The host posts one of its own files to the room. */
  async roomPost(path: string): Promise<void> {
    const room = this.room;
    if (!room?.live) throw new Error('No room is open.');
    const st = await lstat(path);
    if (!st.isFile()) throw new Error('Only files can be posted.');
    await room.add(basename(path), this.alias, createReadStream(path), st.size);
  }

  /** Copies a post into the inbox (free name, never over a file); returns where it went. */
  async roomSave(id: string): Promise<string> {
    const room = this.room;
    const src = room?.pathOf(id);
    const post = room?.posts().find((p) => p.id === id);
    if (!src || !post) throw new Error('That post is gone.');
    const dir = await ensureDir(this.inboxDir, []);
    const tmp = join(dir, `.room-${id}.part`);
    await copyFile(src, tmp);
    return land(tmp, dir, post.name);
  }

  /** Ends the guest session: the link stops working, unfinished uploads are deleted, shares are cleared. */
  guestEnd(): Promise<void> {
    return this.endGuest(true);
  }

  private async endGuest(announce: boolean): Promise<void> {
    if (this.guestTimer) clearTimeout(this.guestTimer);
    this.guestTimer = null;
    const had = this.guestBook.current() !== null || this.guestUploads !== null;
    this.guestBook.end();
    const u = this.guestUploads;
    this.guestUploads = null;
    this.guestShared = [];
    this.guestUrl = null;
    await u?.cancelAll();
    if (announce && had) this.emitEvent({ source: 'guest', type: 'ended' });
  }

  private onGuest(ev: GuestEvent, link?: string): void {
    switch (ev.type) {
      case 'guest-offer': {
        const ask = () => this.emitEvent({ source: 'guest', type: 'offer', id: ev.id, files: ev.files, ...(ev.text !== undefined ? { text: ev.text } : {}), ...(link ? { via: 'link' as const, link } : {}) });
        if (!link) ask();
        // a drop-box link was accepted beforehand: no question, the files just land
        else void this.links().autoAccepts(link).then((yes) => (yes ? this.guestAccept(ev.id) : ask())).catch(ask);
        break;
      }
      case 'guest-received':
        this.emitEvent({ source: 'guest', type: 'received', id: ev.id, files: ev.files, ...(ev.text !== undefined ? { text: ev.text } : {}) });
        break;
      case 'guest-file':
        this.emitEvent({ source: 'guest', type: 'file', id: ev.id, path: ev.path });
        break;
      case 'guest-rejected':
        this.emitEvent({ source: 'guest', type: 'rejected', id: ev.id });
        break;
      case 'guest-failed':
        this.emitEvent({ source: 'guest', type: 'failed', id: ev.id, error: ev.error });
        break;
    }
  }

  /** Offers files (regular files only) to the guest; returns the new entries. */
  async guestShare(paths: string[]): Promise<{ id: string; name: string; size: number }[]> {
    if (!this.guestBook.current()) throw new Error('no guest session: start one first');
    const added: SharedFile[] = [];
    for (const p of paths) {
      const st = statSync(p);
      if (!st.isFile()) throw new Error(`not a file: ${p}`);
      added.push({ id: randomBytes(9).toString('base64url'), name: basename(p), size: st.size, path: p });
    }
    this.guestShared = [...this.guestShared, ...added];
    return added.map(({ id, name, size }) => ({ id, name, size }));
  }

  guestUnshare(id: string): void {
    this.guestShared = this.guestShared.filter((f) => f.id !== id);
  }

  /** The upload store an offer id belongs to: the LAN guest session or one of the links. */
  // ---- LocalSend v2 interop (M6) ------------------------------------------------------------------

  private lsReceiver: LocalSendReceiver | null = null;
  private lsPort = 0;

  private lsSelf(): LsInfo {
    return { alias: this.alias, version: '2.0', deviceModel: 'MeshDrop', deviceType: this.deviceType === 'mobile' ? 'mobile' : this.deviceType === 'headless' ? 'headless' : 'desktop', fingerprint: this.identity.deviceId, port: this.lsPort || LS_PORT, protocol: 'https', download: false };
  }

  private onLocalSend(e: LsEvent): void {
    if (e.type === 'register') {
      const host = e.address.replace(/^::ffff:/, '');
      const port = Number.isInteger(e.info.port) ? e.info.port! : LS_PORT;
      this.running?.ls?.discovery?.seen({ alias: e.info.alias, fingerprint: e.info.fingerprint, host, port, protocol: e.info.protocol === 'http' ? 'http' : 'https', lastSeen: Date.now(), ...(e.info.deviceModel ? { deviceModel: e.info.deviceModel } : {}), ...(e.info.deviceType ? { deviceType: e.info.deviceType } : {}) });
    } else if (e.type === 'offer') {
      this.emitEvent({ source: 'guest', type: 'offer', id: e.id, files: e.files, via: 'localsend', alias: e.from.alias, ...(e.text !== undefined ? { text: e.text } : {}) });
    } else if (e.type === 'received') {
      this.emitEvent({ source: 'guest', type: 'received', id: e.id, files: e.files, via: 'localsend', alias: e.from.alias, ...(e.text !== undefined ? { text: e.text } : {}) });
    } else {
      this.emitEvent({ source: 'guest', type: 'rejected', id: e.id });
    }
  }

  /** LocalSend apps seen on the LAN. */
  localsendPeers(): LsPeerInfo[] {
    return this.running?.ls?.discovery?.peers() ?? [];
  }

  /** Sends files and/or a message to a LocalSend app on the LAN (it asks its user first). */
  async localsendSend(fingerprint: string, items: { paths: string[]; text?: string }, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const p = this.running?.ls?.discovery?.peer(fingerprint);
    if (!p) throw new Error('that LocalSend device is not on this network right now');
    await lsSend(p, this.lsSelf(), items, onProgress ? { onProgress } : {});
  }

  private uploadsOf(id: string): GuestUploads | LocalSendReceiver {
    if (this.lsReceiver?.has(id)) return this.lsReceiver;
    if (this.guestUploads?.has(id)) return this.guestUploads;
    for (const u of this.linkUploadMap.values()) if (u.has(id)) return u;
    throw new Error('no such guest offer');
  }

  async guestAccept(id: string): Promise<void> {
    await this.uploadsOf(id).accept(id);
  }

  async guestReject(id: string): Promise<void> {
    await this.uploadsOf(id).reject(id);
  }

  guestState(): GuestState {
    const cur = this.guestBook.current();
    const viaLinks = [
      ...[...this.linkUploadMap.values()].flatMap((u) => u.pending().map((o) => ({ ...o, via: 'link' as const }))),
      ...(this.lsReceiver?.pending() ?? []).map((o) => ({ ...o, via: 'localsend' as const })),
    ];
    if (!cur || !this.guestUploads) return { active: false, available: !!this.running?.guest, shared: [], offers: viaLinks };
    return {
      active: true,
      available: true,
      url: this.guestUrl ?? '',
      expiresAt: cur.expiresAt,
      claimed: cur.claimed,
      shared: this.guestShared.map(({ id, name, size }) => ({ id, name, size })),
      offers: [...this.guestUploads.pending(), ...viaLinks],
    };
  }

  // ---- internet guest links (M5b, hub only) ------------------------------------------------------

  private reach: ReachManager | null = null;

  /** Hub only: how this hub is reached from the internet. */
  reachStatus(): (ReachStatus & { detection: ReturnType<ReachManager['lastDetection']> }) | null {
    return this.reach ? { ...this.reach.status(), detection: this.reach.lastDetection() } : null;
  }

  reachConfig(): ReachConfig {
    return this.reach?.config ?? { mode: 'off' };
  }

  reachDetect(): Promise<ReturnType<ReachManager['lastDetection']>> {
    if (!this.reach) throw new Error('internet access is set up on the running hub');
    return this.reach.detect();
  }

  reachSet(cfg: ReachConfig, secrets: { duckdnsToken?: string } = {}): Promise<ReachStatus> {
    if (!this.reach) throw new Error('internet access is set up on the running hub');
    return this.reach.set(cfg, secrets);
  }

  private linkStore: LinkStore | null = null;
  private readonly linkUploadMap = new Map<string, GuestUploads>();

  private links(): LinkStore {
    this.linkStore ??= new LinkStore(join(this.home, 'hub', 'links'), this.opts.linkQuotaBytes !== undefined ? { quotaBytes: this.opts.linkQuotaBytes } : {});
    return this.linkStore;
  }

  private linkUploads(id: string): GuestUploads {
    let u = this.linkUploadMap.get(id);
    if (!u) {
      u = new GuestUploads(join(this.home, 'link-partial', id), this.inboxDir, (ev) => this.onGuest(ev, id));
      this.linkUploadMap.set(id, u);
    }
    return u;
  }

  /** The public base of the hub (its first URL as https://host), or its loopback ingress. */
  private linkBase(): string {
    const u = this.mesh?.list().hub.urls[0];
    if (u) {
      const p = new URL(u);
      return `${p.protocol === 'wss:' ? 'https:' : 'http:'}//${p.host}`;
    }
    return `http://127.0.0.1:${this.running?.ingressPort || DEFAULT_INGRESS_PORT}`;
  }

  /** Hub only: seals files (and/or a message) into a new internet guest link and returns its full URL. */
  async linkCreate(c: { files: string[]; text?: string; days?: number; hours?: number; password?: string; maxDownloads?: number; allowUploads?: boolean; autoAccept?: boolean }): Promise<{ id: string; url: string; qrSvg: string; expiresAt: number }> {
    if (!this.rootKey) return this.memberLinkCreate(c);
    const expiresInMs = c.hours !== undefined ? c.hours * 3_600_000 : (c.days ?? 7) * 24 * 3_600_000;
    const { id, key, expiresAt } = await this.links().create({
      files: c.files, expiresInMs, allowUploads: c.allowUploads === true, autoAccept: c.autoAccept === true,
      ...(c.text ? { text: c.text } : {}), ...(c.password ? { password: c.password } : {}),
      ...(c.maxDownloads !== undefined ? { maxDownloads: c.maxDownloads } : {}),
    });
    const url = `${this.linkBase()}/l/${id}#k=${key.toString('base64url')}`;
    writeFileAtomic(join(this.home, 'hub', 'links', id, 'owner-url'), url);
    return { id, url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1 }), expiresAt };
  }

  // ---- internet links made on a member (M9b) ----

  /** A request to the hub this device is linked to (the main hub, or a relay hub while it is away). */
  private async hubCall(method: string, path: string, body?: Buffer, contentType?: string): Promise<{ status: number; json?: unknown }> {
    const client = this.running?.client;
    const hubId = client?.linkedHub;
    if (!client || !hubId) throw new Error('Not connected to a hub: internet links need the hub PC or a relay hub.');
    const pubOf = (id: string): KeyObject | undefined => {
      const t = this.mesh?.get(id);
      return t ? createPublicKey(t.publicKeyPem) : undefined;
    };
    const t = new RelayTransport(this.identity, client, hubId, pubOf, 'relay');
    const r = await t.request(method, path, body, contentType ? { 'content-type': contentType } : {}, { timeoutMs: 120_000 });
    return { status: r.status, ...(r.json !== undefined ? { json: r.json } : {}) };
  }

  private memberLinksFile(): string {
    return join(this.home, 'member-links.json');
  }

  private memberLinkUrls(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.memberLinksFile(), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** A member seals the link here (the key never leaves this device) and uploads only ciphertext to its hub. */
  private async memberLinkCreate(c: { files: string[]; text?: string; days?: number; hours?: number; password?: string; maxDownloads?: number }): Promise<{ id: string; url: string; qrSvg: string; expiresAt: number }> {
    if (!this.mesh) throw new Error('Internet links need a mesh with a hub.');
    const expiresInMs = c.hours !== undefined ? c.hours * 3_600_000 : (c.days ?? 7) * 24 * 3_600_000;
    const dir = join(this.home, 'link-outbox');
    rmSync(dir, { recursive: true, force: true });
    const local = new LinkStore(dir, { quotaBytes: Number.MAX_SAFE_INTEGER });
    try {
      const { id, key } = await local.create({
        files: c.files, expiresInMs, ...(c.text ? { text: c.text } : {}), ...(c.password ? { password: c.password } : {}),
        ...(c.maxDownloads !== undefined ? { maxDownloads: c.maxDownloads } : {}),
      });
      const m = await local.rawMeta(id);
      const begin = await this.hubCall('POST', '/mesh/v1/links', Buffer.from(JSON.stringify({
        id, keyHash: m.keyHash, label: m.label, expiresInMs, files: m.files, manifest: m.manifest.toString('base64'),
        ...(m.password ? { password: m.password } : {}), ...(m.maxDownloads !== undefined ? { maxDownloads: m.maxDownloads } : {}),
      })), 'application/json');
      if (begin.status !== 201) throw new Error(`The hub refused the link (${(begin.json as { error?: string })?.error ?? begin.status}).`);
      for (let i = 0; i < m.files.length; i++) {
        const fh = await open(local.sealedPath(id, i), 'r');
        try {
          const size = (await fh.stat()).size;
          let off = 0;
          while (off < size) {
            const buf = Buffer.alloc(Math.min(MEMBER_LINK_SLICE, size - off));
            await fh.read(buf, 0, buf.length, off);
            const r = await this.hubCall('PUT', `/mesh/v1/links/${id}/${i}/${off}`, buf, 'application/octet-stream');
            if (r.status !== 200) throw new Error(`Upload to the hub failed (${(r.json as { error?: string })?.error ?? r.status}).`);
            off += buf.length;
          }
        } finally {
          await fh.close();
        }
      }
      const done = await this.hubCall('POST', `/mesh/v1/links/${id}/done`);
      const base = (done.json as { base?: unknown })?.base;
      if (done.status !== 200 || typeof base !== 'string') throw new Error('The hub did not finish the link.');
      const url = `${base}/l/${id}#k=${key.toString('base64url')}`;
      writeFileAtomic(this.memberLinksFile(), JSON.stringify({ ...this.memberLinkUrls(), [id]: url }));
      return { id, url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1 }), expiresAt: Date.now() + expiresInMs };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async linkList(): Promise<LinkView[]> {
    if (!this.rootKey) {
      if (!this.running?.client?.linkedHub) return [];
      const r = await this.hubCall('GET', '/mesh/v1/links');
      const urls = this.memberLinkUrls();
      return r.status === 200 && Array.isArray(r.json) ? (r.json as LinkInfo[]).map((l) => (urls[l.id] ? { ...l, url: urls[l.id] } : l)) : [];
    }
    await this.links().prune();
    const out: LinkView[] = [];
    for (const l of await this.links().list()) {
      let url: string | undefined;
      try {
        url = readFileSync(join(this.home, 'hub', 'links', l.id, 'owner-url'), 'utf8');
      } catch {
        /* made elsewhere */
      }
      out.push(url !== undefined ? { ...l, url } : l);
    }
    return out;
  }

  async linkRevoke(id: string): Promise<void> {
    if (!this.rootKey) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new Error('No such link.');
      const r = await this.hubCall('POST', `/mesh/v1/links/${id}/revoke`);
      if (r.status !== 200 && r.status !== 404) throw new Error('The hub did not remove the link.');
      const urls = this.memberLinkUrls();
      delete urls[id];
      writeFileAtomic(this.memberLinksFile(), JSON.stringify(urls));
      return;
    }
    await this.links().revoke(id);
    const u = this.linkUploadMap.get(id);
    this.linkUploadMap.delete(id);
    await u?.cancelAll();
  }

  /** Redeems a QR invite: over the LAN if it has addresses, else (or if that fails) through the hub. */
  async join(uri: string, alias?: string): Promise<'member' | 'provisional'> {
    if (this.mesh) throw new Error('join: this device is already in a mesh');
    const invite = parseInviteUri(uri);
    const name = alias ?? this.alias;
    let status: 'member' | 'provisional';
    try {
      if (invite.lan.length === 0) throw new Error('no LAN address');
      status = await joinViaLan(this.identity, uri, name, this.home);
      if (status === 'member' && invite.lan[0]) {
        const list = (await MembershipStore.load(this.home))?.list();
        // The inviter answered at this address; if it is the hub, remember where it lives.
        if (list && list.hub.deviceId === invite.inviter) this.writeHubAddr({ deviceId: invite.inviter, ...invite.lan[0] });
      }
    } catch (e) {
      if (invite.hubUrls.length === 0 || (e instanceof Error && /^join refused/.test(e.message))) throw e;
      status = await joinViaHub(this.identity, uri, name, this.home);
    }
    if (status === 'member') {
      this.mesh = await MembershipStore.load(this.home);
      this.emitEvent({ source: 'mesh', type: 'joined', version: this.mesh?.list().version ?? 0 });
      this.startClient();
    }
    return status;
  }

  /** The devices in this mesh (empty if none). */
  members(): Member[] {
    return this.mesh?.list().members.map((m) => ({ ...m })) ?? [];
  }

  /** Hub only: removes a device (unique id prefix) from the mesh for good. */
  async revoke(prefix: string): Promise<SignedMembership> {
    const hub = this.requireHub();
    const q = prefix.toLowerCase();
    if (!PREFIX_RE.test(q)) throw new UnknownDeviceError(prefix, 'invalid');
    const matches = (this.mesh?.list().members ?? []).map((m) => m.deviceId).filter((id) => id.startsWith(q));
    if (matches.length === 0) throw new UnknownDeviceError(prefix, 'unknown');
    if (matches.length > 1) throw new UnknownDeviceError(prefix, 'ambiguous', matches);
    return hub.revoke(matches[0]!);
  }

  /** The verified relay list for this mesh (null: none). */
  private relayList(): RelayList | null {
    const m = this.mesh;
    return m ? this.relayStore.list(m.anchor, m.list().mesh) : null;
  }

  private isNamedRelay(): boolean {
    return (this.relayList()?.relays ?? []).some((r) => r.deviceId === this.identity.deviceId);
  }

  /** A relay list from a hub: kept if newer; a device newly named (or no longer named) a relay restarts its servers. */
  private onRelays(s: unknown): void {
    const m = this.mesh;
    if (!m) return;
    const was = this.isNamedRelay();
    let res: 'updated' | 'same' | 'stale';
    try {
      res = this.relayStore.accept(s, m.anchor, m.list().mesh);
    } catch {
      return; // not signed by this mesh's root
    }
    if (res !== 'updated') return;
    this.running?.relayHub?.pushRelays(this.relayStore.current()!);
    this.emitEvent({ source: 'mesh', type: 'relays' });
    if (was !== this.isNamedRelay()) void this.restartForRelay();
  }

  private async restartForRelay(): Promise<void> {
    if (!this.running) return;
    await this.stop();
    await this.start();
  }

  /** The relay hubs of this mesh, with their names. */
  relays(): RelayView[] {
    const members = this.mesh?.list().members ?? [];
    return (this.relayList()?.relays ?? []).map((r) => ({ deviceId: r.deviceId, alias: members.find((x) => x.deviceId === r.deviceId)?.alias ?? r.deviceId.slice(0, 8), urls: [...r.urls] }));
  }

  /**
   * Main hub only: names the members that run a relay hub, each with its public wss:// address(es).
   * Every device gets the signed list and fails over to these hubs while this one is away.
   */
  async relaysSet(relays: Relay[]): Promise<RelayView[]> {
    const m = this.mesh;
    if (!this.rootKey || !m || m.list().hub.deviceId !== this.identity.deviceId) throw new Error('Relay hubs are set on the main hub.');
    for (const r of relays) {
      if (r.deviceId === this.identity.deviceId) throw new Error('The main hub cannot also be a relay hub.');
      if (!m.list().members.some((x) => x.deviceId === r.deviceId)) throw new Error('A relay hub must be a member of the mesh.');
      if (r.urls.length === 0) throw new Error('Enter the relay hub\'s public wss:// address.');
      this.checkHubUrls(r.urls);
    }
    const cur = this.relayList();
    const s = signRelays({ v: 1, mesh: m.list().mesh, version: (cur?.version ?? 0) + 1, issuedAt: Date.now(), relays }, this.rootKey);
    this.relayStore.accept(s, m.anchor, m.list().mesh);
    this.running?.hub?.pushRelays(s);
    this.emitEvent({ source: 'mesh', type: 'relays' });
    return this.relays();
  }

  /** [{prefix, url}] from the CLI: each prefix must name exactly one member. */
  resolveRelays(raw: unknown[]): Relay[] {
    const members = this.mesh?.list().members ?? [];
    const out = new Map<string, string[]>();
    for (const r of raw as { prefix?: unknown; url?: unknown }[]) {
      if (typeof r?.prefix !== 'string' || typeof r.url !== 'string') throw new Error('bad relay');
      const ids = members.map((m) => m.deviceId).filter((id) => id.startsWith(r.prefix as string));
      if (ids.length !== 1) throw new Error(`relay: "${r.prefix}" names ${ids.length} members`);
      out.set(ids[0]!, [...(out.get(ids[0]!) ?? []), r.url]);
    }
    return [...out].map(([deviceId, urls]) => ({ deviceId, urls }));
  }

  hubStatus(): HubStatus {
    if (!this.mesh) {
      const pending = existsSync(join(this.home, 'mesh-pending.json'));
      return { role: pending ? 'provisional' : 'none', online: false, version: 0, members: 0, hubId: null, urls: [] };
    }
    const list = this.mesh.list();
    const isHub = this.rootKey !== null && list.hub.deviceId === this.identity.deviceId;
    return {
      role: isHub ? 'hub' : 'member',
      online: isHub ? this.running?.hub != null : this.hubOnline(),
      version: list.version,
      members: list.members.length,
      hubId: list.hub.deviceId,
      urls: [...list.hub.urls],
      linkedTo: isHub ? 'main' : this.running?.client?.linkedHub == null ? null : this.running.client.linkedHub === list.hub.deviceId ? 'main' : 'relay',
      relayHub: this.running?.relayHub != null,
    };
  }

  /** Hub only: the root key and current list, encrypted with `passphrase` (see mesh/recovery.ts). */
  exportRecovery(passphrase: string): string {
    if (!this.rootKey || !this.mesh) throw new Error('recovery: this device is not a hub');
    return sealRecovery(this.rootKey, this.mesh.current(), passphrase);
  }

  /**
   * Restores a mesh on a fresh home: this device becomes the hub, the old hub is revoked, and the
   * list is re-signed with a higher version. Call before start().
   */
  async importRecovery(text: string, passphrase: string): Promise<SignedMembership> {
    if (this.running) throw new Error('recovery: stop the engine first');
    if (this.mesh || (await hasRootKey(this.home))) throw new Error('recovery: this device is already in a mesh');
    const { rootKey, membership } = openRecovery(text, passphrase);
    const old = membership.list;
    const me = this.identity.deviceId;
    const now = Date.now();
    const revoked = old.hub.deviceId !== me && !old.revoked.some((x) => x.deviceId === old.hub.deviceId)
      ? [...old.revoked, { deviceId: old.hub.deviceId, revokedAt: now }]
      : old.revoked.filter((x) => x.deviceId !== me);
    const list: MembershipList = {
      ...old,
      version: old.version + 1,
      issuedAt: now,
      hub: { deviceId: me, urls: [...old.hub.urls] },
      members: [
        ...old.members.filter((m) => m.deviceId !== old.hub.deviceId && m.deviceId !== me),
        { deviceId: me, alias: this.alias, publicKeyPem: this.identity.publicKey.export({ type: 'spki', format: 'pem' }) as string, role: 'hub', addedAt: now },
      ],
      revoked,
    };
    const s = signList(list, rootKey);
    await saveRootKey(this.home, rootKey);
    this.mesh = await MembershipStore.init(this.home, createPublicKey(rootKey), s);
    this.rootKey = rootKey;
    return s;
  }
}
