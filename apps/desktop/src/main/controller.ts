// The desktop app's brain: owns the engine, turns its events into an AppState for the UI, and
// carries out every DesktopApi action. Electron-free (the Platform is injected), so it is tested
// directly in Node.
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import QRCode from 'qrcode';
import { CHUNK_SIZE } from '@meshdrop/core/src/chunk.ts';
import { Engine, type EngineEvent, type EngineOptions, type SendItem, type SendResult } from '@meshdrop/core/src/engine.ts';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';
import type { AppState, DeviceView, SendItemInput, Settings, TransferView } from '../shared/api.ts';
import type { HistoryStore } from './history.ts';
import { SettingsError, type SettingsStore } from './settings.ts';

export interface Platform {
  notify(title: string, body: string, onClick?: () => void): void;
  writeClipboard(text: string): void;
  readClipboard(): string;
  openPath(p: string): Promise<void>;
  revealPath(p: string): void;
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
const MAX_RECOVERY_BYTES = 1024 * 1024;
/** Settings the engine is created with: changing one restarts it. */
const ENGINE_KEYS = ['alias', 'inbox', 'port', 'discovery'] as const;

interface Transfer extends TransferView {
  /** Per-file bytes done (out: plaintext bytes; in: estimated from chunks). */
  done: Map<number, number>;
  sizes: Map<number, number>;
}

/** The `meshdrop listen` (or another app instance) serving this home: a live pid other than ours. */
function foreignListener(home: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(home, 'listen.pid'), 'utf8')) as { pid?: unknown };
    if (!Number.isInteger(j.pid) || (j.pid as number) <= 0 || j.pid === process.pid) return false;
    process.kill(j.pid as number, 0);
    return true;
  } catch {
    return false;
  }
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
  /** deviceId → key of the outgoing transfer currently running to it. */
  readonly #activeOut = new Map<string, string>();
  #outbox: AppState['outbox'] = [];
  #timer: NodeJS.Timeout | null = null;
  #lastEmit = 0;
  #stopped = false;

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
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#halt();
  }

  async #boot(): Promise<void> {
    const s = this.#settings.get();
    this.#mode = foreignListener(this.#home) ? 'client-only' : 'serving';
    const opts: EngineOptions = {
      home: this.#home,
      inbox: s.inbox,
      port: s.port,
      alias: s.alias,
      serve: this.#mode === 'serving',
      autoResume: true,
      ...(s.discovery ? {} : { discovery: false as const }),
      ...this.#engineOptions,
    };
    const e = await Engine.create(opts);
    e.on('event', (ev: EngineEvent) => this.#onEvent(ev));
    try {
      await e.start();
    } catch (x) {
      e.removeAllListeners('event');
      await e.stop();
      throw x;
    }
    this.#engine = e;
    if (this.#mode === 'serving') {
      writeFileSync(join(this.#home, 'listen.pid'), JSON.stringify({ pid: process.pid, port: e.port }), { mode: 0o600 });
      this.#ownsPid = true;
    }
    void this.#refreshOutbox();
    this.#changed();
  }

  async #halt(): Promise<void> {
    const e = this.#engine;
    this.#engine = null;
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
      self: { deviceId: me, alias: this.#settings.get().alias, port: e.port },
      mode: this.#mode,
      hub: { role: st.role, online: st.online, version: st.version, members: st.members, urls: st.urls, ingressPort: e.hubIngressPort },
      devices: e.devices().map((d): DeviceView => ({ ...d, self: false })),
      transfers: [...this.#transfers.values()].reverse().map(({ done: _d, sizes: _s, ...t }) => t),
      outbox: this.#outbox.map((o) => ({ ...o })),
      received: this.#history.received(),
      settings: this.#settings.get(),
      members: e.members().map((m) => ({ deviceId: m.deviceId, alias: m.alias, role: m.role, self: m.deviceId === me })),
    };
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
      this.#outbox = (await e.listOutbox()).map((o) => ({ sessionId: o.sessionId, deviceId: o.deviceId, ...(o.alias !== undefined ? { alias: o.alias } : {}), files: o.files, bytes: o.bytes }));
    } catch {
      return;
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
    while (this.#transfers.size > MAX_TRANSFERS) this.#transfers.delete(this.#transfers.keys().next().value!);
    return x;
  }

  #sum(t: Transfer): void {
    let n = 0;
    for (const v of t.done.values()) n += v;
    t.sent = Math.min(n, t.bytes || n);
  }

  // ---- engine events ----------------------------------------------------------------------------

  #onEvent(ev: EngineEvent): void {
    if (ev.source === 'sender') this.#onSender(ev);
    else if (ev.source === 'receiver') this.#onReceiver(ev);
    if (ev.source === 'mesh' && ev.type === 'held-delivered') void this.#refreshOutbox();
    this.#changed();
  }

  /** The outgoing transfer an event for `deviceId` belongs to (created for resumes the UI did not start). */
  #outFor(deviceId: string): Transfer {
    const key = this.#activeOut.get(deviceId);
    const cur = key ? this.#transfers.get(key) : undefined;
    if (cur && (cur.status === 'preparing' || cur.status === 'sending')) return cur;
    const startedAt = Date.now();
    const ob = this.#outbox.find((o) => o.deviceId === deviceId);
    const t = this.#addTransfer({
      key: `${deviceId}:${startedAt}`, direction: 'out', deviceId, alias: this.#aliasOf(deviceId),
      files: ob?.files ?? 0, bytes: ob?.bytes ?? 0, sent: 0, status: 'sending', startedAt,
    });
    this.#activeOut.set(deviceId, t.key);
    return t;
  }

  #onSender(ev: Extract<EngineEvent, { source: 'sender' }>): void {
    if (ev.type === 'progress') {
      const t = this.#outFor(ev.deviceId);
      t.status = 'sending';
      t.done.set(ev.fileId, ev.sent);
      this.#sum(t);
      return;
    }
    const t = this.#outFor(ev.deviceId);
    this.#finishOut(t, ev);
    void this.#refreshOutbox();
  }

  #finishOut(t: Transfer, r: SendResult): void {
    this.#activeOut.delete(t.deviceId);
    t.status = r.status;
    if (r.status === 'done') t.sent = t.bytes;
    if (r.error !== undefined) t.error = r.error;
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
    if (ev.clipboard && ev.text !== undefined && s.clipboardReceive) this.#platform.writeClipboard(ev.text);
    if (!s.notifications) return;
    const n = ev.files.length;
    const body = ev.clipboard
      ? s.clipboardReceive ? 'Clipboard received' : 'Clipboard text received (see Inbox)'
      : n > 0 ? `${n} file${n === 1 ? '' : 's'} received` : 'Text received';
    const first = ev.files[0];
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
    if (ids.length === 0) throw new Error('No trusted device is online.');
    return ids;
  }

  async send(targets: string[] | 'all', items: SendItemInput[]): Promise<void> {
    const ids = this.#targets(targets);
    for (const it of items) {
      if (it.kind === 'text' ? typeof it.text !== 'string' : typeof it.path !== 'string' || !isAbsolute(it.path)) throw new Error('Invalid item to send.');
    }
    const { files, bytes } = await measure(items);
    const startedAt = Date.now();
    const mine = ids.map((id) => {
      const t = this.#addTransfer({ key: `${id}:${startedAt}`, direction: 'out', deviceId: id, alias: this.#aliasOf(id), files, bytes, sent: 0, status: 'preparing', startedAt });
      this.#activeOut.set(id, t.key);
      return t;
    });
    this.#changed();
    const coreItems: SendItem[] = items.map((it) => (it.kind === 'text' ? { kind: 'text', text: it.text! } : { kind: it.kind, srcPath: it.path! }));
    this.#e.send(ids, coreItems).catch((x: unknown) => {
      for (const t of mine) if (t.status === 'preparing' || t.status === 'sending') this.#finishOut(t, { deviceId: t.deviceId, status: 'failed', sessionId: '', error: x instanceof Error ? x.message : String(x) });
      this.#changed();
    });
  }

  async sendClipboard(targets: string[] | 'all'): Promise<void> {
    const text = this.#platform.readClipboard();
    if (text === '') throw new Error('The clipboard is empty.');
    const ids = this.#targets(targets);
    const startedAt = Date.now();
    for (const id of ids) {
      const t = this.#addTransfer({ key: `${id}:${startedAt}`, direction: 'out', deviceId: id, alias: this.#aliasOf(id), files: 0, bytes: Buffer.byteLength(text), sent: 0, status: 'preparing', startedAt });
      this.#activeOut.set(id, t.key);
    }
    this.#changed();
    this.#e.sendClipboard(ids, text).catch(() => {});
  }

  async resumeOutbox(): Promise<void> {
    this.#e.resumePending().catch(() => {}).finally(() => void this.#refreshOutbox());
  }

  async removeOutbox(sessionId: string): Promise<void> {
    await this.#e.removeOutbox(sessionId);
    await this.#refreshOutbox();
  }

  async addByAddress(host: string, port: number, alias: string): Promise<void> {
    if (host.trim() === '') throw new Error('Enter an address.');
    await this.#e.pairManual(host.trim(), port, alias.trim() === '' ? host.trim() : alias);
    this.#changed();
  }

  async scanSubnet(): Promise<number> {
    const n = await this.#e.scanSubnet();
    this.#changed();
    return n;
  }

  async hubInit(urls: string[]): Promise<void> {
    await this.#halt();
    try {
      const e = await Engine.create({ home: this.#home, ...this.#engineOptions, alias: this.#settings.get().alias });
      await e.hubInit(urls);
    } finally {
      await this.#boot();
    }
  }

  async setHubUrls(urls: string[]): Promise<void> {
    await this.#e.setHubUrls(urls);
    this.#changed();
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
    await this.#e.revoke(deviceId);
    this.#changed();
  }

  async exportRecovery(path: string, passphrase: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error('Choose where to save the recovery file.');
    writeFileAtomic(path, this.#e.exportRecovery(passphrase));
  }

  async importRecovery(path: string, passphrase: string): Promise<void> {
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
    this.#settings.set(patch);
    if (restart) {
      try {
        await this.#restart();
      } catch (x) {
        this.#settings.set(prev);
        await this.#restart();
        const busy = (x as NodeJS.ErrnoException).code === 'EADDRINUSE';
        throw busy ? new SettingsError(`Port ${next.port} is in use by another program.`) : x;
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

  /** Shows a received file in the file manager (only files inside the inbox). */
  async reveal(path: string): Promise<void> {
    const inbox = resolve(this.#settings.get().inbox);
    const rel = relative(inbox, resolve(path));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Only received files can be shown.');
    this.#platform.revealPath(resolve(path));
  }

  async openConfigFolder(): Promise<void> {
    await this.#platform.openPath(this.#home);
  }
}
