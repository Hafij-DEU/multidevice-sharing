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
import { X509Certificate, createPublicKey, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import type { Server } from 'node:https';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { createMeshHandler, type TrustSource } from './api/handler.ts';
import { createMeshServer, type ReceiverEvent } from './api/server.ts';
import { CHUNK_SIZE, chunkCount } from './chunk.ts';
import { HubClient } from './hub/client.ts';
import { HeldStore } from './hub/held.ts';
import { DEFAULT_INGRESS_PORT, HubServer, type DirectoryEntry, type LanAddr } from './hub/server.ts';
import { spkiSha256 } from './mesh/canonical.ts';
import { InviteBook, inviteUri, parseInviteUri, type Invite } from './mesh/invite.ts';
import { completeJoin, createJoinHandler, joinViaHub, joinViaLan } from './mesh/join.ts';
import { CompositeTrust, MembershipStore } from './mesh/members.ts';
import { signList, type Member, type MembershipList, type SignedMembership } from './mesh/membership.ts';
import { pullMembership } from './mesh/propagate.ts';
import { exportRecovery as sealRecovery, importRecovery as openRecovery } from './mesh/recovery.ts';
import { hasRootKey, loadOrCreateRootKey, saveRootKey } from './mesh/rootkey.ts';
import { LanTransport, RelayTransport, type Transport } from './transfer/transport.ts';
import { writeFileAtomic } from './trust.ts';
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
  | { source: 'sender'; type: 'progress'; deviceId: string; fileId: number; sent: number; total: number }
  | ({ source: 'sender'; type: 'result' } & SendResult)
  | { source: 'discovery'; type: 'peer' | 'lost'; peer: PeerInfo }
  | {
      source: 'mesh';
      type: 'online' | 'offline' | 'membership' | 'directory' | 'revoked' | 'held-delivered' | 'held-failed' | 'joined';
      /** membership: the new list version. */
      version?: number;
      /** held-*: the target device and the session. */
      to?: string;
      sessionId?: string;
      files?: string[];
      status?: number;
      error?: string;
    };

/** Where this device stands in its mesh. */
export interface HubStatus {
  role: 'hub' | 'member' | 'provisional' | 'none';
  /** This device's link to the hub is up (the hub device counts as online when running). */
  online: boolean;
  version: number;
  members: number;
  hubId: string | null;
  urls: string[];
}

/** An unfinished send waiting in the outbox (paused, failed, or interrupted by a crash). */
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
  /** This device's LAN addresses as reported to the hub and put in invites (default: all non-internal IPv4). */
  lanAddrs?: () => LanAddr[];
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
const INVITE_POLL_MS = 1000;
const PENDING_RETRY_MS = 10_000;
/** Generous per-frame bound for held sessions: envelope header + framing. */
const HELD_FRAME_OVERHEAD = 32 * 1024;
const PAIR_TIMEOUT_MS = 5000;
const REPROBE_TIMEOUT_MS = 2000;

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
  discovery: Discovery;
  abort: AbortController;
  port: number;
  hub: HubServer | null;
  ingressPort: number;
  client: HubClient | null;
  timers: NodeJS.Timeout[];
}

type Route = { kind: 'lan'; host: string; port: number } | { kind: 'relay' } | { kind: 'held' } | { kind: 'unreachable' };

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

function defaultLanAddrs(port: number): LanAddr[] {
  const out: LanAddr[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push({ host: i.address, port });
  }
  return out.slice(0, 8);
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
  private lastInviteSecret = '';
  private joinHandler: ((peer: string, body: unknown) => Promise<{ status: number; body: object }>) | null = null;
  private readonly lastPull = new Map<string, number>();
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
    this.alias = truncateAlias(opts.alias ?? hostname());
    this.deviceType = opts.deviceType ?? 'desktop';
    this.mesh = mesh;
    this.rootKey = rootKey;
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

  get started(): boolean {
    return this.running !== null;
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
      discovery = this.makeDiscovery(port, dopts);
    } catch (e) {
      server?.close();
      throw e;
    }
    if (dopts !== false && server) discovery.start();

    let hub: HubServer | null = null;
    let ingressPort = 0;
    if (server && this.rootKey && this.mesh) {
      const hopts = this.opts.hub ?? {};
      const heldOpts: { quotaBytes?: number; ttlMs?: number } = {};
      if (hopts.heldQuotaBytes !== undefined) heldOpts.quotaBytes = hopts.heldQuotaBytes;
      if (hopts.heldTtlMs !== undefined) heldOpts.ttlMs = hopts.heldTtlMs;
      hub = new HubServer({
        id: this.identity, home: this.home, rootKey: this.rootKey, members: this.mesh,
        held: new HeldStore(join(this.home, 'hub', 'held'), heldOpts), invites: this.invites,
        hubLan: () => this.lanAddrs(port),
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
    this.joinHandler = createJoinHandler({
      id: this.identity, invites: this.invites, members: () => this.mesh, manualTrust: this.trust,
      ...(hub ? { hub } : {}), hubClient: () => this.running?.client ?? null,
    });

    this.running = { server, discovery, abort: new AbortController(), port, hub, ingressPort, client: null, timers: [] };
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

  private makeDiscovery(port: number, dopts: EngineOptions['discovery']): Discovery {
    const discovery = new Discovery({
      self: { v: 1, deviceId: this.identity.deviceId, alias: this.alias, deviceType: this.deviceType, port: port || DEFAULT_MESH_PORT },
      ...(dopts || {}),
    });
    discovery.on('error', () => {}); // per-interface socket failures are not fatal
    discovery.on('peer', (p: PeerInfo) => {
      this.emitEvent({ source: 'discovery', type: 'peer', peer: p });
      void this.maybePull(p);
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
    await r.client?.stop();
    await r.hub?.close();
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

  private targetFor(deviceId: string, peers: Map<string, PeerInfo>): Target | undefined {
    const t = this.trustSource.get(deviceId);
    const p = peers.get(deviceId);
    if (!t || !p) return undefined;
    return { deviceId, host: p.host, port: p.port, publicKey: createPublicKey(t.publicKeyPem) };
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
    const known = (): PeerInfo | undefined => r.discovery.peers().find((p) => p.deviceId === deviceId);
    let peer = known();
    const dir = this.directory().find((d) => d.deviceId === deviceId);
    if (!peer && dir) {
      for (const a of dir.lanAddrs) {
        await r.discovery.probe(a.host, a.port, { timeoutMs: REPROBE_TIMEOUT_MS }).catch(() => {});
        peer = known();
        if (peer) break;
      }
    }
    if (peer) return { kind: 'lan', host: peer.host, port: peer.port };
    if (this.hubOnline()) return dir?.online ? { kind: 'relay' } : { kind: 'held' };
    return { kind: 'unreachable' };
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
   * error:'offline'}. Results are in request order; duplicates are sent once.
   */
  async send(deviceIds: string[] | 'all', items: SendItem[]): Promise<SendResult[]> {
    const r = this.requireRunning();
    let ids: string[];
    if (deviceIds === 'all') {
      const present = new Set(r.discovery.peers().map((p) => p.deviceId));
      for (const d of this.directory()) if (d.online) present.add(d.deviceId);
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
      const targets: Target[] = [];
      for (const id of unique) {
        const t = this.trustSource.get(id);
        if (t && routes.get(id)!.kind !== 'unreachable') targets.push({ deviceId: id, publicKey: createPublicKey(t.publicKeyPem) });
      }
      const progress = (p: { deviceId: string; fileId: number; sent: number; total: number }) => this.emitEvent({ source: 'sender', type: 'progress', ...p });
      const sent =
        targets.length === 0
          ? []
          : await multiSend(this.identity, targets, items, {
              outbox: this.outbox,
              signal: r.abort.signal,
              onProgress: progress,
              transport: (t) => this.transportFor(routes.get(t.deviceId)!, t, holdBytes),
            });
      // A LAN attempt that failed for a transient reason resumes the same session over the hub once.
      for (const [i, res] of sent.entries()) {
        if (res.status !== 'failed' || routes.get(res.deviceId)?.kind !== 'lan' || !this.hubOnline() || !isTransientError(res.error)) continue;
        const dir = this.directory().find((d) => d.deviceId === res.deviceId);
        const route: Route = dir?.online ? { kind: 'relay' } : { kind: 'held' };
        const hb = route.kind === 'held' ? await estimateHoldBytes(items) : 0;
        const t = targets.find((x) => x.deviceId === res.deviceId)!;
        sent[i] = await sendTo(this.identity, t, items, {
          outbox: this.outbox, signal: r.abort.signal,
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
        this.emitEvent({ source: 'sender', type: 'result', ...res });
      }
      return out;
    };
    return this.track(run());
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
    };
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
    const addr: { host?: string; port?: number } = peer ? { host: peer.host, port: peer.port } : {};
    if (!peer && e.target.host !== undefined && e.target.port !== undefined) Object.assign(addr, { host: e.target.host, port: e.target.port });
    const cancelled = await postCancel(this.identity, { deviceId: e.target.deviceId, ...addr }, e.sessionId);
    return { removed: this.outboxItem(e), cancelled };
  }

  /**
   * M1 trust bootstrap (M2 replaces it with QR + hub membership): connects to host:port, takes the
   * device id and public key from the certificate it presents, adds it to the trust store under
   * `alias` and keeps it as a manual peer (also after a restart). The other side must pair back.
   */
  async pairManual(host: string, port: number, alias: string): Promise<TrustedDevice> {
    const r = this.requireRunning();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`pair: invalid port ${String(port)}`);
    const der = await fetchPeerCert(host, port, PAIR_TIMEOUT_MS);
    const deviceId = deviceIdOf(der);
    if (deviceId === this.identity.deviceId) throw new Error('pair: that is this device; you cannot pair with yourself');
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

  // ---- mesh (M2) --------------------------------------------------------------------------------

  private receiverOptions(): Parameters<typeof createMeshServer>[0] {
    return {
      id: this.identity,
      trust: this.trustSource,
      inbox: this.inbox,
      alias: this.alias,
      deviceType: this.deviceType,
      onEvent: (e) => this.emitEvent({ source: 'receiver', ...e }),
      onJoin: async (peer, body) => {
        this.syncInvite();
        if (!this.joinHandler) return { status: 404, body: { error: 'not-found' } };
        const r = await this.joinHandler(peer, body);
        if (r.status === 200) this.markInviteUsed(); // single use, also across restarts
        return r;
      },
      membership: () => this.mesh?.current() ?? null,
    };
  }

  /** Starts the link to the hub (the hub device links to itself over loopback, to send and receive relayed). */
  private startClient(): void {
    const r = this.running;
    if (!r || r.client || !this.mesh || !r.server) return;
    const handler = createMeshHandler(this.receiverOptions());
    const port = r.port;
    const isHub = r.hub !== null;
    const client = new HubClient({
      id: this.identity, members: this.mesh, handler: (q) => handler.handle(q),
      lanAddrs: () => this.lanAddrs(port),
      hubLan: () => {
        if (isHub) return { host: '127.0.0.1', port };
        const hubId = this.mesh?.list().hub.deviceId;
        const p = r.discovery.peers().find((x) => x.deviceId === hubId);
        return p ? { host: p.host, port: p.port } : undefined;
      },
      ...(this.opts.hubBackoffMs ? { backoffMs: this.opts.hubBackoffMs } : {}),
    });
    const mesh = (type: Extract<EngineEvent, { source: 'mesh' }>['type'], extra: Record<string, unknown> = {}) =>
      this.emitEvent({ source: 'mesh', type, ...extra } as EngineEvent);
    client.on('online', () => {
      mesh('online');
      this.lastInviteSecret = ''; // re-register the current invite with the (possibly new) hub
      this.syncInvite();
    });
    client.on('offline', () => mesh('offline'));
    client.on('membership', (sm: SignedMembership) => mesh('membership', { version: sm.list.version }));
    client.on('directory', () => mesh('directory'));
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
    const mesh = this.mesh;
    if (!mesh || !mesh.isTrusted(p.deviceId) || this.hubOnline()) return;
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

  private readInvite(): { secret: string; expiresAt: number; used: boolean } | null {
    try {
      const j = JSON.parse(readFileSync(join(this.home, 'invite.json'), 'utf8')) as Record<string, unknown>;
      if (typeof j.secret !== 'string' || typeof j.expiresAt !== 'number') return null;
      return { secret: j.secret, expiresAt: j.expiresAt, used: j.used === true };
    } catch {
      return null;
    }
  }

  /** The invite in invite.json was redeemed: it must never be registered again (restart, relink). */
  private markInviteUsed(): void {
    const cur = this.readInvite();
    if (cur && !cur.used) writeFileAtomic(join(this.home, 'invite.json'), JSON.stringify({ ...cur, used: true }));
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
    this.invites.register(invite, j.expiresAt - Date.now());
    this.running?.client?.registerInvite(invite);
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
        const req = JSON.parse(readFileSync(file, 'utf8')) as { op?: unknown; prefix?: unknown };
        if (req.op !== 'revoke' || typeof req.prefix !== 'string') throw new Error('bad request');
        const sm = await this.revoke(req.prefix);
        result = { ok: true, version: sm.list.version };
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
  async hubInit(urls: string[]): Promise<SignedMembership> {
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

  /** A single-use QR invite (5 min). Also written to invite.json so a running `listen` honours it. */
  createInvite(): { invite: Invite; uri: string } {
    if (!this.mesh) throw new Error('invite: this device is not in a mesh (run `meshdrop hub init` or join one)');
    const list = this.mesh.list();
    const invite = this.invites.create(this.identity.deviceId, list.mesh, this.lanAddrs(this.port), list.hub.urls);
    const secret = invite.secret.toString('base64url');
    writeFileAtomic(join(this.home, 'invite.json'), JSON.stringify({ secret, expiresAt: invite.expiresAt, used: false }));
    this.lastInviteSecret = secret;
    this.running?.client?.registerInvite(invite);
    return { invite, uri: inviteUri(invite) };
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
