// The desktop app's brain: owns the engine, turns its events into an AppState for the UI, and
// carries out every DesktopApi action. Electron-free (the Platform is injected), so it is tested
// directly in Node.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import QRCode from 'qrcode';
import { CHUNK_SIZE } from '@meshdrop/core/src/chunk.ts';
import { Engine, liveListener, type EngineEvent, type EngineOptions, type SendItem } from '@meshdrop/core/src/engine.ts';
import { loadOrCreateIdentity } from '@meshdrop/core/src/identity.ts';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';
import type { BtPlatform, LinkPolicy } from '@meshdrop/core/src/bt/links.ts';
import { a2dpStreams, type BluezPlatform, type BtAudioSource } from './bluetooth.ts';
import { BUTTONS, KEYSYMS, charKeysym } from './keys.ts';
import { ensureDir, land } from '@meshdrop/core/src/guest/uploads.ts';
import { cleanHandoff, handoffUrl, type HandoffState } from '@meshdrop/core/src/handoff.ts';
import type { AppState, NoWifiView, StreamKind, DeviceStatus, ReceivedRecord, DeviceView, PhoneNote, RemoteEvent, ScheduledView, SendOptions, GuestView, LinkCreateInput, LinkView, ReachInput, ReachView, SendItemInput, Settings, SyncView, TransferView } from '../shared/api.ts';
import type { HistoryStore } from './history.ts';
import { SettingsError, type SettingsStore } from './settings.ts';
import { liveAudio, liveRtp } from './liveaudio.ts';
import { opusChannels, opusDecoder, opusEncoder, opusLiveBytes, opusType } from './opus.ts';
import { HOTSPOT_HOST_IP, validHotspot, wifiQr, type NetMan } from './netman.ts';

export type ClipImage = { key: string; png: () => Buffer | Promise<Buffer> };

/** A background tick that threw: logged, and the timer keeps running. */
const tickFailed = (e: unknown) => console.error('meshdrop: background tick failed:', e);

export interface Platform {
  notify(title: string, body: string, onClick?: () => void): void;
  writeClipboard(text: string): void;
  /** Reads may be async: on Linux they run in a helper process (cliphelper.ts) and can fail or time out. */
  readClipboard(): string | Promise<string>;
  /** Files copied in a file manager (absolute paths of regular files), or []. */
  readClipboardFiles?(): string[] | Promise<string[]>;
  /** A copied image: a cheap key that changes with the picture, and its PNG bytes on demand. */
  readClipboardImage?(): ClipImage | null | Promise<ClipImage | null>;
  /** Puts received files on the clipboard: one image as an image, otherwise as copied files. */
  writeClipboardFiles?(paths: string[]): void;
  openPath(p: string): Promise<void>;
  revealPath(p: string): void;
  /** A small preview of an image or video as a data: URL, or null when there is none. */
  thumbnail(p: string): Promise<string | null>;
  /** M11: prints a file on the default printer. */
  print?(p: string): Promise<void>;
  /** M12: opens a page (the watch-party player) in its own window. */
  openWindow?(url: string): void;
  /** M13: the browser extension, copied where a browser (even a snap one) can load it; returns the folder. */
  extensionDir?(): Promise<string>;
  // ---- M10: remote control and friends (absent: not available on this platform) ----
  /** Low-level input (the RemoteDesktop portal); throws with a reason when there is none. */
  input?(events: InputPrim[]): Promise<void>;
  laser?(x: number, y: number, on: boolean): void;
  pcAction?(a: 'lock' | 'sleep' | 'shutdown' | 'restart'): Promise<void>;
  apps?(): Promise<{ id: string; name: string }[]>;
  openApp?(id: string): Promise<void>;
  ring?(on: boolean): void;
  openUrl?(url: string): Promise<void>;
  status?(): Promise<Omit<DeviceStatus, 'at'>>;
  /** M10b: this PC's sound as raw s16le 48 kHz stereo, until stop(). */
  captureAudio?(): MediaPipe;
  /** M10b: a virtual camera fed with JPEG frames (written back to back), until stop(). */
  cameraSink?(name: string): MediaPipe;
  /** M10b: a virtual microphone fed with s16le 48 kHz mono, until stop(). */
  micSink?(name: string): MediaPipe;
  /** Another device's sound (s16le 48 kHz stereo) out of this PC's speakers, until stop(). */
  speakerSink?(name: string): MediaPipe;
  /** Ends helpers the platform started (remote-input helper, laser window): called by stop(). */
  dispose?(): void;
}

/** A media helper process: read from `out` or write to `in`; stop() ends it. */
export interface MediaPipe {
  out?: NodeJS.ReadableStream;
  in?: NodeJS.WritableStream;
  stop(): void;
  onExit(cb: () => void): void;
}

/** What the input helper understands (see build/meshdrop-input.py). */
export type InputPrim =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'button'; button: number; down: boolean }
  | { t: 'axis'; dx: number; dy: number }
  | { t: 'key'; keysym: number; down: boolean };

const MAX_PHONE_NOTES = 50;
/** M11 burn after reading: deleted this long after the first open, or after a week unopened. */
const BURN_AFTER_OPEN_MS = 5 * 60_000;
const BURN_UNOPENED_MS = 7 * 86_400_000;
const M11_TICK_MS = 15_000;

/** M11 smart inbox: the folder a received file goes in. */
function inboxCategory(name: string): string {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const of: [string, string[]][] = [
    ['Images', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg', 'tif', 'tiff', 'avif']],
    ['Videos', ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', '3gp', 'mpg', 'mpeg']],
    ['Audio', ['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac', 'aac', 'oga']],
    ['Documents', ['pdf', 'doc', 'docx', 'odt', 'txt', 'md', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'csv', 'rtf', 'epub', 'html']],
    ['Archives', ['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2', 'zst', 'deb', 'apk', 'iso']],
  ];
  return of.find(([, exts]) => exts.includes(ext))?.[0] ?? 'Other';
}
const STATUS_POLL_MS = 60_000;
const RING_MAX_MS = 60_000;

/** Turns the Remote page's events into input primitives (unknown keys are skipped). */
export function toPrims(events: RemoteEvent[]): InputPrim[] {
  const out: InputPrim[] = [];
  const num = (v: unknown, lim: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);
  for (const e of events.slice(0, 500)) {
    switch (e?.t) {
      case 'move':
        out.push({ t: 'move', dx: num(e.dx, 2000), dy: num(e.dy, 2000) });
        break;
      case 'button':
      case 'click': {
        const button = BUTTONS[e.b];
        if (!button) break;
        if (e.t === 'button') out.push({ t: 'button', button, down: e.down === true });
        else out.push({ t: 'button', button, down: true }, { t: 'button', button, down: false });
        break;
      }
      case 'scroll':
        out.push({ t: 'axis', dx: num(e.dx, 500), dy: num(e.dy, 500) });
        break;
      case 'text':
        for (const ch of String(e.s).slice(0, 2000)) {
          const keysym = charKeysym(ch);
          out.push({ t: 'key', keysym, down: true }, { t: 'key', keysym, down: false });
        }
        break;
      case 'key': {
        // a named key, or one printable character (for shortcuts such as Control+c)
        const one = typeof e.k === 'string' && [...e.k].length === 1 && e.k >= ' ' ? charKeysym(e.k) : undefined;
        const keysym = Object.hasOwn(KEYSYMS, e.k) ? KEYSYMS[e.k] : one;
        if (keysym === undefined) break;
        const mods = (Array.isArray(e.mods) ? e.mods : []).map((m) => KEYSYMS[m]).filter((m): m is number => m !== undefined && [KEYSYMS.Shift, KEYSYMS.Control, KEYSYMS.Alt, KEYSYMS.Super].includes(m));
        for (const m of mods) out.push({ t: 'key', keysym: m, down: true });
        out.push({ t: 'key', keysym, down: true }, { t: 'key', keysym, down: false });
        for (const m of mods.reverse()) out.push({ t: 'key', keysym: m, down: false });
        break;
      }
    }
  }
  return out;
}

export interface ControllerOptions {
  home: string;
  settings: SettingsStore;
  history: HistoryStore;
  platform: Platform;
  engineOptions?: Partial<EngineOptions>;
  /** M14: this PC's Bluetooth (BlueZ); none: no Bluetooth links. With onAudio, phones playing their sound here as Bluetooth audio show under Live now. */
  bt?: BtPlatform & Partial<Pick<BluezPlatform, 'onAudio' | 'audioStop'>>;
  /** M14: NetworkManager for hotspots and the tether guard (Linux); gets the controller's change callback. */
  net?: (onChange: () => void) => NetMan;
  /** Tests: shorter M11 timings (burn after reading, the sweep, the time-capsule threshold). */
  timing?: { burnAfterOpenMs?: number; tickMs?: number; scheduleMinMs?: number };
}

/** M14: the engine's link policy from the No Wi-Fi settings. */
const linkPolicy = (s: Settings): LinkPolicy => ({ bluetooth: s.bluetooth, allBluetooth: s.allBluetooth, deviceLinks: s.deviceLinks });

/** Minimum gap between two 'state' events (so at most 10 progress updates per second). */
const STATE_INTERVAL_MS = 100;
const MAX_TRANSFERS = 100;
const RATE_WINDOW_MS = 500;
/** Shared clipboard: how often the clipboard is checked, and the most text it sends. */
const CLIP_POLL_MS = 1000;
const MAX_CLIP_SYNC = 64 * 1024;
/** Copied files are shared automatically only up to this much (Send clipboard sends any size). */
const MAX_CLIP_FILES_SYNC = 100 * 1024 * 1024;

/** What is on the clipboard now, as one comparable signature plus what to send. */
type ClipNow = { sig: string } & ({ kind: 'text'; text: string } | { kind: 'files'; files: string[] } | { kind: 'image'; png: ClipImage['png'] });
const MAX_RECOVERY_BYTES = 1024 * 1024;
/** Settings the engine is created with: changing one restarts it. */
const ENGINE_KEYS = ['alias', 'inbox', 'port', 'discovery', 'bluetooth'] as const;

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

/** Files that would run as a program when opened (by name, or by the executable bit). */
const RUNNABLE_EXT = /\.(desktop|sh|bash|zsh|run|bin|appimage|deb|rpm|snap|flatpak|exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|py|pl|rb|apk|lnk)$/i;
function runnable(p: string): boolean {
  if (RUNNABLE_EXT.test(p)) return true;
  try {
    return (statSync(p).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export class AppController extends EventEmitter {
  readonly #home: string;
  readonly #settings: SettingsStore;
  readonly #history: HistoryStore;
  readonly #platform: Platform;
  readonly #engineOptions: Partial<EngineOptions>;
  readonly #bt: ControllerOptions['bt'];
  /** Phones playing their sound here as Bluetooth audio (A2DP) now. */
  #btAudio: BtAudioSource[] = [];
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
  #lastJson = '';
  #stopped = false;
  #paused = false;
  /** The guest link's QR code (the engine keeps the rest of the session). */
  #guestQr: string | undefined;
  /** Shared clipboard: the poll, and the last text seen (copied here or received), so nothing echoes back. */
  #clipTimer: NodeJS.Timeout | null = null;
  /** A clipboard poll is reading (reads are async: a slow one is never overlapped). */
  #clipBusy = false;
  /** Bumped whenever MeshDrop itself writes the clipboard: a poll that read before then is stale. */
  #clipGen = 0;
  #lastClip: string | undefined;
  /** Files handed in from outside (Files → Send with MeshDrop), waiting for takeSharedItems(). */
  #shared: SendItemInput[] = [];
  /** The hub's internet links (refreshed on changes and every 30 s: download counts move on their own). */
  #links: LinkView[] = [];
  #phoneNotes: PhoneNote[] = [];
  #deviceStatus: Record<string, DeviceStatus> = {};
  #ringing: NodeJS.Timeout | null = null;
  #inputError: string | undefined;
  #statusTimer: NodeJS.Timeout | null = null;
  /** M11: time capsule (sends waiting for their time) and the burn-after-reading sweep. */
  #scheduled: (ScheduledView & { items: SendItemInput[] })[] = [];
  #m11Timer: NodeJS.Timeout | null = null;
  /** M10b: live streams now (PC sound to a phone, a phone's camera or microphone here). */
  #streams = new Map<string, { kind: StreamKind; peer: string; alias?: string; stop: () => void }>();
  #linkTimer: NodeJS.Timeout | null = null;

  constructor(opts: ControllerOptions) {
    super();
    this.#home = opts.home;
    this.#settings = opts.settings;
    this.#history = opts.history;
    this.#platform = opts.platform;
    this.#engineOptions = opts.engineOptions ?? {};
    this.#bt = opts.bt;
    this.#bt?.onAudio?.((s) => {
      this.#btAudio = s;
      this.#changed();
    });
    this.#net = opts.net?.(() => this.#changed());
    this.#timing = opts.timing ?? {};
  }

  readonly #timing: NonNullable<ControllerOptions['timing']>;
  readonly #net: NetMan | undefined;
  #hotspot: NoWifiView['hotspot'];
  #offer: NoWifiView['offer'];

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#boot();
    void this.#net?.guard.setEnabled(this.#settings.get().tetherNoData);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#linkTimer) clearInterval(this.#linkTimer);
    this.#linkTimer = null;
    if (this.#clipTimer) clearInterval(this.#clipTimer);
    this.#clipTimer = null;
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    this.#statusTimer = null;
    if (this.#m11Timer) clearInterval(this.#m11Timer);
    this.#m11Timer = null;
    if (this.#ringing) void this.ringStop();
    for (const st of this.#streams.values()) st.stop();
    this.#platform.dispose?.();
    this.#net?.guard.stop();
    if (this.#hotspot) await this.#net?.stop().catch(() => undefined); // a hotspot does not outlive the app
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
      // Only the serving engine owns the radio; Bluetooth off leaves it alone entirely.
      ...(serve && this.#bt && s.bluetooth ? { bt: { platform: this.#bt, policy: linkPolicy(s) } } : {}),
      ...this.#engineOptions,
    };
  }

  async #run(opts: EngineOptions): Promise<Engine> {
    const e = await Engine.create(opts);
    e.on('event', (ev: EngineEvent) => this.#onEvent(ev));
    e.setAppHandler((peer, msg) => this.#onApp(peer, msg));
    e.setStreamHandler((s) => this.#onStream(s));
    if (!this.#statusTimer) {
      this.#statusTimer = setInterval(() => void this.#pollStatus(), STATUS_POLL_MS);
      this.#statusTimer.unref();
    }
    if (!this.#m11Timer) {
      this.#loadScheduled();
      this.#m11Timer = setInterval(() => this.#m11Tick().catch(tickFailed), this.#timing.tickMs ?? M11_TICK_MS);
      this.#m11Timer.unref();
      this.#m11Tick().catch(tickFailed);
    }
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
      this.#recheck = setInterval(() => this.#checkListener().catch(tickFailed), LISTENER_RECHECK_MS);
      this.#recheck.unref();
    }
    void this.#refreshOutbox();
    void this.#refreshLinks();
    if (!this.#linkTimer) {
      this.#linkTimer = setInterval(() => void this.#refreshLinks(), 30_000);
      this.#linkTimer.unref();
    }
    if (!this.#clipTimer) {
      this.#clipTimer = setInterval(() => void this.#clipTick(), CLIP_POLL_MS);
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
      hub: { role: st.role, online: st.online, version: st.version, members: st.members, urls: st.urls, ingressPort: e.hubIngressPort, linkedTo: st.linkedTo ?? null, relayHub: st.relayHub === true },
      relays: e.relays(),
      devices: e.devices().map(({ lastSeen: _seen, ...d }): DeviceView => ({ ...d, self: false })), // lastSeen ticks with every announce; the UI shows none of it
      transfers: [...this.#transfers.values()].reverse().map(({ done: _d, sizes: _s, rateAt: _a, rateSent: _r, ...t }) => t),
      outbox: this.#outbox.map((o) => ({ ...o })),
      received: this.#history.received(),
      settings: this.#settings.get(),
      phoneNotes: this.#phoneNotes.map((n) => ({ ...n })),
      deviceStatus: { ...this.#deviceStatus },
      ringing: this.#ringing !== null,
      ...(this.#inputError ? { inputError: this.#inputError } : {}),
      handoff: { extension: this.#extensionOn, ...(this.#browser ? { page: { title: this.#browser.title ?? this.#browser.url, url: this.#browser.url } } : {}) },
      watch: e.watchList().map((w) => ({ ...w, ...(this.#watchHosts.has(w.code) ? { hostToken: this.#watchHosts.get(w.code)! } : {}) })),
      room: (() => {
        const r = e.roomState();
        return r.active && this.#roomQr ? { ...r, qrSvg: this.#roomQr } : r;
      })(),
      scheduled: this.#scheduled.map(({ items: _i, ...v }) => ({ ...v, targets: [...v.targets], aliases: [...v.aliases], names: [...v.names] })),
      streams: [
        ...[...this.#streams].map(([id, s]) => ({ id, kind: s.kind, peer: s.peer, ...(s.alias ? { alias: s.alias } : {}) })),
        ...a2dpStreams(this.#btAudio, (a) => e.btDevice(a), (id) => e.devices().find((d) => d.deviceId === id)?.alias),
      ],
      platform: 'desktop',
      ...(this.#shared.length > 0 ? { sharedPending: this.#shared.length } : {}),
      receiving: this.#mode === 'serving' && !this.#paused && this.#error === undefined,
      ...(this.#error !== undefined ? { error: this.#error } : {}),
      members: e.members().map((m) => ({ deviceId: m.deviceId, alias: m.alias, role: m.role, self: m.deviceId === me })),
      guest: this.#guestView(e),
      sync: this.#syncView(e),
      ...(st.role === 'hub' || st.role === 'member' ? { links: this.#links.map((l) => ({ ...l })) } : {}),
      ...(this.#reachView(e) ? { reach: this.#reachView(e)! } : {}),
      ...(this.#net ? { noWifi: { ...(this.#hotspot ? { hotspot: { ...this.#hotspot } } : {}), ...(this.#offer ? { offer: { ...this.#offer, hosts: [...this.#offer.hosts] } } : {}), guarded: this.#net.guard.guarded() } } : {}),
    };
  }

  #guestView(e: Engine): GuestView {
    const g = e.guestState();
    // offers through internet links and LocalSend come in with no guest QR open: keep them, or nobody can accept
    if (!g.active) return { active: false, available: g.available && this.#mode === 'serving', shared: [], offers: g.offers };
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

  /** Schedules a 'state' event: at most one per STATE_INTERVAL_MS, always carrying the latest state,
   *  and none when nothing changed (each one re-renders the whole window). */
  #changed(): void {
    if (this.#timer || this.#stopped) return;
    const wait = Math.max(0, this.#lastEmit + STATE_INTERVAL_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#engine) return;
      const s = this.state();
      const json = JSON.stringify(s);
      if (json === this.#lastJson) return;
      this.#lastJson = json;
      this.#lastEmit = Date.now();
      this.emit('state', s);
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
      this.#platform.notify('Sync conflict', `A file in "${ev.folder}" changed on both ${this.#aliasOf(ev.partner)} and here. Both versions are kept: look for "(conflict from …)".`);
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
    void this.#receivedAsync(ev);
  }

  async #receivedAsync(ev: Extract<EngineEvent, { source: 'receiver'; type: 'received' }>): Promise<void> {
    const s = this.#settings.get();
    const alias = this.#aliasOf(ev.from);
    // M11 smart inbox: files go in a folder by kind (not clipboard, backups or burn-after-reading files).
    if (s.sortInbox && !ev.clipboardFiles && !ev.backup && !ev.burn && ev.files.length > 0) {
      const inbox = this.#settings.get().inbox;
      const moved: string[] = [];
      for (const f of ev.files) {
        try {
          if (relative(inbox, f).includes(sep)) {
            moved.push(f); // inside a received folder: the folder stays together
            continue;
          }
          const dir = await ensureDir(inbox, [inboxCategory(f)]);
          moved.push(await land(f, dir, basename(f)));
        } catch {
          moved.push(f);
        }
      }
      ev = { ...ev, files: moved };
    }
    this.#history.addReceived({
      at: Date.now(), from: ev.from, alias, files: [...ev.files],
      ...(ev.text !== undefined ? { text: ev.text } : {}),
      ...(ev.clipboard || ev.clipboardFiles ? { clipboard: true } : {}),
      sessionId: ev.sessionId,
      ...(ev.burn ? { burn: true } : {}),
    });
    this.#changed();
    // M11 print from another device (only files; a program or script is never "printed").
    if (ev.print && ev.files.length > 0) {
      if (s.printFromDevices && this.#platform.print) {
        for (const f of ev.files) if (!runnable(f)) await this.#platform.print(f).catch(() => {});
        if (s.notifications) this.#platform.notify('Printing', `${ev.files.length} file${ev.files.length === 1 ? '' : 's'} from ${alias}`);
      } else if (s.notifications) this.#platform.notify('Not printed', `${alias} asked to print; printing from devices is off in Settings.`);
    }
    // Clipboard text is only ever placed on the clipboard: never opened, run or interpreted.
    if (ev.clipboard && ev.text !== undefined && s.clipboardReceive) {
      this.#platform.writeClipboard(ev.text);
      this.#clipGen++;
      this.#lastClip = `t:${ev.text}`; // shared clipboard: do not send it straight back
    }
    // Copied files / an image: saved in the inbox like any file, and put on the clipboard (never opened).
    if (ev.clipboardFiles && ev.files.length > 0 && s.clipboardReceive && this.#platform.writeClipboardFiles) {
      this.#platform.writeClipboardFiles([...ev.files]);
      const gen = ++this.#clipGen;
      const sig = (await this.#clipNow())?.sig;
      if (gen === this.#clipGen) this.#lastClip = sig;
    }
    if (!s.notifications) return;
    const n = ev.files.length;
    if (ev.clipboard) {
      this.#platform.notify('Clipboard', s.clipboardReceive ? `Copied text from ${alias}` : `Text from ${alias} (see Inbox)`);
      return;
    }
    if (ev.clipboardFiles) {
      const what = n === 1 ? (/\.(png|jpe?g|webp|gif|bmp)$/i.test(ev.files[0]!) ? 'an image' : 'a file') : `${n} files`;
      this.#platform.notify('Clipboard', s.clipboardReceive ? `Copied ${what} from ${alias}: paste it anywhere` : `${what} from ${alias} (see Received)`);
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

  async send(targets: string[] | 'all', items: SendItemInput[], opts: SendOptions = {}): Promise<void> {
    if (opts.at !== undefined && opts.at > Date.now() + (this.#timing.scheduleMinMs ?? 30_000)) {
      // M11 time capsule: kept here (paths, not copies) and sent at its time while the app runs.
      const ids = targets === 'all' ? this.#allTargets() : [...new Set(targets.map((q) => this.#e.resolveDeviceId(q)))];
      if (ids.length === 0) throw new Error('Pick a device.');
      if (opts.at > Date.now() + 366 * 86_400_000) throw new Error('Pick a time within a year.');
      this.#scheduled.push({
        id: randomUUID(), at: opts.at, targets: ids, aliases: ids.map((i) => this.#aliasOf(i)), items: items.map((i) => ({ ...i })),
        names: items.map((i) => (i.kind === 'text' ? 'Text' : basename(i.path!))),
        ...(opts.burn ? { burn: true } : {}), ...(opts.print ? { print: true } : {}),
      });
      this.#scheduled.sort((a, b) => a.at - b.at);
      this.#saveScheduled();
      this.#changed();
      return;
    }
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
    this.#e.send(ids, coreItems, { tag, ...(opts.burn ? { burn: true } : {}), ...(opts.print ? { print: true } : {}) }).catch((x: unknown) => this.#failRows(rows, x));
  }

  /** What is on the clipboard: copied files first, then an image, then text (null: nothing readable). */
  async #clipNow(): Promise<ClipNow | null> {
    try {
      const files = (await this.#platform.readClipboardFiles?.()) ?? [];
      if (files.length > 0) return { sig: `f:${files.join('\n')}`, kind: 'files', files };
      const img = (await this.#platform.readClipboardImage?.()) ?? null;
      if (img) return { sig: `i:${img.key}`, kind: 'image', png: img.png };
      const text = await this.#platform.readClipboard();
      return { sig: `t:${text}`, kind: 'text', text };
    } catch {
      return null;
    }
  }

  /** A copied image as a file to send (kept a day in <home>/clipboard). */
  #imageFile(png: Buffer): string {
    const dir = join(this.#home, 'clipboard');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const n of readdirSync(dir)) {
      try {
        if (Date.now() - statSync(join(dir, n)).mtimeMs > 86_400_000) rmSync(join(dir, n), { force: true });
      } catch {
        /* gone */
      }
    }
    const d = new Date();
    const p = (x: number) => String(x).padStart(2, '0');
    const file = join(dir, `Clipboard ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`);
    writeFileSync(file, png, { mode: 0o600 });
    return file;
  }

  async sendClipboard(targets: string[] | 'all'): Promise<void> {
    const now = await this.#clipNow();
    if (!now || (now.kind === 'text' && now.text === '')) throw new Error('The clipboard is empty.');
    const ids = this.#targets(targets);
    const tag = randomUUID();
    if (now.kind === 'text') {
      const rows = this.#startRows(ids, tag, 0, Buffer.byteLength(now.text));
      this.#e.sendClipboard(ids, now.text, { tag }).catch((x: unknown) => this.#failRows(rows, x));
      return;
    }
    const files = now.kind === 'files' ? now.files : [this.#imageFile(await now.png())];
    let bytes = 0;
    for (const f of files) bytes += statSync(f).size;
    const rows = this.#startRows(ids, tag, files.length, bytes);
    this.#e.sendClipboardFiles(ids, files, { tag }).catch((x: unknown) => this.#failRows(rows, x));
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

  async pairProbe(host: string, port: number): Promise<{ deviceId: string; alias: string; code: string }> {
    if (host.trim() === '') throw new Error('Enter an address.');
    return this.#e.pairProbe(host.trim(), port);
  }

  async addByAddress(host: string, port: number, alias: string, expectDeviceId?: string): Promise<void> {
    if (host.trim() === '') throw new Error('Enter an address.');
    await this.#e.pairManual(host.trim(), port, alias.trim() === '' ? host.trim() : alias, expectDeviceId);
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

  async relaysSet(relays: { deviceId: string; urls: string[] }[]): Promise<void> {
    this.#notClientOnly();
    await this.#e.relaysSet(relays.map((r) => ({ deviceId: r.deviceId, urls: r.urls.map((u) => u.trim()).filter(Boolean) })));
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
    const def = join(homedir(), 'MeshDrop Sync');
    return {
      folders: st.folders.map((f) => ({ ...f, partners: f.partners.map((p) => ({ ...p, ...(p.last ? { last: { ...p.last } } : {}) })) })),
      suggested: st.folders.some((f) => f.folder === def) ? '' : def,
    };
  }

  async syncPut(name: string, folder: string, partners: string[], previousName?: string): Promise<void> {
    this.#e.syncPut({ ...(name.trim() ? { name: name.trim() } : {}), folder, partners }, previousName);
    this.#changed();
  }

  async syncRemove(name: string): Promise<void> {
    this.#e.syncRemove(name);
    this.#changed();
  }

  async openSyncFolder(name: string): Promise<void> {
    const f = this.#e.syncConfig().folders.find((x) => x.name === name);
    if (!f) throw new Error('No such synced folder.');
    await this.#platform.openPath(f.folder);
  }

  async syncNow(name?: string): Promise<void> {
    await this.#e.syncNow(name);
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

  // ---- M10: app messages (remote control, ring, status, notifications, link handoff) -------------

  async #onApp(peer: string, raw: unknown): Promise<{ status: number; body: unknown }> {
    const msg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const s = this.#settings.get();
    const p = this.#platform;
    const may = s.remoteFrom.includes(peer);
    const alias = () => this.#e.devices().find((d) => d.deviceId === peer)?.alias;
    switch (msg.kind) {
      case 'input': {
        if (!may) return { status: 403, body: { error: 'remote-off' } };
        const events = Array.isArray(msg.events) ? (msg.events as RemoteEvent[]) : [];
        for (const e of events) if (e?.t === 'laser') p.laser?.(Number(e.x), Number(e.y), e.on === true);
        const prims = toPrims(events);
        if (prims.length === 0) return { status: 200, body: { ok: true } };
        if (!p.input) return { status: 503, body: { error: 'input-unavailable' } };
        try {
          await p.input(prims);
          if (this.#inputError) {
            this.#inputError = undefined;
            this.#changed();
          }
          return { status: 200, body: { ok: true } };
        } catch (e) {
          this.#inputError = e instanceof Error ? e.message : String(e);
          this.#changed();
          return { status: 503, body: { error: 'input-unavailable', reason: this.#inputError } };
        }
      }
      case 'action': {
        if (!may) return { status: 403, body: { error: 'remote-off' } };
        const a = msg.a;
        if (a === 'open') {
          if (typeof msg.app !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(msg.app) || !p.openApp) return { status: 400, body: { error: 'bad-app' } };
          await p.openApp(msg.app);
        } else if (a === 'lock' || a === 'sleep' || a === 'shutdown' || a === 'restart') {
          if (!p.pcAction) return { status: 501, body: { error: 'unsupported' } };
          await p.pcAction(a);
        } else return { status: 400, body: { error: 'bad-action' } };
        return { status: 200, body: { ok: true } };
      }
      case 'apps':
        if (!may) return { status: 403, body: { error: 'remote-off' } };
        return { status: 200, body: { apps: (await p.apps?.()) ?? [] } };
      case 'bt-audio-stop': {
        // a phone cannot drop its own A2DP link (privileged API), so it asks here; only its own sound
        if (!this.#bt?.audioStop) return { status: 501, body: { error: 'unsupported' } };
        const mine = this.#btAudio.filter((a) => this.#e.btDevice(a.address) === peer);
        if (mine.length === 0) return { status: 404, body: { error: 'not-playing' } };
        for (const a of mine) await this.#bt.audioStop(a.address);
        return { status: 200, body: { ok: true } };
      }
      case 'ring':
        if (msg.on === false) await this.ringStop();
        else this.#ring(alias());
        return { status: 200, body: { ok: true } };
      case 'status':
        return { status: 200, body: (await p.status?.()) ?? {} };
      case 'notify': {
        if (!s.phoneNotifications) return { status: 200, body: { ok: true, shown: false } };
        const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : '');
        const note: PhoneNote = {
          from: peer, key: str(msg.key, 300), app: str(msg.app, 100), title: str(msg.title, 200), text: str(msg.text, 2000),
          time: typeof msg.time === 'number' ? msg.time : Date.now(), replyable: msg.replyable === true,
          ...(alias() ? { fromAlias: alias()! } : {}),
        };
        if (!note.key) return { status: 400, body: { error: 'bad-note' } };
        this.#phoneNotes = [note, ...this.#phoneNotes.filter((n) => !(n.from === peer && n.key === note.key))].slice(0, MAX_PHONE_NOTES);
        if (s.notifications) p.notify(`${note.fromAlias ?? 'Phone'} · ${note.app || note.title}`, note.app ? `${note.title}: ${note.text}` : note.text);
        this.#changed();
        return { status: 200, body: { ok: true } };
      }
      case 'opened': {
        // M11 read receipt: the device opened what this one sent
        let any = false;
        for (const t of this.#transfers.values()) {
          if (t.direction === 'out' && t.deviceId === peer && t.sessionId === msg.sessionId && t.openedAt === undefined) {
            t.openedAt = Date.now();
            any = true;
          }
        }
        if (any) {
          if (s.notifications) p.notify('Opened', `${alias() ?? 'The device'} opened what you sent.`);
          this.#changed();
        }
        return { status: 200, body: { ok: true } };
      }
      case 'handoff-get': {
        // a phone picks up where the PC's browser is
        const b = await this.#browserNow();
        const url = b ? handoffUrl(b) : null;
        return url ? { status: 200, body: { url, title: b!.title ?? url } } : { status: 404, body: { error: 'nothing-open' } };
      }
      case 'handoff-open':
      case 'handoff':
        // a phone (or another PC) hands a page over
        if (!s.openLinks) return { status: 403, body: { error: 'handoff-off' } };
        return (await this.#handoffOpen(msg)) ? { status: 200, body: { ok: true } } : { status: 400, body: { error: 'bad-url' } };
      case 'watch-create': {
        // a phone hosts a watch party: the room lives on this PC (it has the ports and the bandwidth)
        if (this.#mode === 'client-only') return { status: 503, body: { error: 'unavailable' } };
        const r = this.#e.watchCreate(typeof msg.name === 'string' ? msg.name : `${alias() ?? 'Phone'}'s watch party`);
        this.#watchHosts.set(r.code, r.hostToken);
        this.#changed();
        return { status: 200, body: r };
      }
      case 'watch-end':
        if (typeof msg.code === 'string' && this.#watchHosts.has(msg.code)) await this.watchEnd(msg.code);
        return { status: 200, body: { ok: true } };
      case 'clipboard-get': {
        // M11 shake to grab: what is copied here goes to the asking device (devices allowed to control
        // this PC, or any of my devices while the shared clipboard is on)
        if (!may && !s.clipboardSync) return { status: 403, body: { error: 'clipboard-off' } };
        const img = await p.readClipboardImage?.();
        if (img) {
          const png = await img.png();
          if (png.length <= 4 * 1024 * 1024) return { status: 200, body: { image: png.toString('base64') } };
        }
        return { status: 200, body: { text: (await p.readClipboard()).slice(0, MAX_CLIP_SYNC) } };
      }
      case 'notify-removed':
        this.#phoneNotes = this.#phoneNotes.filter((n) => !(n.from === peer && n.key === msg.key));
        this.#changed();
        return { status: 200, body: { ok: true } };
      case 'open-url': {
        const url = typeof msg.url === 'string' ? msg.url : '';
        if (!s.openLinks) return { status: 403, body: { error: 'handoff-off' } };
        if (!/^https?:\/\/[^\s]{1,4000}$/i.test(url) || !p.openUrl) return { status: 400, body: { error: 'bad-url' } };
        await p.openUrl(url);
        return { status: 200, body: { ok: true } };
      }
      case 'hotspot': {
        // M14: a Bluetooth-linked device shares its hotspot. Joined right away only when this PC's Wi-Fi is free.
        if (!this.#net) return { status: 503, body: { error: 'hotspot-unavailable' } };
        const { ssid, psk } = msg;
        if (!validHotspot(ssid, psk)) return { status: 400, body: { error: 'bad-hotspot' } };
        const hosts = (Array.isArray(msg.hosts) ? msg.hosts : []).filter((h): h is string => typeof h === 'string' && /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(h)).slice(0, 4);
        const who = alias();
        this.#offer = { from: peer, ...(who ? { alias: who } : {}), ssid, psk: psk as string, hosts };
        this.#changed();
        void (async () => {
          const w = await this.#net!.wifi().catch(() => null);
          if (w && w.network === '' && !this.#hotspot) await this.hotspotJoin(ssid, psk as string, hosts).catch(() => undefined);
          else if (s.notifications) this.#platform.notify(`${who ?? 'A device'} shares a hotspot`, `Settings → No Wi-Fi: join ${ssid}.`);
        })();
        return { status: 200, body: { ok: true } };
      }
      default:
        return { status: 404, body: { error: 'unknown-kind' } };
    }
  }

  // ---- M14: hotspots ------------------------------------------------------------------------------

  #needNet(): NetMan {
    if (!this.#net) throw new Error('Hotspots need NetworkManager (nmcli) on this PC.');
    return this.#net;
  }

  /** Fails with "wifi-busy:<network>" when the Wi-Fi is on a network and the user has not agreed to leave it. */
  async #wifiFree(net: NetMan, leaveNetwork: boolean): Promise<void> {
    const w = await net.wifi();
    if (!w) throw new Error('This PC has no Wi-Fi.');
    if (w.network !== '' && !leaveNetwork) throw new Error(`wifi-busy:${w.network}`);
  }

  async hotspotStart(leaveNetwork = false): Promise<void> {
    const net = this.#needNet();
    await this.#wifiFree(net, leaveNetwork);
    const h = await net.host();
    const qrSvg = await QRCode.toString(wifiQr(h.ssid, h.psk), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    this.#hotspot = { role: 'host', ssid: h.ssid, psk: h.psk, qrSvg };
    this.#offer = undefined;
    this.#changed();
    const e = this.#e;
    const msg = { kind: 'hotspot', ssid: h.ssid, psk: h.psk, hosts: [`${HOTSPOT_HOST_IP}:${e.port}`] };
    for (const d of e.devices()) {
      if (await e.viaBluetooth(d.deviceId).catch(() => false)) void e.appSend(d.deviceId, msg).catch(() => undefined);
    }
  }

  async hotspotJoin(ssid: string, psk: string, hosts: string[] = [], leaveNetwork = false): Promise<void> {
    const net = this.#needNet();
    if (!validHotspot(ssid, psk)) throw new Error('Enter the hotspot name and its password (8 to 63 characters).');
    await this.#wifiFree(net, leaveNetwork);
    const offer = this.#offer?.ssid === ssid ? this.#offer : undefined;
    if (offer) {
      offer.joining = true;
      delete offer.error;
      this.#changed();
    }
    try {
      await net.join(ssid, psk);
    } catch (x) {
      if (offer) {
        offer.joining = false;
        offer.error = x instanceof Error ? x.message : String(x);
      }
      this.#changed();
      throw x;
    }
    this.#offer = undefined;
    this.#hotspot = { role: 'joined', ssid };
    this.#changed();
    // multicast may be isolated on a phone hotspot: try the addresses it sent as well
    for (const h of hosts.length > 0 ? hosts : (offer?.hosts ?? [])) {
      const i = h.lastIndexOf(':');
      void this.addNearby(h.slice(0, i), Number(h.slice(i + 1))).catch(() => undefined);
    }
  }

  async hotspotStop(): Promise<void> {
    const had = this.#hotspot !== undefined;
    this.#hotspot = undefined;
    this.#offer = undefined;
    this.#changed();
    if (had) await this.#needNet().stop();
  }

  /**
   * M10b live streams on the LAN server: GET audio (this PC's sound, for devices that may control it),
   * POST camera / mic (a phone's camera or microphone becomes a virtual device here).
   */
  #onStream(s: { peer: string; method: string; path: string; query?: URLSearchParams; req: import('node:http').IncomingMessage; res: import('node:http').ServerResponse }): boolean {
    const p = this.#platform;
    const alias = this.#e.devices().find((d) => d.deviceId === s.peer)?.alias;
    const deny = (status: number, error: string) => {
      s.res.writeHead(status, { 'content-type': 'application/json' });
      s.res.end(JSON.stringify({ error }));
      return true;
    };
    const kind = s.method === 'GET' && s.path === 'audio' ? 'audio' : s.method === 'POST' && (s.path === 'camera' || s.path === 'mic' || s.path === 'sound') ? s.path : null;
    if (!kind) return false;
    // this PC's sound, and sound played out of its speakers: only for devices allowed on the Remote page
    if ((kind === 'audio' || kind === 'sound') && !this.#settings.get().remoteFrom.includes(s.peer)) return deny(403, 'remote-off');
    // M14: video does not fit a Bluetooth link (the sender refuses first; this covers older ones)
    if (kind === 'camera' && this.#e.devices().find((d) => d.deviceId === s.peer)?.reach === 'bt') return deny(409, 'camera-needs-wifi');
    // M14: over Bluetooth sound goes as Opus: the phone asks for it (GET ?codec=opus) or sends it
    const opusOut = kind === 'audio' && s.query?.get('codec') === 'opus';
    const opusIn = kind === 'sound' || kind === 'mic' ? opusChannels(s.req.headers['content-type']) : null;
    const make = kind === 'audio' ? p.captureAudio : kind === 'camera' ? p.cameraSink : kind === 'mic' ? p.micSink : p.speakerSink;
    if (!make) return deny(501, 'unsupported');
    let pipe: MediaPipe;
    try {
      pipe = kind === 'audio' ? p.captureAudio!() : make.call(p, `${alias ?? 'Phone'}`);
    } catch (e) {
      return deny(503, e instanceof Error ? e.message : 'unavailable');
    }
    const bitrate = this.#settings.get().btSoundKbps * 1000;
    const codec = opusOut ? opusEncoder(2, { bitrate }) : opusIn ? opusDecoder(opusIn) : null;
    const id = randomUUID();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      pipe.stop();
      codec?.destroy();
      this.#streams.delete(id);
      if (!s.res.writableEnded) s.res.destroy();
      this.#changed();
    };
    codec?.on('error', end);
    this.#streams.set(id, { kind, peer: s.peer, ...(alias ? { alias } : {}), stop: end });
    pipe.onExit(end);
    // a finished Opus upload still has its tail in the decoder: that ends once the sink has it
    const flushing = () => opusIn !== null && s.req.complete;
    s.req.on('close', () => flushing() || end());
    s.res.on('close', () => flushing() || end());
    if (opusIn) pipe.in?.on('finish', end);
    if (kind === 'audio') {
      s.res.writeHead(200, { 'content-type': codec ? opusType(2) : 'audio/L16; rate=48000; channels=2', 'cache-control': 'no-store' });
      // over Bluetooth only 1 s of sound may queue ahead of the phone: newer frames are dropped
      // while the link is behind, so the sound stays live instead of falling seconds back
      const backlog = () => s.res.writableLength + (this.#e.btBacklog(s.peer, s.req.socket.remotePort) ?? 0);
      (codec ? pipe.out!.pipe(codec).pipe(liveRtp(backlog, opusLiveBytes(bitrate))) : pipe.out!).pipe(s.res);
    } else {
      // sound and microphone stay live: audio that piled up behind a Wi-Fi stall is dropped. Over
      // Bluetooth frames arrive in bunches after the link pauses for a moment, so 300 ms may queue there
      // (120 ms cut each bunch and broke the sound up); the phone drops frames before more piles up.
      const maxMs = opusIn ? 300 : 120;
      const live = kind === 'sound' ? liveAudio(192_000, 4, { maxMs }) : kind === 'mic' ? liveAudio(96_000, 2, { maxMs }) : null;
      const pcm = codec ? s.req.pipe(codec) : s.req;
      (live ? pcm.pipe(live) : pcm).pipe(pipe.in! as NodeJS.WritableStream);
      s.req.on('end', () => {
        if (!s.res.headersSent) s.res.writeHead(200, { 'content-type': 'application/json' });
        s.res.end('{"ok":true}');
      });
      if (this.#settings.get().notifications) {
        if (kind === 'sound') p.notify('Playing sound from another device', `${alias ?? 'A device'} plays its sound on this PC. Stop it on the Remote page.`);
        else p.notify(kind === 'camera' ? 'Phone camera connected' : 'Phone microphone connected', `${alias ?? 'Your phone'}: pick "${kind === 'camera' ? 'Phone camera' : 'Phone microphone'} (MeshDrop)" in your video or call app.`);
      }
    }
    this.#changed();
    return true;
  }

  async streamStop(id: string): Promise<void> {
    if (id.startsWith('bt-audio:')) return this.#bt?.audioStop?.(id.slice('bt-audio:'.length));
    this.#streams.get(id)?.stop();
  }

  /**
   * Sends this PC's sound to another device on the same Wi-Fi, where it plays (that device must allow
   * this PC on its Remote page). Resolves once it plays, or rejects when the device refuses.
   */
  async streamStart(deviceId: string, kind: 'sound'): Promise<void> {
    if (kind !== 'sound') throw new Error('unknown stream');
    const p = this.#platform;
    if (!p.captureAudio) throw new Error("This PC's sound cannot be captured here.");
    if ([...this.#streams.values()].some((s) => s.kind === 'sound-out' && s.peer === deviceId)) return;
    const alias = this.#e.devices().find((d) => d.deviceId === deviceId)?.alias;
    // M14: Opus over a Bluetooth link (raw PCM needs 1.5 Mbit/s)
    const codec = (await this.#e.viaBluetooth(deviceId)) ? opusEncoder(2, { bitrate: this.#settings.get().btSoundKbps * 1000 }) : null;
    const pipe = p.captureAudio();
    const abort = new AbortController();
    const id = randomUUID();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      pipe.stop();
      codec?.destroy();
      abort.abort();
      this.#streams.delete(id);
      this.#changed();
    };
    this.#streams.set(id, { kind: 'sound-out', peer: deviceId, ...(alias ? { alias } : {}), stop: end });
    pipe.onExit(end);
    this.#changed();
    const done = this.#e
      .streamPost(deviceId, 'sound', codec ? opusType(2) : 'audio/L16; rate=48000; channels=2', codec ? pipe.out!.pipe(codec) : (pipe.out as import('node:stream').Readable), abort.signal)
      .then((status) => (status === 403 ? `${alias ?? 'That device'} does not let this PC play there: on it, tick this PC on the Remote page.` : status === 501 ? `${alias ?? 'That device'} cannot play sound.` : null))
      .catch((e: unknown) => (ended ? null : e instanceof Error ? e.message : String(e)))
      .finally(end);
    // a refusal comes back at once; a stream that plays only ends when stopped
    const early = await Promise.race([done, new Promise<'playing'>((r) => setTimeout(() => r('playing'), 1500))]);
    if (early !== 'playing' && early) throw new Error(early);
  }

  #ring(from?: string): void {
    if (this.#ringing) clearTimeout(this.#ringing);
    this.#platform.ring?.(true);
    this.#platform.notify('Find my device', `${from ?? 'Your device'} is looking for this ${'PC'}.`);
    this.#ringing = setTimeout(() => void this.ringStop(), RING_MAX_MS);
    this.#changed();
  }

  async ringStop(): Promise<void> {
    if (this.#ringing) clearTimeout(this.#ringing);
    this.#ringing = null;
    this.#platform.ring?.(false);
    this.#changed();
  }

  async noteDismiss(key?: string): Promise<void> {
    this.#phoneNotes = key === undefined ? [] : this.#phoneNotes.filter((n) => n.key !== key);
    this.#changed();
  }

  /** Sends an app message to a paired device (the Remote page, Find my device, replies, handoff). */
  async appSend(deviceId: string, msg: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (typeof msg.kind !== 'string') throw new Error('bad message');
    const r = await this.#e.appSend(deviceId, msg);
    if (msg.kind === 'reply' && r.status === 200) this.#phoneNotes = this.#phoneNotes.filter((n) => !(n.from === deviceId && n.key === msg.key));
    if (msg.kind === 'status' && r.status === 200 && r.body && typeof r.body === 'object') {
      this.#deviceStatus = { ...this.#deviceStatus, [deviceId]: { ...(r.body as Omit<DeviceStatus, 'at'>), at: Date.now() } };
      this.#changed();
    }
    return r;
  }

  /** Asks reachable phones for battery, storage and signal (Devices shows it). */
  async #pollStatus(): Promise<void> {
    const e = this.#engine;
    if (!e || this.#stopped) return;
    for (const d of e.devices()) {
      if (!d.trusted || d.reach === 'offline' || d.deviceType !== 'mobile') continue;
      await this.appSend(d.deviceId, { kind: 'status' }).catch(() => {});
    }
  }

  // ---- internet guest links (made on the hub PC, or sealed here and served by the hub) ------------

  async #refreshLinks(): Promise<void> {
    const e = this.#engine;
    if (!e) return;
    const st = e.hubStatus();
    if (st.role !== 'hub' && !(st.role === 'member' && st.online)) return;
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

  /** `group`: one QR for all your devices (up to 20, 15 min); else single use (5 min). */
  async createInvite(group = false): Promise<{ uri: string; qrSvg: string; expiresAt: number }> {
    const { invite, uri } = this.#e.createInvite({ group });
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
    this.#engine?.setLinkPolicy(linkPolicy(this.#settings.get()));
    if (next.tetherNoData !== prev.tetherNoData) void this.#net?.guard.setEnabled(next.tetherNoData);
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

  /**
   * Shared clipboard: whatever is newly copied (text, an image, files from the file manager) goes to
   * every online trusted device, without rows or toasts.
   */
  async #clipTick(): Promise<void> {
    if (!this.#engine || this.#stopped || this.#clipBusy) return;
    this.#clipBusy = true;
    const gen = this.#clipGen;
    let now: ClipNow | null;
    try {
      now = await this.#clipNow();
    } finally {
      this.#clipBusy = false;
    }
    if (!now || gen !== this.#clipGen || !this.#engine || this.#stopped) return;
    const first = this.#lastClip === undefined;
    if (now.sig === this.#lastClip) return;
    this.#lastClip = now.sig;
    // What was on the clipboard when MeshDrop started is not "newly copied"; nor is anything while sharing is off.
    if (first || !this.#settings.get().clipboardSync) return;
    const ls = new Set(this.#e.devices().filter((d) => d.role === 'localsend').map((d) => d.deviceId));
    const ids = this.#allTargets().filter((id) => !ls.has(id));
    if (ids.length === 0) return;
    if (now.kind === 'text') {
      if (now.text.trim() === '' || Buffer.byteLength(now.text) > MAX_CLIP_SYNC) return;
      this.#e.sendClipboard(ids, now.text).catch(() => {});
      return;
    }
    let files: string[];
    try {
      files = now.kind === 'files' ? now.files : [this.#imageFile(await now.png())];
      let bytes = 0;
      for (const f of files) bytes += statSync(f).size;
      if (bytes > MAX_CLIP_FILES_SYNC) return; // big copies go with Send clipboard
    } catch {
      return;
    }
    this.#e.sendClipboardFiles(ids, files).catch(() => {});
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

  /**
   * Opens a received file with its app. A program or script someone sent is never started this way:
   * its folder opens with the file selected instead.
   */
  async openFile(path: string): Promise<void> {
    const p = this.#inInbox(path);
    this.#opened(p);
    if (runnable(p)) return this.#platform.revealPath(p);
    await this.#platform.openPath(p);
  }

  /** M11: the first open sends a read receipt and starts the burn-after-reading clock. */
  #opened(p: string): void {
    const now = Date.now();
    const hit = this.#history.update(
      (r) => r.files.includes(p) && r.openedAt === undefined,
      (r) => ({ openedAt: now, ...(r.burn ? { burnAt: now + (this.#timing.burnAfterOpenMs ?? BURN_AFTER_OPEN_MS) } : {}) }),
    );
    for (const r of hit) {
      if (this.#settings.get().sendReceipts && r.sessionId && /^[0-9a-f]{64}$/.test(r.from)) {
        void this.#e.appSend(r.from, { kind: 'opened', sessionId: r.sessionId }).catch(() => {});
      }
    }
    if (hit.length) this.#changed();
  }

  /** M11: deletes burned files whose time came, and sends scheduled sends whose time came. */
  async #m11Tick(): Promise<void> {
    const now = Date.now();
    // smart inbox clean-up (Settings): files received more than N days ago go (the record stays, marked)
    const days = this.#settings.get().cleanupDays;
    if (days > 0) {
      const old = (r: ReceivedRecord) => !r.burned && !r.cleaned && r.files.length > 0 && r.at + days * 86_400_000 <= now;
      const gone = this.#history.received().filter(old);
      for (const r of gone) for (const f of r.files) rmSync(f, { recursive: true, force: true });
      if (gone.length) {
        this.#history.update(old, () => ({ cleaned: true, files: [] }));
        this.#changed();
      }
    }
    const isDue = (r: { burn?: boolean; burned?: boolean; burnAt?: number; at: number }) => r.burn === true && !r.burned && ((r.burnAt !== undefined && r.burnAt <= now) || r.at + BURN_UNOPENED_MS <= now);
    const due = this.#history.received().filter(isDue);
    for (const r of due) for (const f of r.files) rmSync(f, { force: true });
    if (due.length) {
      this.#history.update(isDue, () => ({ burned: true, files: [], text: undefined }));
      this.#changed();
    }
    for (const job of this.#scheduled.filter((j) => j.at <= now)) {
      this.#scheduled = this.#scheduled.filter((j) => j !== job);
      this.#saveScheduled();
      try {
        await this.send(job.targets, job.items, { ...(job.burn ? { burn: true } : {}), ...(job.print ? { print: true } : {}) });
      } catch (e) {
        if (this.#settings.get().notifications) this.#platform.notify('Scheduled send failed', e instanceof Error ? e.message : String(e));
      }
      this.#changed();
    }
  }

  #scheduledFile(): string {
    return join(this.#home, 'scheduled.json');
  }

  #loadScheduled(): void {
    try {
      const j = JSON.parse(readFileSync(this.#scheduledFile(), 'utf8')) as unknown;
      if (Array.isArray(j)) this.#scheduled = j.filter((x) => x && typeof x.id === 'string' && typeof x.at === 'number' && Array.isArray(x.items) && Array.isArray(x.targets));
    } catch {
      this.#scheduled = [];
    }
  }

  #saveScheduled(): void {
    writeFileAtomic(this.#scheduledFile(), JSON.stringify(this.#scheduled));
  }

  // ---- M13 handoff (browser extension <-> phones) -----------------------------------------------

  #browser: HandoffState | null = null;
  #extSeen = 0;
  #extQueue: Record<string, unknown>[] = [];
  #extWaiters: ((c: Record<string, unknown>) => void)[] = [];
  #stateWaiters: (() => void)[] = [];

  get #extensionOn(): boolean {
    return Date.now() - this.#extSeen < 60_000;
  }

  /** The extension reports the active tab's place. */
  handoffState(raw: unknown): void {
    this.#extSeen = Date.now();
    const s = cleanHandoff(raw);
    if (s) this.#browser = s;
    for (const w of this.#stateWaiters.splice(0)) w();
    this.#changed();
  }

  /** The extension waits for its next command (or {} after `timeoutMs`). */
  handoffNextCommand(timeoutMs: number): Promise<Record<string, unknown>> {
    this.#extSeen = Date.now();
    const next = this.#extQueue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#extWaiters = this.#extWaiters.filter((w) => w !== done);
        resolve({});
      }, timeoutMs);
      const done = (c: Record<string, unknown>) => {
        clearTimeout(t);
        resolve(c);
      };
      this.#extWaiters.push(done);
    });
  }

  #toExtension(c: Record<string, unknown>): void {
    const w = this.#extWaiters.shift();
    if (w) w(c);
    else this.#extQueue = [...this.#extQueue.slice(-9), c];
  }

  /** Phones the extension's popup can send to. */
  handoffDevices(): { deviceId: string; alias: string }[] {
    const e = this.#engine;
    if (!e) return [];
    return e.devices().filter((d) => d.trusted && d.reach !== 'offline' && d.deviceType === 'mobile').map((d) => ({ deviceId: d.deviceId, alias: d.alias }));
  }

  /** "Continue on this phone": the page opens there at the same spot. */
  async handoffSend(to: string, raw?: unknown): Promise<boolean> {
    const s = raw === undefined ? this.#browser : cleanHandoff(raw);
    const url = s ? handoffUrl(s) : null;
    if (!url) throw new Error('No page to hand over: open it in your browser (with the MeshDrop extension).');
    const r = await this.#e.appSend(to, { kind: 'handoff', url, title: s!.title ?? url });
    return r.status === 200;
  }

  /** Where the browser is now: a fresh snapshot when the extension is there (it may lag a few seconds otherwise). */
  async #browserNow(): Promise<HandoffState | null> {
    if (this.#extensionOn) {
      const fresh = new Promise<void>((ok) => {
        this.#stateWaiters.push(ok);
        setTimeout(ok, 3000);
      });
      this.#toExtension({ type: 'snapshot' });
      await fresh;
    }
    return this.#browser && Date.now() - (this.#browser.at ?? 0) < 86_400_000 ? this.#browser : null;
  }

  /** A page from a phone opens here: through the extension (same scroll and video time) or the default browser. */
  async #handoffOpen(raw: unknown): Promise<boolean> {
    const s = cleanHandoff(raw);
    const url = s ? handoffUrl(s) : null;
    if (!s || !url) return false;
    if (this.#extensionOn) this.#toExtension({ type: 'open', url, ...(s.scroll !== undefined ? { scroll: s.scroll } : {}), ...(s.time !== undefined ? { time: s.time } : {}) });
    else if (this.#platform.openUrl) await this.#platform.openUrl(url);
    else return false;
    return true;
  }

  async handoffExtension(): Promise<string> {
    if (!this.#platform.extensionDir) throw new Error('The extension is not part of this build.');
    const dir = await this.#platform.extensionDir();
    this.#platform.revealPath(dir);
    return dir;
  }

  // ---- M12 watch party --------------------------------------------------------------------------

  /** Host keys of the rooms made here or for a phone (the host opens its room with #h=<key>). */
  #watchHosts = new Map<string, string>();

  async watchCreate(name: string): Promise<{ code: string; links: string[]; hostToken: string; qrSvg: string }> {
    this.#notClientOnly();
    const r = this.#e.watchCreate(name);
    this.#watchHosts.set(r.code, r.hostToken);
    this.#changed();
    return { ...r, qrSvg: r.links[0] ? await QRCode.toString(r.links[0], { type: 'svg', margin: 1 }) : '' };
  }

  async watchEnd(code: string): Promise<void> {
    await this.#e.watchEnd(code);
    this.#watchHosts.delete(code);
    this.#changed();
  }

  async watchPlayLocal(code: string, path: string): Promise<void> {
    await this.#e.watchPlayLocal(code, path);
  }

  async watchOpen(url: string): Promise<void> {
    if (!/^https?:\/\/[^\s]+\/w\/[A-Za-z0-9]{6}(#h=[A-Za-z0-9_-]+)?$/.test(url)) throw new Error('Not a watch-party link.');
    if (this.#platform.openWindow) this.#platform.openWindow(url);
    else await this.#platform.openUrl?.(url);
  }

  /** Finds a room by code: here, then the hub's internet address, then other MeshDrop PCs on this network. */
  async watchResolve(raw: string): Promise<string | null> {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('A room code has 6 letters or digits.');
    const e = this.#e;
    if (e.watch.get(code)) return e.watchLinks(code).at(-1) ?? e.watchLinks(code)[0] ?? null;
    const bases: string[] = [];
    for (const u of e.hubStatus().urls) {
      try {
        const p = new URL(u);
        bases.push(`${p.protocol === 'wss:' ? 'https:' : 'http:'}//${p.host}`);
      } catch {
        /* skip */
      }
    }
    for (const d of e.devices()) if (d.reach === 'lan' && d.host && d.deviceType !== 'mobile') bases.push(`http://${d.host.includes(':') ? `[${d.host}]` : d.host}:53320`);
    for (const b of bases) {
      try {
        const r = await fetch(`${b}/w/api/${code}`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) return `${b}/w/${code}`;
      } catch {
        /* not there */
      }
    }
    return null;
  }

  // ---- M11 room mode ----------------------------------------------------------------------------

  #roomQr: string | undefined;

  async roomStart(minutes: number, title: string): Promise<void> {
    this.#notClientOnly();
    this.#roomQr = (await this.#e.roomStart({ minutes, title })).qrSvg;
    this.#changed();
  }

  async roomEnd(): Promise<void> {
    await this.#e.roomEnd();
    this.#roomQr = undefined;
    this.#changed();
  }

  async roomPost(paths: string[]): Promise<void> {
    for (const p of paths) await this.#e.roomPost(p);
    this.#changed();
  }

  async roomSave(id: string): Promise<string> {
    const p = await this.#e.roomSave(id);
    if (this.#settings.get().notifications) this.#platform.notify('Saved from the room', basename(p), () => this.#platform.revealPath(p));
    return p;
  }

  async scheduleCancel(id: string): Promise<void> {
    this.#scheduled = this.#scheduled.filter((j) => j.id !== id);
    this.#saveScheduled();
    this.#changed();
  }

  async thumb(path: string): Promise<string | null> {
    return this.#platform.thumbnail(this.#inInbox(path)).catch(() => null);
  }

  async openConfigFolder(): Promise<void> {
    await this.#platform.openPath(this.#home);
  }
}
