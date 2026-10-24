// The desktop app's brain: owns the engine, turns its events into an AppState for the UI, and
// carries out every DesktopApi action. Electron-free (the Platform is injected), so it is tested
// directly in Node.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import QRCode from 'qrcode';
import { CHUNK_SIZE } from '@meshdrop/core/src/chunk.ts';
import { Engine, liveListener, type EngineEvent, type EngineOptions, type SendItem } from '@meshdrop/core/src/engine.ts';
import { loadOrCreateIdentity } from '@meshdrop/core/src/identity.ts';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';
import type { AppState, DeviceView, GuestView, LinkCreateInput, LinkView, ReachInput, ReachView, SendItemInput, Settings, SyncView, TransferView } from '../shared/api.ts';
import type { HistoryStore } from './history.ts';
import { SettingsError, type SettingsStore } from './settings.ts';

export interface Platform {
  notify(title: string, body: string, onClick?: () => void): void;
  writeClipboard(text: string): void;
  readClipboard(): string;
  openPath(p: string): Promise<void>;
  revealPath(p: string): void;
  /** A small preview of an image or video as a data: URL, or null when there is none. */
  thumbnail(p: string): Promise<string | null>;
}

export interface ControllerOptions {
  home: string;
  settings: SettingsStore;
  history: HistoryStore;
  platform: Platform;
  engineOptions?: Partial<EngineOptions>;
}

/** Minimum gap between two 'state' events (so at most 10 progress updates per second). */
const STATE_INTERVAL_MS = 100;
const MAX_TRANSFERS = 100;
const RATE_WINDOW_MS = 500;
/** Shared clipboard: how often the clipboard is checked, and the most text it sends. */
const CLIP_POLL_MS = 1000;
const MAX_CLIP_SYNC = 64 * 1024;
const MAX_RECOVERY_BYTES = 1024 * 1024;
/** Settings the engine is created with: changing one restarts it. */
const ENGINE_KEYS = ['alias', 'inbox', 'port', 'discovery'] as const;

interface Transfer extends TransferView {
  /** Per-file bytes done (out: plaintext bytes; in: estimated from chunks). */
  done: Map<number, number>;
  sizes: Map<number, number>;
  /** Out: the send()'s tag (`deviceId\0tag`) and the engine session, once known. */
  tagKey?: string;
  sessionId?: string;
  /** Start of the current speed window and the bytes done at that time. */
  rateAt?: number;
  rateSent?: number;
}

const CLIENT_ONLY = 'Receiving is handled by the MeshDrop background service on this PC. Stop it first (systemctl --user stop meshdrop).';
/** How often client-only mode checks that the background service is still there. */
const LISTENER_RECHECK_MS = 30_000;

/** Non-loopback IPv4 addresses, private ones first. */
function lanIpv4(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  const priv = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...out.filter(priv), ...out.filter((ip) => !priv(ip))];
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, () => s.close(() => done(true)));
  });
}

/** Files and plaintext bytes a send will carry (symlinks inside folders are skipped, like the sender does). */
async function measure(items: SendItemInput[]): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        bytes += (await lstat(p)).size;
      }
    }
  };
  for (const it of items) {
    if (it.kind === 'text') bytes += Buffer.byteLength(it.text ?? '');
    else if (it.kind === 'file') {
      files++;
      bytes += statSync(it.path!).size;
    } else await walk(it.path!);
  }
  return { files, bytes };
}

export class AppController extends EventEmitter {
  readonly #home: string;
  readonly #settings: SettingsStore;
  readonly #history: HistoryStore;
  readonly #platform: Platform;
  readonly #engineOptions: Partial<EngineOptions>;
  #engine: Engine | null = null;
  #mode: AppState['mode'] = 'serving';
  #ownsPid = false;
  readonly #transfers = new Map<string, Transfer>();
  /** `deviceId\0tag` of a send() → its row; engine sessionId → its row. */
  readonly #byTag = new Map<string, string>();
  readonly #bySession = new Map<string, string>();
  /** Why this device is not receiving although it should (e.g. its port is taken). */
  #error: string | undefined;
  #deviceId = '';
  #recheck: NodeJS.Timeout | null = null;
  #outbox: AppState['outbox'] = [];
  #timer: NodeJS.Timeout | null = null;
  #lastEmit = 0;
  #stopped = false;
  #paused = false;
  /** The guest link's QR code (the engine keeps the rest of the session). */
  #guestQr: string | undefined;
  /** Shared clipboard: the poll, and the last text seen (copied here or received), so nothing echoes back. */
  #clipTimer: NodeJS.Timeout | null = null;
  #lastClip: string | undefined;
  /** Files handed in from outside (Files → Send with MeshDrop), waiting for takeSharedItems(). */
  #shared: SendItemInput[] = [];
  /** The hub's internet links (refreshed on changes and every 30 s: download counts move on their own). */
  #links: LinkView[] = [];
  #linkTimer: NodeJS.Timeout | null = null;

  constructor(opts: ControllerOptions) {
    super();
    this.#home = opts.home;
    this.#settings = opts.settings;
    this.#history = opts.history;
    this.#platform = opts.platform;
    this.#engineOptions = opts.engineOptions ?? {};
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#boot();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#linkTimer) clearInterval(this.#linkTimer);
    this.#linkTimer = null;
    if (this.#clipTimer) clearInterval(this.#clipTimer);
    this.#clipTimer = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#halt();
  }

  #engineOpts(serve: boolean, port: number): EngineOptions {
    const s = this.#settings.get();
    return {
      home: this.#home,
      inbox: s.inbox,
      port,
      alias: s.alias,
      serve,
      autoResume: true,
      clientDiscovery: true,
      ...(s.discovery ? {} : { discovery: false as const }),
      ...this.#engineOptions,
    };
  }

  async #run(opts: EngineOptions): Promise<Engine> {
    const e = await Engine.create(opts);
    e.on('event', (ev: EngineEvent) => this.#onEvent(ev));
    try {
      await e.start();
    } catch (x) {
      e.removeAllListeners('event');
      await e.stop();
      throw x;
    }
    return e;
  }

  /** A verified `meshdrop listen` (the background service) on this home, if any. */
  async #listener(): Promise<{ pid: number; port: number } | null> {
    if (!this.#deviceId) this.#deviceId = (await loadOrCreateIdentity(this.#home)).deviceId;
    const l = await liveListener(this.#home, this.#deviceId);
    return l && l.pid !== process.pid ? l : null;
  }

  /**
   * Starts the engine. Next to a running background service it is client-only (sends; the service
   * receives). If the port cannot be bound it still starts, without receiving, and says why in
   * state().error so Settings stays usable.
   */
  async #boot(): Promise<void> {
    this.#error = undefined;
    let l = await this.#listener();
    if (!l) {
      try {
        this.#engine = await this.#run(this.#engineOpts(true, this.#settings.get().port));
        this.#mode = 'serving';
        this.#engine.setReceiving(!this.#paused);
        writeFileSync(join(this.#home, 'listen.pid'), JSON.stringify({ pid: process.pid, port: this.#engine.port }), { mode: 0o600 });
        this.#ownsPid = true;
      } catch (x) {
        const busy = (x as NodeJS.ErrnoException).code === 'EADDRINUSE';
        // The service may have bound the port a moment before writing listen.pid (login race).
        for (let i = 0; busy && !l && i < 10; i++) {
          await new Promise((r) => setTimeout(r, 300));
          l = await this.#listener();
        }
        if (!l) {
          this.#error = busy
            ? `Port ${this.#settings.get().port} is in use by another program, so this PC is not receiving. Choose another port in Settings.`
            : `This PC is not receiving: ${x instanceof Error ? x.message : String(x)}`;
          this.#mode = 'serving';
          this.#engine = await this.#run(this.#engineOpts(false, this.#settings.get().port));
        }
      }
    }
    if (l) {
      this.#mode = 'client-only';
      this.#engine = await this.#run(this.#engineOpts(false, l.port)); // invites carry the service's port
      this.#recheck = setInterval(() => void this.#checkListener(), LISTENER_RECHECK_MS);
      this.#recheck.unref();
    }
    void this.#refreshOutbox();
    void this.#refreshLinks();
    if (!this.#linkTimer) {
      this.#linkTimer = setInterval(() => void this.#refreshLinks(), 30_000);
      this.#linkTimer.unref();
    }
    if (!this.#clipTimer) {
      this.#clipTimer = setInterval(() => this.#clipTick(), CLIP_POLL_MS);
      this.#clipTimer.unref();
    }
    this.#changed();
  }

  /** Client-only: when the background service is gone, take over receiving. */
  async #checkListener(): Promise<void> {
    if (this.#mode !== 'client-only' || this.#stopped || (await this.#listener())) return;
    await this.#restart().catch(() => {});
  }

  async #halt(): Promise<void> {
    const e = this.#engine;
    this.#engine = null;
    if (this.#recheck) clearInterval(this.#recheck);
    this.#recheck = null;
    if (this.#ownsPid) {
      try {
        const j = JSON.parse(readFileSync(join(this.#home, 'listen.pid'), 'utf8')) as { pid?: unknown };
        if (j.pid === process.pid) rmSync(join(this.#home, 'listen.pid'), { force: true });
      } catch {
        /* already gone */
      }
      this.#ownsPid = false;
    }
    if (e) {
      await e.stop();
      e.removeAllListeners('event');
    }
  }

  async #restart(): Promise<void> {
    await this.#halt();
    await this.#boot();
  }

  get #e(): Engine {
    if (!this.#engine) throw new Error('MeshDrop is not running');
    return this.#engine;
  }

  // ---- state ------------------------------------------------------------------------------------

  state(): AppState {
    const e = this.#e;
    const me = e.identity.deviceId;
    const st = e.hubStatus();
    return {
      self: { deviceId: me, alias: this.#settings.get().alias, port: e.port, addrs: lanIpv4() },
      mode: this.#mode,
      hub: { role: st.role, online: st.online, version: st.version, members: st.members, urls: st.urls, ingressPort: e.hubIngressPort },
      devices: e.devices().map((d): DeviceView => ({ ...d, self: false })),
      transfers: [...this.#transfers.values()].reverse().map(({ done: _d, sizes: _s, rateAt: _a, rateSent: _r, ...t }) => t),
      outbox: this.#outbox.map((o) => ({ ...o })),
      received: this.#history.received(),
      settings: this.#settings.get(),
      platform: 'desktop',
      ...(this.#shared.length > 0 ? { sharedPending: this.#shared.length } : {}),
      receiving: this.#mode === 'serving' && !this.#paused && this.#error === undefined,
      ...(this.#error !== undefined ? { error: this.#error } : {}),
      members: e.members().map((m) => ({ deviceId: m.deviceId, alias: m.alias, role: m.role, self: m.deviceId === me })),
      guest: this.#guestView(e),
      sync: this.#syncView(e),
      ...(st.role === 'hub' ? { links: this.#links.map((l) => ({ ...l })) } : {}),
      ...(this.#reachView(e) ? { reach: this.#reachView(e)! } : {}),
    };
  }

  #guestView(e: Engine): GuestView {
    const g = e.guestState();
    if (!g.active) return { active: false, available: g.available && this.#mode === 'serving', shared: [], offers: [] };
    return { ...g, ...(this.#guestQr !== undefined ? { qrSvg: this.#guestQr } : {}) };
  }

  get receiving(): boolean {
    return !this.#paused;
  }

  /** Pause receiving: offers are refused (senders keep them to resume); everything else keeps running. */
  async setReceiving(on: boolean): Promise<void> {
    if (this.#mode === 'client-only') throw new Error(CLIENT_ONLY);
    this.#paused = !on;
    this.#e.setReceiving(on);
    this.#changed();
  }

  #notClientOnly(): void {
    if (this.#mode === 'client-only') throw new Error(CLIENT_ONLY);
  }

  /** Pushes a fresh state to the UI (after something outside the controller changed it). */
  refresh(): void {
    this.#changed();
  }

  /** Schedules a 'state' event: at most one per STATE_INTERVAL_MS, always carrying the latest state. */
  #changed(): void {
    if (this.#timer || this.#stopped) return;
    const wait = Math.max(0, this.#lastEmit + STATE_INTERVAL_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#engine) return;
      this.#lastEmit = Date.now();
      this.emit('state', this.state());
    }, wait);
  }

  async #refreshOutbox(): Promise<void> {
    const e = this.#engine;
    if (!e) return;
    try {
      this.#outbox = (await e.listOutbox()).map((o) => ({
        sessionId: o.sessionId, deviceId: o.deviceId, ...(o.alias !== undefined ? { alias: o.alias } : {}), files: o.files, bytes: o.bytes,
        waiting: o.waiting, ...(o.lastError !== undefined && !o.waiting ? { error: o.lastError } : {}),
      }));
    } catch {
      return;
    }
    // A failed send the engine kept for auto-resume because the device was away (not one the device
    // answered, e.g. 'http-503 paused') is waiting, not failed. One the owner cancelled stops waiting.
    const waiting = new Set(this.#outbox.filter((o) => o.waiting).map((o) => o.sessionId));
    for (const t of this.#transfers.values()) {
      if (t.direction !== 'out' || t.sessionId === undefined) continue;
      if (t.status === 'failed' && waiting.has(t.sessionId) && !/^http-/.test(t.error ?? '')) {
        t.status = 'waiting';
        t.error = `${t.alias} is not reachable now. It gets this when it is back online (or cancel it under Unfinished sends).`;
      } else if (t.status === 'waiting' && !this.#outbox.some((o) => o.sessionId === t.sessionId)) {
        t.status = 'failed';
        t.error = 'Send cancelled.';
      }
    }
    this.#changed();
  }

  #aliasOf(id: string): string {
    return this.#engine?.devices().find((d) => d.deviceId === id)?.alias ?? id.slice(0, 8);
  }

  #addTransfer(t: Omit<Transfer, 'done' | 'sizes'>, sizes = new Map<number, number>()): Transfer {
    const x: Transfer = { ...t, done: new Map(), sizes };
    this.#transfers.delete(x.key);
    this.#transfers.set(x.key, x);
    while (this.#transfers.size > MAX_TRANSFERS) {
      const old = this.#transfers.get(this.#transfers.keys().next().value!)!;
      this.#transfers.delete(old.key);
      if (old.tagKey !== undefined) this.#byTag.delete(old.tagKey);
      if (old.sessionId !== undefined) this.#bySession.delete(old.sessionId);
    }
    return x;
  }

  #sum(t: Transfer): void {
    let n = 0;
    for (const v of t.done.values()) n += v;
    t.sent = Math.min(n, t.bytes || n);
    // Speed: bytes over windows of at least RATE_WINDOW_MS, smoothed so the time left does not jump.
    const now = Date.now();
    if (t.rateAt === undefined) {
      t.rateAt = now;
      t.rateSent = t.sent;
    } else if (now - t.rateAt >= RATE_WINDOW_MS) {
      const r = ((t.sent - (t.rateSent ?? 0)) * 1000) / (now - t.rateAt);
      t.bytesPerSec = t.bytesPerSec === undefined ? r : 0.7 * t.bytesPerSec + 0.3 * r;
      t.rateAt = now;
      t.rateSent = t.sent;
    }
  }

  // ---- engine events ----------------------------------------------------------------------------

  #onEvent(ev: EngineEvent): void {
    if (ev.source === 'sender') this.#onSender(ev);
    else if (ev.source === 'receiver') this.#onReceiver(ev);
    if (ev.source === 'mesh') this.#onMesh(ev);
    if (ev.source === 'guest') this.#onGuest(ev);
    if (ev.source === 'sync' && ev.type === 'round' && ev.conflicts > 0 && this.#settings.get().notifications) {
      this.#platform.notify('Sync conflict', `A file changed on both ${this.#aliasOf(ev.partner)} and here. Both versions are kept: look for "(conflict from …)" in the sync folder.`);
    }
    this.#changed();
  }

  #onGuest(ev: Extract<EngineEvent, { source: 'guest' }>): void {
    const s = this.#settings.get();
    if (ev.type === 'ended') this.#guestQr = undefined;
    if (ev.type === 'offer' && s.notifications) {
      const n = ev.files.length;
      const what = n > 0 ? `${n} file${n === 1 ? '' : 's'}${ev.text !== undefined ? ' and a message' : ''}` : 'a message';
      this.#platform.notify(ev.via === 'localsend' ? 'A LocalSend device wants to send' : 'A guest wants to send', `${what}: open MeshDrop to accept or decline.`);
    }
    if (ev.type === 'failed' && s.notifications) this.#platform.notify('A guest send could not be saved', `The files were uploaded but could not be saved (${ev.error}).`);
    if (ev.type === 'received') {
      const ls = ev.via === 'localsend';
      this.#history.addReceived({ at: Date.now(), from: ls ? 'localsend' : 'guest', alias: ls ? `${ev.alias ?? 'LocalSend'} (LocalSend)` : 'Guest', files: [...ev.files], ...(ev.text !== undefined ? { text: ev.text } : {}) });
      const first = ev.files[0];
      if (s.notifications) this.#platform.notify('From a guest', `${ev.files.length} file${ev.files.length === 1 ? '' : 's'} received`, first !== undefined ? () => this.#platform.revealPath(first) : undefined);
    }
  }

  #onMesh(ev: Extract<EngineEvent, { source: 'mesh' }>): void {
    if (ev.type === 'held-delivered' || ev.type === 'held-failed') void this.#refreshOutbox();
    if (!this.#settings.get().notifications) return;
    const to = ev.to !== undefined ? this.#aliasOf(ev.to) : 'a device';
    if (ev.type === 'held-delivered') this.#platform.notify('Delivered', `The hub delivered your files to ${to}.`);
    else if (ev.type === 'held-failed') this.#platform.notify('Delivery failed', `The hub could not deliver your files to ${to}${ev.error ? ` (${ev.error})` : ''}.`);
    else if (ev.type === 'revoked') this.#platform.notify('Removed from the mesh', 'The hub removed this device from the mesh.');
  }

  /**
   * The outgoing row an engine event belongs to: by the send()'s tag, else by session (a resume).
   * A resume gets a row on its first progress; a result for a session that never started (e.g.
   * "Resume all" for a device that is away) gets none.
   */
  #outRow(ev: { deviceId: string; sessionId: string; tag?: string }, create: boolean): Transfer | undefined {
    let key = ev.tag !== undefined ? this.#byTag.get(`${ev.deviceId}\0${ev.tag}`) : undefined;
    key ??= ev.sessionId ? this.#bySession.get(ev.sessionId) : undefined;
    let t = key !== undefined ? this.#transfers.get(key) : undefined;
    if (!t && create && ev.sessionId) {
      const ob = this.#outbox.find((o) => o.sessionId === ev.sessionId);
      t = this.#addTransfer({
        key: `${ev.deviceId}:${ev.sessionId}`, direction: 'out', deviceId: ev.deviceId, alias: this.#aliasOf(ev.deviceId),
        files: ob?.files ?? 0, bytes: ob?.bytes ?? 0, sent: 0, status: 'sending', startedAt: Date.now(),
      });
    }
    if (t && ev.sessionId && t.sessionId !== ev.sessionId) {
      t.sessionId = ev.sessionId;
      this.#bySession.set(ev.sessionId, t.key);
    }
    return t;
  }

  #onSender(ev: Extract<EngineEvent, { source: 'sender' }>): void {
    if (ev.type === 'progress') {
      const t = this.#outRow(ev, true)!;
      t.status = 'sending';
      t.done.set(ev.fileId, ev.sent);
      this.#sum(t);
      return;
    }
    const t = this.#outRow(ev, false);
    if (t) {
      t.status = ev.status;
      if (ev.status === 'done') t.sent = t.bytes;
      if (ev.error !== undefined) t.error = ev.error;
      else delete t.error;
    }
    void this.#refreshOutbox();
  }

  #failRows(rows: Transfer[], x: unknown): void {
    for (const t of rows) {
      if (t.status !== 'preparing' && t.status !== 'sending') continue;
      t.status = 'failed';
      t.error = x instanceof Error ? x.message : String(x);
    }
    this.#changed();
  }

  /** One 'preparing' row per target, tied to this send by `tag`. */
  #startRows(ids: string[], tag: string, files: number, bytes: number): Transfer[] {
    const startedAt = Date.now();
    const rows = ids.map((id) => {
      const tagKey = `${id}\0${tag}`;
      const t = this.#addTransfer({ key: `${id}:${tag}`, direction: 'out', deviceId: id, alias: this.#aliasOf(id), files, bytes, sent: 0, status: 'preparing', startedAt, tagKey });
      this.#byTag.set(tagKey, t.key);
      return t;
    });
    this.#changed();
    return rows;
  }

  #onReceiver(ev: Extract<EngineEvent, { source: 'receiver' }>): void {
    const key = `${ev.from}:${ev.sessionId}`;
    if (ev.type === 'offer') {
      const sizes = new Map(ev.manifest.files.map((f) => [f.fileId, f.size]));
      let bytes = 0;
      for (const v of sizes.values()) bytes += v;
      if (ev.manifest.text !== undefined) bytes += Buffer.byteLength(ev.manifest.text);
      this.#addTransfer({
        key, direction: 'in', deviceId: ev.from, alias: this.#aliasOf(ev.from),
        files: ev.manifest.files.length, bytes, sent: 0, status: 'receiving', startedAt: Date.now(),
      }, sizes);
      return;
    }
    const t = this.#transfers.get(key);
    if (ev.type === 'progress' && t) {
      const size = t.sizes.get(ev.fileId) ?? 0;
      t.done.set(ev.fileId, ev.total > 0 ? Math.min(size, ev.chunks * CHUNK_SIZE) : size);
      this.#sum(t);
    } else if (ev.type === 'file' && t) {
      t.done.set(ev.fileId, t.sizes.get(ev.fileId) ?? 0);
      this.#sum(t);
    } else if (ev.type === 'error' && t) {
      t.status = 'failed';
      t.error = ev.code;
    } else if (ev.type === 'cancelled' && t) {
      t.status = 'cancelled';
    } else if (ev.type === 'received') {
      if (t) {
        t.status = 'done';
        t.sent = t.bytes;
      }
      this.#received(ev);
    }
  }

  #received(ev: Extract<EngineEvent, { source: 'receiver'; type: 'received' }>): void {
    const s = this.#settings.get();
    const alias = this.#aliasOf(ev.from);
    this.#history.addReceived({
      at: Date.now(), from: ev.from, alias, files: [...ev.files],
      ...(ev.text !== undefined ? { text: ev.text } : {}),
      ...(ev.clipboard ? { clipboard: true } : {}),
    });
    // Clipboard text is only ever placed on the clipboard: never opened, run or interpreted.
    if (ev.clipboard && ev.text !== undefined && s.clipboardReceive) {
      this.#lastClip = ev.text; // shared clipboard: do not send it straight back
      this.#platform.writeClipboard(ev.text);
    }
    if (!s.notifications) return;
    const n = ev.files.length;
    if (ev.clipboard) {
      this.#platform.notify('Clipboard', s.clipboardReceive ? `Copied text from ${alias}` : `Text from ${alias} (see Inbox)`);
      return;
    }
    const body = n > 0 ? `${n} file${n === 1 ? '' : 's'} received${ev.text !== undefined ? ' with a message' : ''}` : `Text: ${(ev.text ?? "").slice(0, 120)}`;
    const first = ev.files[0];
    if (ev.backup) {
      this.#platform.notify(`Photo backup from ${alias}`, `${n} photo${n === 1 ? '' : 's'} or video${n === 1 ? '' : 's'} saved`, first !== undefined ? () => this.#platform.revealPath(first) : undefined);
      return;
    }
    this.#platform.notify(`From ${alias}`, body, first !== undefined ? () => this.#platform.revealPath(first) : undefined);
  }

  // ---- actions ----------------------------------------------------------------------------------

  /** Trusted devices currently reachable (what "all" means for a send). */
  #allTargets(): string[] {
    return this.#e.devices().filter((d) => d.trusted && d.reach !== 'offline').map((d) => d.deviceId);
  }

  #targets(targets: string[] | 'all'): string[] {
    const e = this.#e;
    const ids = targets === 'all' ? this.#allTargets() : [...new Set(targets.map((q) => e.resolveDeviceId(q)))];
    if (ids.length === 0) throw new Error('No trusted device is online. Pick a device: an offline one gets the send when it is back.');
    return ids;
  }

  async send(targets: string[] | 'all', items: SendItemInput[]): Promise<void> {
    // LocalSend apps take their own protocol (no outbox, no resume): one send each, reported by a toast.
    if (targets !== 'all') {
      const ls = new Set(this.#e.devices().filter((d) => d.role === 'localsend').map((d) => d.deviceId));
      const lsTargets = targets.filter((t) => ls.has(t));
      if (lsTargets.length > 0) {
        const paths = items.filter((it) => it.kind !== 'text').map((it) => it.path!);
        if (items.some((it) => it.kind === 'dir')) throw new Error('LocalSend devices take files and text, not folders.');
        const text = items.filter((it) => it.kind === 'text').map((it) => it.text!).join('\n\n');
        await Promise.all(lsTargets.map((fp) => this.#e.localsendSend(fp, { paths, ...(text ? { text } : {}) })));
        targets = targets.filter((t) => !ls.has(t));
        if (targets.length === 0) return;
      }
    }
    const ids = this.#targets(targets);
    for (const it of items) {
      if (it.kind === 'text' ? typeof it.text !== 'string' : typeof it.path !== 'string' || !isAbsolute(it.path)) throw new Error('Invalid item to send.');
    }
    const { files, bytes } = await measure(items);
    const tag = randomUUID();
    const rows = this.#startRows(ids, tag, files, bytes);
    const coreItems: SendItem[] = items.map((it) => (it.kind === 'text' ? { kind: 'text', text: it.text! } : { kind: it.kind, srcPath: it.path! }));
    this.#e.send(ids, coreItems, { tag }).catch((x: unknown) => this.#failRows(rows, x));
  }

  async sendClipboard(targets: string[] | 'all'): Promise<void> {
    const text = this.#platform.readClipboard();
    if (text === '') throw new Error('The clipboard is empty.');
    const ids = this.#targets(targets);
    const tag = randomUUID();
    const rows = this.#startRows(ids, tag, 0, Buffer.byteLength(text));
    this.#e.sendClipboard(ids, text, { tag }).catch((x: unknown) => this.#failRows(rows, x));
  }

  async resumeOutbox(): Promise<void> {
    this.#e.resumePending().catch(() => {}).finally(() => void this.#refreshOutbox());
  }

  async removeOutbox(sessionId: string): Promise<void> {
    await this.#e.removeOutbox(sessionId);
    await this.#refreshOutbox();
  }

  async unpair(deviceId: string): Promise<void> {
    await this.#e.unpair(deviceId);
    await this.#refreshOutbox();
    this.#changed();
  }

  async addByAddress(host: string, port: number, alias: string): Promise<void> {
    if (host.trim() === '') throw new Error('Enter an address.');
    await this.#e.pairManual(host.trim(), port, alias.trim() === '' ? host.trim() : alias);
    this.#changed();
  }

  /** A device seen at host:port (it shows as Nearby until paired). */
  async addNearby(host: string, port: number): Promise<void> {
    await this.#e.addNearby(host, port);
    this.#changed();
  }

  async scanSubnet(): Promise<number> {
    const n = await this.#e.scanSubnet();
    this.#changed();
    return n;
  }

  async hubInit(urls: string[]): Promise<void> {
    this.#notClientOnly();
    await this.#halt();
    try {
      const e = await Engine.create({ home: this.#home, ...this.#engineOptions, alias: this.#settings.get().alias });
      await e.hubInit(urls);
    } finally {
      await this.#boot();
    }
  }

  async setHubUrls(urls: string[]): Promise<void> {
    this.#notClientOnly();
    await this.#e.setHubUrls(urls);
    this.#changed();
  }

  // ---- LAN guests -------------------------------------------------------------------------------

  async guestStart(): Promise<{ url: string; qrSvg: string; expiresAt: number }> {
    this.#notClientOnly();
    const g = await this.#e.guestStart({ minutes: this.#settings.get().guestMinutes });
    this.#guestQr = g.qrSvg;
    this.#changed();
    return g;
  }

  async guestEnd(): Promise<void> {
    await this.#e.guestEnd();
    this.#guestQr = undefined;
    this.#changed();
  }

  async guestShare(paths: string[]): Promise<void> {
    await this.#e.guestShare(paths);
    this.#changed();
  }

  async guestUnshare(id: string): Promise<void> {
    this.#e.guestUnshare(id);
    this.#changed();
  }

  async guestAccept(id: string): Promise<void> {
    await this.#e.guestAccept(id);
    this.#changed();
  }

  async guestReject(id: string): Promise<void> {
    await this.#e.guestReject(id);
    this.#changed();
  }

  // ---- internet reach (hub PC) -------------------------------------------------------------------

  #syncView(e: Engine): SyncView {
    const st = e.syncStatus();
    return { folder: st.folder, suggested: join(homedir(), 'MeshDrop Sync'), partners: st.partners.map((p) => ({ ...p, ...(p.last ? { last: { ...p.last } } : {}) })) };
  }

  async syncSet(folder: string, partners: string[]): Promise<void> {
    this.#e.syncSet({ folder, partners });
    this.#changed();
  }

  async openSyncFolder(): Promise<void> {
    const f = this.#e.syncConfig().folder;
    if (f === '') throw new Error('Sync is off.');
    await this.#platform.openPath(f);
  }

  async syncNow(): Promise<void> {
    await this.#e.syncNow();
    this.#changed();
  }

  #reachView(e: Engine): ReachView | null {
    const r = e.reachStatus();
    if (!r) return null;
    const { detection, ...st } = r;
    const cfg = e.reachConfig();
    return {
      ...st,
      detection,
      config: { ...(cfg.cloudflareHost ? { cloudflareHost: cfg.cloudflareHost } : {}), ...(cfg.duckdnsDomain ? { duckdnsDomain: cfg.duckdnsDomain } : {}), ...(cfg.mapping ? { mapping: cfg.mapping } : {}) },
    };
  }

  async reachDetect(): Promise<void> {
    await this.#e.reachDetect();
    this.#changed();
  }

  async reachSet(input: ReachInput): Promise<void> {
    const { duckdnsToken, ...cfg } = input;
    try {
      await this.#e.reachSet(cfg, duckdnsToken !== undefined ? { duckdnsToken } : {});
    } finally {
      this.#changed();
    }
    const st = this.#e.reachStatus();
    if (st && (st.state === 'error' || st.state === 'missing' || st.state === 'logged-out')) throw new Error([st.error, st.fix].filter(Boolean).join(' — ') || st.state);
  }

  // ---- internet guest links (hub PC) -------------------------------------------------------------

  async #refreshLinks(): Promise<void> {
    const e = this.#engine;
    if (!e || e.hubStatus().role !== 'hub') return;
    try {
      this.#links = await e.linkList();
    } catch {
      return;
    }
    this.#changed();
  }

  async linkCreate(input: LinkCreateInput): Promise<{ id: string; url: string; qrSvg: string; expiresAt: number }> {
    const r = await this.#e.linkCreate(input);
    await this.#refreshLinks();
    if (!this.#linkTimer) {
      this.#linkTimer = setInterval(() => void this.#refreshLinks(), 30_000);
      this.#linkTimer.unref();
    }
    return r;
  }

  async linkRevoke(id: string): Promise<void> {
    await this.#e.linkRevoke(id);
    await this.#refreshLinks();
  }

  async createInvite(): Promise<{ uri: string; qrSvg: string; expiresAt: number }> {
    const { invite, uri } = this.#e.createInvite();
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { uri, qrSvg, expiresAt: invite.expiresAt };
  }

  async join(uri: string): Promise<'member' | 'provisional'> {
    const r = await this.#e.join(uri, this.#settings.get().alias);
    this.#changed();
    return r;
  }

  async revoke(deviceId: string): Promise<void> {
    this.#notClientOnly();
    await this.#e.revoke(deviceId);
    this.#changed();
  }

  async exportRecovery(path: string, passphrase: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error('Choose where to save the recovery file.');
    writeFileAtomic(path, this.#e.exportRecovery(passphrase));
  }

  async importRecovery(path: string, passphrase: string): Promise<void> {
    this.#notClientOnly();
    if (!isAbsolute(path)) throw new Error('Choose a recovery file.');
    if (statSync(path).size > MAX_RECOVERY_BYTES) throw new Error('That is not a MeshDrop recovery file.');
    const text = readFileSync(path, 'utf8');
    const e = this.#e;
    await e.stop();
    try {
      await e.importRecovery(text, passphrase);
    } finally {
      await e.start();
      this.#changed();
    }
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const prev = this.#settings.get();
    const next = this.#settings.preview(patch);
    const restart = ENGINE_KEYS.some((k) => next[k] !== prev[k]);
    if (restart && this.#mode === 'serving' && next.port !== prev.port && next.port !== 0 && next.port !== this.#engine?.port && !(await portFree(next.port))) {
      throw new SettingsError(`Port ${next.port} is in use by another program.`);
    }
    const hadError = this.#error !== undefined;
    this.#settings.set(patch);
    if (restart) {
      let failure: unknown;
      try {
        await this.#restart();
        // A port that was free a moment ago may be taken by now: the engine then started without receiving.
        if (!hadError && this.#error !== undefined) failure = new SettingsError(`Port ${next.port} is in use by another program.`);
      } catch (x) {
        failure = x;
      }
      if (failure !== undefined) {
        this.#settings.set(prev);
        await this.#restart();
        throw failure;
      }
    }
    this.#changed();
    return this.#settings.get();
  }

  async openInbox(): Promise<void> {
    const inbox = this.#settings.get().inbox;
    mkdirSync(inbox, { recursive: true });
    await this.#platform.openPath(inbox);
  }

  /** `path` if it is inside the inbox or the photo backup folder (only received files are shown, opened or previewed). */
  #inInbox(path: string): string {
    const p = resolve(path);
    const inside = (root: string) => {
      const rel = relative(resolve(root), p);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (!inside(this.#settings.get().inbox) && !(this.#engine && inside(this.#engine.backupDir))) throw new Error('Only received files can be shown.');
    return p;
  }

  async reveal(path: string): Promise<void> {
    this.#platform.revealPath(this.#inInbox(path));
  }

  /** Shared clipboard: newly copied text goes to every online trusted device, without rows or toasts. */
  #clipTick(): void {
    if (!this.#engine || this.#stopped) return;
    let text: string;
    try {
      text = this.#platform.readClipboard();
    } catch {
      return;
    }
    const first = this.#lastClip === undefined;
    if (text === this.#lastClip) return;
    this.#lastClip = text;
    // What was on the clipboard when MeshDrop started is not "newly copied"; nor is anything while sharing is off.
    if (first || !this.#settings.get().clipboardSync || text.trim() === '' || Buffer.byteLength(text) > MAX_CLIP_SYNC) return;
    const ls = new Set(this.#e.devices().filter((d) => d.role === 'localsend').map((d) => d.deviceId));
    const ids = this.#allTargets().filter((id) => !ls.has(id));
    if (ids.length > 0) this.#e.sendClipboard(ids, text).catch(() => {});
  }

  /** Files to put on the Send page (from `--send`): files and folders that exist. */
  addShared(paths: string[]): void {
    for (const p of paths) {
      let dir: boolean;
      try {
        dir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (!this.#shared.some((s) => s.path === p)) this.#shared.push({ kind: dir ? 'dir' : 'file', path: p });
    }
    this.#changed();
  }

  async takeSharedItems(): Promise<SendItemInput[]> {
    const out = this.#shared;
    this.#shared = [];
    this.#changed();
    return out;
  }

  async openFile(path: string): Promise<void> {
    await this.#platform.openPath(this.#inInbox(path));
  }

  async thumb(path: string): Promise<string | null> {
    return this.#platform.thumbnail(this.#inInbox(path)).catch(() => null);
  }

  async openConfigFolder(): Promise<void> {
    await this.#platform.openPath(this.#home);
  }
}
