// Engine facade: one object that owns a device's identity, trust store, inbox, outbox, receiver
// server and LAN discovery, and offers send / pair / resume on top. Consumed by the CLI (src/cli.ts),
// and later by the hub (M2) and the desktop app (M3).
//
// Layout under `home` (default configDir()):
//   identity/{key.pem,cert.der}   device identity (identity.ts)
//   trust.json                    trusted devices (trust.ts); re-read when another process changes it
//   outbox/<sessionId>.json       unfinished sends (transfer/send.ts); every send goes through it
//   manual-peers.json             addresses added by pairManual, re-probed on start()
//
// Events: everything is emitted on the single 'event' channel as an EngineEvent.
import { X509Certificate, createPublicKey } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import type { Server } from 'node:https';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { createMeshServer, type ReceiverEvent } from './api/server.ts';
import { DEFAULT_MESH_PORT, Discovery, MAX_ALIAS_CHARS, type Announce, type DiscoveryOptions, type PeerInfo } from './discovery.ts';
import { deviceIdOf, loadOrCreateIdentity, type Identity } from './identity.ts';
import { Inbox } from './inbox.ts';
import { configDir } from './paths.ts';
import { multiSend } from './transfer/multisend.ts';
import { Outbox, type SendItem, type SendResult, type Target } from './transfer/send.ts';
import { TrustStore, type TrustedDevice } from './trust.ts';

export type { SendItem, SendResult } from './transfer/send.ts';
export type { TrustedDevice } from './trust.ts';

export type EngineEvent =
  | ({ source: 'receiver' } & ReceiverEvent)
  | { source: 'sender'; type: 'progress'; deviceId: string; fileId: number; sent: number; total: number }
  | ({ source: 'sender'; type: 'result' } & SendResult)
  | { source: 'discovery'; type: 'peer' | 'lost'; peer: PeerInfo };

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

  private constructor(identity: Identity, home: string, opts: EngineOptions) {
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
  }

  /** Loads (or creates) the identity under `home`. Opens no sockets: call start(). */
  static async create(opts: EngineOptions = {}): Promise<Engine> {
    const home = opts.home ?? configDir();
    const port = opts.port ?? DEFAULT_MESH_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port ${String(port)}`);
    if (opts.deviceType !== undefined && !DEVICE_TYPES.includes(opts.deviceType)) throw new Error(`invalid deviceType ${String(opts.deviceType)}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const identity = await loadOrCreateIdentity(home);
    return new Engine(identity, home, opts);
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
      const s = createMeshServer({
        id: this.identity,
        trust: this.trust,
        inbox: this.inbox,
        alias: this.alias,
        deviceType: this.deviceType,
        onEvent: (e) => this.emitEvent({ source: 'receiver', ...e }),
      });
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

    this.running = { server, discovery, abort: new AbortController(), port };

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
    discovery.on('peer', (p: PeerInfo) => this.emitEvent({ source: 'discovery', type: 'peer', peer: p }));
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
      const t = this.trust.get(p.deviceId);
      return t ? { ...p, trusted: true, trustedAlias: t.alias } : { ...p, trusted: false };
    });
  }

  /** Resolves a unique prefix (>= 4 hex chars, case-insensitive) of a trusted device id. */
  resolveDeviceId(query: string): string {
    const q = query.toLowerCase();
    if (!PREFIX_RE.test(q)) throw new UnknownDeviceError(query, 'invalid');
    const matches = this.trust.list().map((d) => d.deviceId).filter((id) => id.startsWith(q));
    if (matches.length === 0) throw new UnknownDeviceError(query, 'unknown');
    if (matches.length > 1) throw new UnknownDeviceError(query, 'ambiguous', matches);
    return matches[0]!;
  }

  private targetFor(deviceId: string, peers: Map<string, PeerInfo>): Target | undefined {
    const t = this.trust.get(deviceId);
    const p = peers.get(deviceId);
    if (!t || !p) return undefined;
    return { deviceId, host: p.host, port: p.port, publicKey: createPublicKey(t.publicKeyPem) };
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
    const peers = new Map(r.discovery.peers().map((p) => [p.deviceId, p]));
    let ids: string[];
    if (deviceIds === 'all') {
      ids = this.trust.list().map((d) => d.deviceId).filter((id) => peers.has(id));
      if (ids.length === 0) return [];
    } else {
      ids = deviceIds.map((q) => this.resolveDeviceId(q));
    }
    const targets: Target[] = [];
    for (const id of ids) {
      const t = this.targetFor(id, peers);
      if (t && !targets.some((x) => x.deviceId === id)) targets.push(t);
    }
    const run = async (): Promise<SendResult[]> => {
      const sent =
        targets.length === 0
          ? []
          : await multiSend(this.identity, targets, items, {
              outbox: this.outbox,
              signal: r.abort.signal,
              onProgress: (p) => this.emitEvent({ source: 'sender', type: 'progress', ...p }),
            });
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
      const peers = new Map(r.discovery.peers().map((p) => [p.deviceId, p]));
      const results = await this.outbox.resumeAll(this.identity, (id) => this.targetFor(id, peers), { signal: r.abort.signal });
      for (const res of results) this.emitEvent({ source: 'sender', type: 'result', ...res });
      return results;
    };
    return this.track(run());
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
}
