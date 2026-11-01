// Electron entry: the main window, the clipboard picker and the tray over one app controller.
// Security: isolated, sandboxed renderers that can only call the DesktopApi (every argument
// type-checked here); no navigation, no new windows.
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { configDir } from '@meshdrop/core/src/paths.ts';
import type { EngineOptions } from '@meshdrop/core/src/engine.ts';
import type { AppState, LinkCreateInput, ReachInput, ReceivedRecord, SendItemInput, Settings } from '../shared/api.ts';
import { AppController, type Platform } from './controller.ts';
import { autostartDir, gnomeShortcutCommands, installNautilusScript, parseStrList, READ_KEYBINDINGS, sendArgs, setAutostart, validBinding } from './desktop.ts';
import { HistoryStore } from './history.ts';
import { Laser, mediaPlatform, remotePlatform } from './remote.ts';
import { gtkToAccelerator, parseFileNameW, printWin, savedShortcut, saveShortcut, winRemotePlatform, writeClipboardFilesWin } from './windows.ts';
import { setupPhones } from './phonesetup.ts';
import { onReplaced } from './selfupdate.ts';
import { HANDOFF_PORT, startHandoffServer } from './handoff.ts';
import { SettingsStore, defaultSettings } from './settings.ts';
import { bluezPlatform } from './bluetooth.ts';
import { CLIP_HELPER_ENV, ClipReader, runClipHelper } from './cliphelper.ts';
import { NetMan, run as nmRun } from './netman.ts';

const execFileP = promisify(execFile);
const TEST = process.env.MESHDROP_TEST === '1';
const WIN = process.platform === 'win32';
const APP_ID = 'io.github.hafijbge.meshdrop';
const HOME = process.env.MESHDROP_HOME ?? configDir();
const ICONS = join(__dirname, '../icons');
/** Set in the clipboard helper this app starts for itself on Linux (its Chromium profile dir). */
const CLIP_HELPER = process.env[CLIP_HELPER_ENV];
/** Linux: clipboard reads go through a helper process, so a slow clipboard owner never stalls this thread. */
const clipReader = process.platform === 'linux' && !CLIP_HELPER ? new ClipReader(ClipReader.self(join(HOME, 'clip-helper'))) : null;

// A stray rejected background promise is logged, not left to Node's default (which would end the app).
process.on('unhandledRejection', (e) => console.error('meshdrop: unhandled rejection:', e));

let win: BrowserWindow | null = null;
let picker: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: AppController | null = null;
let settings: SettingsStore | null = null;
let quitting = false;
/** MESHDROP_TEST only: what the next file picker returns (set by e2e through app.evaluate). */
let picked: string[] | null = null;

/** The command that starts this app (autostart, keyboard shortcut). */
function launchCommand(): string | string[] {
  return app.isPackaged ? process.execPath : [process.execPath, app.getAppPath()];
}

function makeWindow(opts: Electron.BrowserWindowConstructorOptions, hash?: string): BrowserWindow {
  const w = new BrowserWindow({
    ...opts,
    show: false,
    icon: join(ICONS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  if (!TEST) w.once('ready-to-show', () => w.show());
  void w.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : {});
  return w;
}

function showMain(): void {
  if (win && !win.isDestroyed()) {
    if (!TEST) win.show();
    win.focus();
    return;
  }
  win = makeWindow({ width: 980, height: 680, minWidth: 720, minHeight: 520, title: 'MeshDrop' });
  win.on('close', (e) => {
    // Closed to the tray: the window hides and MeshDrop keeps receiving.
    if (!quitting && tray && settings?.get().closeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

/** The small always-on-top clipboard sender (GNOME/Wayland lets only a focused window read the clipboard). */
function showPicker(): void {
  if (picker && !picker.isDestroyed()) {
    if (!TEST) picker.show();
    picker.focus();
    return;
  }
  picker = makeWindow({ width: 380, height: 460, title: 'Send clipboard', alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true }, 'picker');
  picker.on('closed', () => {
    picker = null;
  });
}

function quit(): void {
  quitting = true;
  app.quit();
}

function rebuildTray(): void {
  if (!tray) return;
  let st: AppState | null = null;
  try {
    st = controller?.state() ?? null;
  } catch {
    /* still starting */
  }
  const receiving = controller?.receiving ?? true;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open MeshDrop', click: showMain },
      { label: 'Send clipboard…', click: showPicker },
      { type: 'separator' },
      {
        label: receiving ? 'Pause receiving' : 'Resume receiving',
        enabled: st?.mode === 'serving' && st.error === undefined,
        click: () => void controller?.setReceiving(!receiving).finally(rebuildTray),
      },
      { type: 'separator' },
      { label: 'Quit', click: quit },
    ]),
  );
}

function createTray(): void {
  try {
    tray = new Tray(nativeImage.createFromPath(join(ICONS, 'tray.png')));
    tray.setToolTip('MeshDrop');
    tray.on('click', showMain);
    rebuildTray();
  } catch {
    tray = null; // no tray on this desktop: closing the window quits
  }
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const MAX_THUMB_SOURCE = 60 * 1024 * 1024;

/**
 * An image: scaled down here. Anything else (videos): the freedesktop thumbnail cache the file
 * manager fills (~/.cache/thumbnails), else what the OS gives (macOS/Windows), else null.
 */
async function thumbnailOf(p: string): Promise<string | null> {
  const small = (img: Electron.NativeImage) => (img.isEmpty() ? null : img.resize({ width: Math.min(192, img.getSize().width), quality: 'good' }).toDataURL());
  if (IMAGE_EXT.test(p) && statSync(p).size <= MAX_THUMB_SOURCE) return small(nativeImage.createFromPath(p));
  const md5 = createHash('md5').update(pathToFileURL(p).href).digest('hex');
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'thumbnails');
  for (const size of ['large', 'normal', 'x-large']) {
    const t = join(cache, size, `${md5}.png`);
    if (existsSync(t)) return small(nativeImage.createFromPath(t));
  }
  if (process.platform === 'linux') return null;
  return small(await nativeImage.createThumbnailFromPath(p, { width: 192, height: 192 }));
}

const platform: Platform = {
  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: join(ICONS, 'icon.png') });
    n.on('click', onClick ?? showMain); // a plain notification opens MeshDrop ("open MeshDrop to accept")
    n.show();
  },
  writeClipboard: (text) => clipboard.writeText(text),
  readClipboard: () => (clipReader?.usable ? clipReader.text() : clipboard.readText()),
  readClipboardFiles: async () => {
    if (WIN) {
      // Explorer's Copy: FileNameW names the first file (Electron cannot read the full CF_HDROP list)
      return parseFileNameW(clipboard.readBuffer('FileNameW')).filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
    }
    // availableFormats() does not list these on Linux, but readBuffer finds them (empty when absent).
    for (const f of ['x-special/gnome-copied-files', 'text/uri-list']) {
      const out: string[] = [];
      const buf = clipReader?.usable ? await clipReader.buffer(f) : clipboard.readBuffer(f);
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.startsWith('file://')) continue;
        try {
          const p = fileURLToPath(line.trim());
          if (statSync(p).isFile()) out.push(p);
        } catch {
          /* not a local file */
        }
      }
      if (out.length > 0) return out;
    }
    return [];
  },
  readClipboardImage: async () => {
    if (clipReader?.usable) {
      const key = await clipReader.image();
      return key === null ? null : { key, png: () => clipReader.png(key) };
    }
    if (!clipboard.availableFormats().some((f) => f.startsWith('image/'))) return null;
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return { key: createHash('sha1').update(img.toBitmap()).digest('hex'), png: () => img.toPNG() };
  },
  writeClipboardFiles: (paths) => {
    if (paths.length === 1 && IMAGE_EXT.test(paths[0]!)) {
      const img = nativeImage.createFromPath(paths[0]!);
      if (!img.isEmpty()) {
        clipboard.writeImage(img);
        return;
      }
    }
    if (WIN) return writeClipboardFilesWin(paths);
    // What GNOME Files (and most Linux file managers) paste as files.
    clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(['copy', ...paths.map((p) => pathToFileURL(p).href)].join('\n')));
  },
  async openPath(p) {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  },
  revealPath: (p) => shell.showItemInFolder(p),
  thumbnail: thumbnailOf,
  ...(WIN
    ? winRemotePlatform({
        // packaged: resources/meshdrop-input.ps1; from the source tree: build/
        script: app.isPackaged ? join(process.resourcesPath, 'meshdrop-input.ps1') : join(__dirname, '../../build/meshdrop-input.ps1'),
        inbox: () => ctl().state().settings.inbox,
        openUrl: (u) => shell.openExternal(u),
        openPath: async (p) => {
          const err = await shell.openPath(p);
          if (err) throw new Error(err);
        },
        laser: (() => {
          const l = new Laser();
          return (x: number, y: number, on: boolean) => l.show(x, y, on);
        })(),
      })
    : remotePlatform({
        home: HOME,
        // packaged: resources/meshdrop-input.py; from the source tree: build/
        script: app.isPackaged ? join(process.resourcesPath, 'meshdrop-input.py') : join(__dirname, '../../build/meshdrop-input.py'),
        inbox: () => ctl().state().settings.inbox,
        openUrl: (u) => shell.openExternal(u),
      })),
  // sound, camera and microphone go through PipeWire: Linux only for now (absent: the UI says so)
  ...(WIN ? {} : mediaPlatform()),
  openWindow: (url) => {
    // the watch-party player: an ordinary web page in its own window (no app powers)
    const w = new BrowserWindow({ width: 1280, height: 800, title: 'Watch party', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    w.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https:\/\//.test(u)) void shell.openExternal(u);
      return { action: 'deny' };
    });
    void w.loadURL(url);
  },
  extensionDir: async () => {
    // copied into Documents (where App Hub keeps it up to date too): a snap browser (Brave, Opera)
    // can read it there, not under /opt
    const src = app.isPackaged ? join(process.resourcesPath, 'browser-extension') : join(__dirname, '../../../browser-extension');
    const dest = join(app.getPath('documents'), 'MeshDrop Browser Extension');
    cpSync(src, dest, { recursive: true, force: true });
    return dest;
  },
  print: async (p) => {
    // received files are absolute paths in the inbox (never an option to lp)
    if (WIN) return isAbsolute(p) ? printWin(p) : Promise.reject(new Error('bad path'));
    if (!p.startsWith('/')) throw new Error('bad path');
    await execFileP('lp', [p], { timeout: 30_000 });
  },
};

// ---- IPC: argument checks -------------------------------------------------------------------------

class ArgError extends Error {}
const str = (x: unknown, max = 4096): string => {
  if (typeof x !== 'string' || x.length > max) throw new ArgError('invalid argument');
  return x;
};
const int = (x: unknown): number => {
  if (!Number.isInteger(x)) throw new ArgError('invalid argument');
  return x as number;
};
const strs = (x: unknown, max = 256): string[] => {
  if (!Array.isArray(x) || x.length > max) throw new ArgError('invalid argument');
  return x.map((s) => str(s));
};
const targets = (x: unknown): string[] | 'all' => (x === 'all' ? 'all' : strs(x));
const items = (x: unknown): SendItemInput[] => {
  if (!Array.isArray(x) || x.length === 0 || x.length > 10_000) throw new ArgError('invalid argument');
  return x.map((it: unknown): SendItemInput => {
    const o = (typeof it === 'object' && it !== null ? it : {}) as Record<string, unknown>;
    if (o.kind === 'text') return { kind: 'text', text: str(o.text, 1024 * 1024) };
    if (o.kind === 'file' || o.kind === 'dir') return { kind: o.kind, path: str(o.path) };
    throw new ArgError('invalid argument');
  });
};
const sendOpts = (x: unknown): { burn?: boolean; print?: boolean; at?: number } => {
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) throw new ArgError('invalid options');
  const o = x as Record<string, unknown>;
  if (o.at !== undefined && (typeof o.at !== 'number' || !Number.isFinite(o.at))) throw new ArgError('invalid time');
  return { ...(o.burn === true ? { burn: true } : {}), ...(o.print === true ? { print: true } : {}), ...(typeof o.at === 'number' ? { at: o.at } : {}) };
};
const SETTING_TYPES: Record<keyof Settings, 'string' | 'number' | 'boolean' | 'string[]' | 'links' | null> = {
  alias: 'string', inbox: 'string', port: 'number', discovery: 'boolean', autostart: 'boolean',
  startHidden: 'boolean', closeToTray: 'boolean', clipboardReceive: 'boolean', clipboardSync: 'boolean', notifications: 'boolean',
  guestMinutes: 'number', remoteFrom: 'string[]', openLinks: 'boolean', phoneNotifications: 'boolean', notifyTo: null,
  printFromDevices: 'boolean', sortInbox: 'boolean', sendReceipts: 'boolean', cleanupDays: 'number',
  bluetooth: 'boolean', allBluetooth: 'boolean', deviceLinks: 'links', tetherNoData: 'boolean', btSoundKbps: 'number',
};
const settingsPatch = (x: unknown): Partial<Settings> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new ArgError('invalid argument');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    const t = SETTING_TYPES[k as keyof Settings];
    if (t === 'string[]') {
      out[k] = strs(v, 64);
      continue;
    }
    if (t === 'links') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ArgError(`invalid setting ${k}`);
      out[k] = { ...v }; // ids and modes are checked by the settings store
      continue;
    }
    if (t === undefined || t === null || typeof v !== t) throw new ArgError(`invalid setting ${k}`);
    out[k] = v;
  }
  return out as Partial<Settings>;
};

const linkInput = (x: unknown): LinkCreateInput => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new ArgError('invalid argument');
  const o = x as Record<string, unknown>;
  const days = o.days;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 1 / 24 || days > 30) throw new ArgError('invalid link length');
  const max = o.maxDownloads;
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 1000)) throw new ArgError('invalid download limit');
  return {
    files: strs(o.files, 1000), days, allowUploads: o.allowUploads === true, autoAccept: o.allowUploads === true && o.autoAccept === true,
    ...(o.text !== undefined ? { text: str(o.text, 65536) } : {}),
    ...(o.password !== undefined && o.password !== '' ? { password: str(o.password, 1024) } : {}),
    ...(max !== undefined ? { maxDownloads: max as number } : {}),
  };
};

const reachInput = (x: unknown): ReachInput => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new ArgError('invalid argument');
  const o = x as Record<string, unknown>;
  if (!['off', 'tailscale', 'cloudflare', 'port-forward'].includes(o.mode as string)) throw new ArgError('invalid mode');
  return {
    mode: o.mode as ReachInput['mode'],
    ...(o.cloudflareHost !== undefined ? { cloudflareHost: str(o.cloudflareHost, 253) } : {}),
    ...(o.duckdnsDomain !== undefined ? { duckdnsDomain: str(o.duckdnsDomain, 80) } : {}),
    ...(o.duckdnsToken !== undefined && o.duckdnsToken !== '' ? { duckdnsToken: str(o.duckdnsToken, 64) } : {}),
    ...(o.mapping === 'manual' || o.mapping === 'auto' ? { mapping: o.mapping } : {}),
  };
};

/** Windows: the "send clipboard" shortcut, held by this process (replaces the one held before). */
function registerWinShortcut(binding: string, strict: boolean): void {
  const accel = gtkToAccelerator(binding);
  globalShortcut.unregisterAll();
  if (!globalShortcut.register(accel, showPicker) && strict) throw new Error(`${accel} is already used by another app. Try another shortcut.`);
}

function ctl(): AppController {
  if (!controller) throw new Error('MeshDrop is still starting');
  return controller;
}

/** The window an IPC call came from (dialogs attach to it). */
const owner = (e: IpcMainInvokeEvent): BrowserWindow => BrowserWindow.fromWebContents(e.sender)!;

function wireIpc(): void {
  const handle = (name: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(`meshdrop:${name}`, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      const ours = [win, picker].some((w) => w && !w.isDestroyed() && e.sender === w.webContents);
      if (!ours) throw new Error('unknown sender');
      return fn(e, ...args);
    });
  };
  handle('getState', (_e) => ctl().state());
  handle('pickFiles', async (e) => {
    if (TEST && picked) {
      const p = picked;
      picked = null;
      return p;
    }
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('pickFolder', async (e) => {
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('pickSavePath', async (e, name) => {
    const r = await dialog.showSaveDialog(owner(e), { defaultPath: str(name, 255) });
    return r.canceled ? null : (r.filePath ?? null);
  });
  handle('pickOpenPath', async (e) => {
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openFile'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('send', (_e, t, i, o) => ctl().send(targets(t), items(i), sendOpts(o)));
  handle('scheduleCancel', (_e, id) => ctl().scheduleCancel(str(id, 64)));
  handle('roomStart', (_e, m, t) => ctl().roomStart(int(m), str(t, 80)));
  handle('roomEnd', () => ctl().roomEnd());
  handle('roomPost', (_e, ps) => ctl().roomPost(strs(ps, 100)));
  handle('roomSave', (_e, id) => ctl().roomSave(str(id, 32)));
  handle('saveBlob', (_e, name, b64) => {
    // a voice note recorded in the window: saved under the config folder, then sent like any file
    const n = str(name, 100).replace(/[^A-Za-z0-9._ -]/g, '_');
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(n)) throw new ArgError('invalid name');
    const data = Buffer.from(str(b64, 40 * 1024 * 1024), 'base64');
    const dir = join(HOME, 'voice-notes');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, n);
    writeFileSync(p, data, { mode: 0o600 });
    return p;
  });
  handle('sendClipboard', (_e, t) => ctl().sendClipboard(targets(t)));
  handle('resumeOutbox', (_e) => ctl().resumeOutbox());
  handle('removeOutbox', (_e, id) => ctl().removeOutbox(str(id, 128)));
  handle('pairProbe', (_e, h, p) => ctl().pairProbe(str(h, 255), int(p)));
  handle('appSend', (_e, id, msg) => {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || JSON.stringify(msg).length > 200_000) throw new ArgError('invalid message');
    return ctl().appSend(str(id, 64), msg as Record<string, unknown>);
  });
  handle('ringStop', () => ctl().ringStop());
  handle('handoffSend', (_e, id) => ctl().handoffSend(str(id, 64)).then(() => undefined));
  handle('handoffExtension', () => ctl().handoffExtension());
  handle('watchCreate', (_e, n) => ctl().watchCreate(str(n, 60)));
  handle('watchResolve', (_e, c) => ctl().watchResolve(str(c, 10)));
  handle('watchOpen', (_e, u) => ctl().watchOpen(str(u, 2048)));
  handle('watchEnd', (_e, c) => ctl().watchEnd(str(c, 6)));
  handle('watchPlayLocal', (_e, c, p) => ctl().watchPlayLocal(str(c, 6), str(p)));
  handle('setupPhones', () => setupPhones());
  handle('streamStop', (_e, id) => ctl().streamStop(str(id, 64)));
  handle('streamStart', (_e, id, kind) => {
    if (kind !== 'sound') throw new ArgError('unknown stream');
    return ctl().streamStart(str(id, 64), 'sound');
  });
  handle('hotspotStart', (_e, leave) => ctl().hotspotStart(leave === true));
  handle('hotspotJoin', (_e, ssid, psk, hosts, leave) =>
    ctl().hotspotJoin(str(ssid, 64), str(psk, 64), Array.isArray(hosts) ? hosts.slice(0, 4).map((h) => str(h, 64)) : [], leave === true));
  handle('hotspotStop', () => ctl().hotspotStop());
  handle('wifiList', () => ctl().wifiList());
  handle('wifiCopy', (_e, id) => ctl().wifiCopy(str(id, 128)));
  handle('wifiQr', (_e, id) => ctl().wifiQr(str(id, 128)));
  handle('wifiShare', (_e, id) => ctl().wifiShare(str(id, 128)));
  handle('wifiSyncNow', () => ctl().wifiSyncNow());
  handle('noteDismiss', (_e, k) => ctl().noteDismiss(k === undefined ? undefined : str(k, 300)));
  handle('addByAddress', (_e, h, p, a, id) => ctl().addByAddress(str(h, 255), int(p), str(a, 64), id === undefined ? undefined : str(id, 128)));
  handle('scanSubnet', (_e) => ctl().scanSubnet());
  handle('hubInit', (_e, u) => ctl().hubInit(strs(u, 16)));
  handle('setHubUrls', (_e, u) => ctl().setHubUrls(strs(u, 16)));
  handle('relaysSet', (_e, rs) => {
    if (!Array.isArray(rs) || rs.length > 8) throw new Error('bad relay list');
    return ctl().relaysSet(rs.map((r: unknown) => ({ deviceId: str((r as { deviceId?: unknown })?.deviceId, 64), urls: strs((r as { urls?: unknown })?.urls, 4) })));
  });
  handle('createInvite', async (_e, group) => {
    const r = await ctl().createInvite(group === true);
    // MESHDROP_TEST only: a short countdown so e2e can watch an invite expire (the core invite keeps its 5 min).
    const ttl = TEST ? Number(process.env.MESHDROP_TEST_INVITE_TTL_MS) : NaN;
    return Number.isFinite(ttl) && ttl > 0 ? { ...r, expiresAt: Date.now() + ttl } : r;
  });
  handle('join', (_e, u) => ctl().join(str(u)));
  handle('revoke', (_e, id) => ctl().revoke(str(id, 64)));
  handle('exportRecovery', (_e, p, pw) => ctl().exportRecovery(str(p), str(pw, 1024)));
  handle('importRecovery', (_e, p, pw) => ctl().importRecovery(str(p), str(pw, 1024)));
  handle('setSettings', async (_e, p) => {
    const before = ctl().state().settings;
    const s = await ctl().setSettings(settingsPatch(p));
    if (s.autostart !== before.autostart) {
      // Windows: the Run key of this user (Task Manager → Startup apps lists it)
      if (WIN && !TEST) app.setLoginItemSettings({ openAtLogin: s.autostart, args: ['--hidden'] });
      else setAutostart(s.autostart, launchCommand(), TEST ? join(HOME, 'autostart') : autostartDir());
    }
    rebuildTray();
    return s;
  });
  handle('guestStart', (_e) => ctl().guestStart());
  handle('guestEnd', (_e) => ctl().guestEnd());
  handle('guestShare', (_e, p) => ctl().guestShare(strs(p, 1000)));
  handle('guestUnshare', (_e, id) => ctl().guestUnshare(str(id, 64)));
  handle('guestAccept', (_e, id) => ctl().guestAccept(str(id, 64)));
  handle('guestReject', (_e, id) => ctl().guestReject(str(id, 64)));
  handle('linkCreate', (_e, x) => ctl().linkCreate(linkInput(x)));
  handle('linkRevoke', (_e, id) => ctl().linkRevoke(str(id, 64)));
  handle('reachDetect', (_e) => ctl().reachDetect());
  handle('reachSet', (_e, x) => ctl().reachSet(reachInput(x)));
  handle('syncPut', (_e, n, f, p, prev) => ctl().syncPut(str(n, 64), str(f), strs(p, 64), prev === undefined || prev === null ? undefined : str(prev, 64)));
  handle('syncRemove', (_e, n) => ctl().syncRemove(str(n, 64)));
  handle('syncNow', (_e, n) => ctl().syncNow(n === undefined || n === null ? undefined : str(n, 64)));
  handle('openSyncFolder', (_e, n) => ctl().openSyncFolder(str(n, 64)));
  handle('openInbox', (_e) => ctl().openInbox());
  handle('reveal', (_e, p) => ctl().reveal(str(p)));
  handle('unpair', (_e, id) => ctl().unpair(str(id, 64)));
  handle('takeSharedItems', (_e) => ctl().takeSharedItems());
  handle('openFile', (_e, p) => ctl().openFile(str(p)));
  handle('thumb', (_e, p) => ctl().thumb(str(p)));
  handle('registerClipboardShortcut', async (_e, b) => {
    const binding = str(b, 64);
    if (!validBinding(binding)) throw new Error('That is not a valid shortcut (example: <Primary><Alt>c).');
    if (TEST) throw new Error('not in tests');
    if (WIN) {
      // no desktop settings to write to: MeshDrop holds the shortcut itself while it runs
      registerWinShortcut(binding, true);
      saveShortcut(HOME, binding);
      return;
    }
    const { stdout } = await execFileP(READ_KEYBINDINGS[0]!, READ_KEYBINDINGS.slice(1));
    for (const [cmd, ...args] of gnomeShortcutCommands(binding, launchCommand(), parseStrList(stdout))) await execFileP(cmd!, args);
  });
  handle('openConfigFolder', (_e) => ctl().openConfigFolder());
}

/**
 * The at-rest seal for the Wi-Fi saved-networks store, backed by the OS keyring through Electron's
 * safeStorage. A tag ("MDS1") prefixes the ciphertext so `open` can tell a sealed file from a plaintext
 * one and stay compatible either way. Returns undefined when no keyring is available (an unlocked login
 * keyring on Linux, the Keychain on macOS, DPAPI on Windows); the store then falls back to plaintext at
 * mode 0600 — the same at-rest posture as this device's own private key and trust store.
 */
function buildWifiSeal(): { seal(plaintext: string): Buffer; open(data: Buffer): string } | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
  } catch {
    return undefined;
  }
  const TAG = Buffer.from('MDS1');
  return {
    seal: (plaintext: string) => Buffer.concat([TAG, safeStorage.encryptString(plaintext)]),
    open: (data: Buffer) =>
      data.length >= TAG.length && data.subarray(0, TAG.length).equals(TAG)
        ? safeStorage.decryptString(data.subarray(TAG.length))
        : data.toString('utf8'),
  };
}

async function startController(): Promise<void> {
  const history = new HistoryStore(join(HOME, 'desktop-history.json'));
  // MESHDROP_GUEST_PORT moves the LAN guest server off 53320 (e2e uses 0: any free port).
  const guestPort = process.env.MESHDROP_GUEST_PORT !== undefined ? Number(process.env.MESHDROP_GUEST_PORT) : undefined;
  const engineOptions: EngineOptions = guestPort !== undefined && Number.isInteger(guestPort) && guestPort >= 0 && guestPort <= 65535 ? { guest: { port: guestPort } } : {};
  // MESHDROP_INGRESS_PORT moves the hub's tunnel ingress off 53319 (e2e: 0, next to a real hub).
  const ingress = process.env.MESHDROP_INGRESS_PORT !== undefined ? Number(process.env.MESHDROP_INGRESS_PORT) : undefined;
  if (ingress !== undefined && Number.isInteger(ingress) && ingress >= 0 && ingress <= 65535) engineOptions.hub = { ingressPort: ingress };
  // M14: Bluetooth links through BlueZ (Linux; e2e tests run without a radio)
  const bt = WIN || TEST ? undefined : bluezPlatform({ script: app.isPackaged ? join(process.resourcesPath, 'meshdrop-bt.py') : join(__dirname, '../../build/meshdrop-bt.py') });
  // M14: hotspots and the tether guard through NetworkManager (Linux desktops)
  const net = process.platform === 'linux' && !TEST ? (onChange: () => void) => new NetMan(nmRun, onChange) : undefined;
  const wifiSeal = buildWifiSeal();
  controller = new AppController({ home: HOME, settings: settings!, history, platform, engineOptions, ...(bt ? { bt } : {}), ...(net ? { net } : {}), ...(wifiSeal ? { wifiSeal } : {}) });
  if (TEST) {
    // Test-only hooks, reachable from Playwright's app.evaluate (main process), never from the page.
    (globalThis as { __meshdropTest?: unknown }).__meshdropTest = {
      setPicked: (p: string[]) => {
        picked = p;
      },
      addNearby: (host: string, port: number) => controller!.addNearby(host, port),
      seedHistory: (r: ReceivedRecord) => {
        history.addReceived(r);
        controller?.refresh();
      },
    };
  }
  controller.on('state', (s: AppState) => {
    for (const w of [win, picker]) if (w && !w.isDestroyed()) w.webContents.send('meshdrop:state', s);
  });
  await controller.start();
  // the browser extension's door (127.0.0.1 only); tests use their own ports, so not under MESHDROP_TEST
  if (!process.env.MESHDROP_TEST || process.env.MESHDROP_HANDOFF_PORT) {
    const c = controller;
    void startHandoffServer(
      {
        state: (s) => c.handoffState(s),
        nextCommand: (ms) => c.handoffNextCommand(ms),
        devices: () => c.handoffDevices(),
        send: (to, s) => c.handoffSend(to, s).catch(() => false),
      },
      Number(process.env.MESHDROP_HANDOFF_PORT ?? HANDOFF_PORT),
    );
  }
}

// One MeshDrop per config home: the Chromium profile lives beside it, and so does the instance lock.
if (!CLIP_HELPER) app.setPath('userData', join(HOME, 'electron'));
// Windows: notifications and the taskbar group under the id the installer gave the Start menu shortcut
if (WIN) app.setAppUserModelId(APP_ID);
if (CLIP_HELPER) {
  runClipHelper(CLIP_HELPER); // clipboard reads only: no window, tray or instance lock (cliphelper.ts)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0); // the running instance got our argv through 'second-instance'
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--send-clipboard')) showPicker();
    else {
      const files = sendArgs(argv);
      if (files.length > 0) controller?.addShared(files);
      showMain();
    }
  });

  void app.whenReady().then(async () => {
    const over: Partial<Settings> = {};
    if (process.env.MESHDROP_INBOX) over.inbox = process.env.MESHDROP_INBOX;
    settings = new SettingsStore(join(HOME, 'desktop-settings.json'), defaultSettings(over));
    if (process.env.MESHDROP_PORT !== undefined) settings.set({ port: Number(process.env.MESHDROP_PORT) });
    wireIpc();
    createTray();
    const clip = process.argv.includes('--send-clipboard');
    const hidden = process.argv.includes('--hidden') || settings.get().startHidden;
    if (!clip && (!hidden || !tray)) showMain();
    try {
      await startController();
    } catch (x) {
      const msg = x instanceof Error ? x.message : String(x);
      console.error(`MeshDrop could not start: ${x instanceof Error ? (x.stack ?? msg) : msg}`);
      if (!TEST) dialog.showErrorBox('MeshDrop could not start', msg);
    }
    rebuildTray();
    if (clip) showPicker();
    const files = sendArgs(process.argv);
    if (files.length > 0) controller?.addShared(files);
    if (app.isPackaged && !TEST) {
      // updated underneath us: come back as the new version (hidden if the window was hidden)
      onReplaced(join(process.resourcesPath, 'app.asar'), () => {
        const shown = !!win && !win.isDestroyed() && win.isVisible();
        app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--hidden'), ...(shown ? [] : ['--hidden'])] });
        quit();
      });
    }
    if (WIN && !TEST) {
      const binding = savedShortcut(HOME);
      try {
        if (binding) registerWinShortcut(binding, false);
      } catch {
        // a shortcut saved by an older build that no longer parses: Settings can set a new one
      }
    }
    if (app.isPackaged && !TEST && process.platform === 'linux') {
      try {
        installNautilusScript(launchCommand());
      } catch {
        // no Files integration: everything else works
      }
    }
  });

  app.on('window-all-closed', () => {
    if (!tray || !settings?.get().closeToTray) quit();
  });
  // systemd/session logout: stop like Quit does (sends kept for auto-resume, listen.pid removed).
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, quit);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (e) => {
    // Killed, not asked: a helper stuck in a clipboard read never sees its stdin close, and would
    // outlive the app holding the fds it inherited (a launcher waiting on them waits forever).
    clipReader?.close();
    if (!controller) return;
    e.preventDefault();
    const c = controller;
    controller = null;
    // Sends in flight end 'cancelled' and stay in the outbox (auto-resumed next time). A second
    // app.quit() after preventDefault() here is ignored by Electron: exit once stopped.
    // A stop stuck on a slow helper (nmcli waits up to 60 s) must not hang the quit: 5 s, then exit.
    void Promise.race([c.stop(), new Promise((r) => setTimeout(r, 5000).unref())]).finally(() => app.exit(0));
  });
}
