// Electron entry: the main window, the clipboard picker and the tray over one app controller.
// Security: isolated, sandboxed renderers that can only call the DesktopApi (every argument
// type-checked here); no navigation, no new windows.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { configDir } from '@meshdrop/core/src/paths.ts';
import type { AppState, ReceivedRecord, SendItemInput, Settings } from '../shared/api.ts';
import { AppController, type Platform } from './controller.ts';
import { autostartDir, gnomeShortcutCommands, parseStrList, READ_KEYBINDINGS, setAutostart, validBinding } from './desktop.ts';
import { HistoryStore } from './history.ts';
import { SettingsStore, defaultSettings } from './settings.ts';

const execFileP = promisify(execFile);
const TEST = process.env.MESHDROP_TEST === '1';
const HOME = process.env.MESHDROP_HOME ?? configDir();
const ICONS = join(__dirname, '../icons');

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

const platform: Platform = {
  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: join(ICONS, 'icon.png') });
    if (onClick) n.on('click', onClick);
    n.show();
  },
  writeClipboard: (text) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),
  async openPath(p) {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  },
  revealPath: (p) => shell.showItemInFolder(p),
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
const SETTING_TYPES: Record<keyof Settings, 'string' | 'number' | 'boolean'> = {
  alias: 'string', inbox: 'string', port: 'number', discovery: 'boolean', autostart: 'boolean',
  startHidden: 'boolean', closeToTray: 'boolean', clipboardReceive: 'boolean', notifications: 'boolean',
  guestMinutes: 'number',
};
const settingsPatch = (x: unknown): Partial<Settings> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new ArgError('invalid argument');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    const t = SETTING_TYPES[k as keyof Settings];
    if (t === undefined || typeof v !== t) throw new ArgError(`invalid setting ${k}`);
    out[k] = v;
  }
  return out as Partial<Settings>;
};

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
  handle('send', (_e, t, i) => ctl().send(targets(t), items(i)));
  handle('sendClipboard', (_e, t) => ctl().sendClipboard(targets(t)));
  handle('resumeOutbox', (_e) => ctl().resumeOutbox());
  handle('removeOutbox', (_e, id) => ctl().removeOutbox(str(id, 128)));
  handle('addByAddress', (_e, h, p, a) => ctl().addByAddress(str(h, 255), int(p), str(a, 64)));
  handle('scanSubnet', (_e) => ctl().scanSubnet());
  handle('hubInit', (_e, u) => ctl().hubInit(strs(u, 16)));
  handle('setHubUrls', (_e, u) => ctl().setHubUrls(strs(u, 16)));
  handle('createInvite', async (_e) => {
    const r = await ctl().createInvite();
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
    if (s.autostart !== before.autostart) setAutostart(s.autostart, launchCommand(), TEST ? join(HOME, 'autostart') : autostartDir());
    rebuildTray();
    return s;
  });
  handle('guestStart', (_e) => ctl().guestStart());
  handle('guestEnd', (_e) => ctl().guestEnd());
  handle('guestShare', (_e, p) => ctl().guestShare(strs(p, 1000)));
  handle('guestUnshare', (_e, id) => ctl().guestUnshare(str(id, 64)));
  handle('guestAccept', (_e, id) => ctl().guestAccept(str(id, 64)));
  handle('guestReject', (_e, id) => ctl().guestReject(str(id, 64)));
  handle('openInbox', (_e) => ctl().openInbox());
  handle('reveal', (_e, p) => ctl().reveal(str(p)));
  handle('registerClipboardShortcut', async (_e, b) => {
    const binding = str(b, 64);
    if (!validBinding(binding)) throw new Error('That is not a valid shortcut (example: <Primary><Alt>c).');
    if (TEST) throw new Error('not in tests');
    const { stdout } = await execFileP(READ_KEYBINDINGS[0]!, READ_KEYBINDINGS.slice(1));
    for (const [cmd, ...args] of gnomeShortcutCommands(binding, launchCommand(), parseStrList(stdout))) await execFileP(cmd!, args);
  });
  handle('openConfigFolder', (_e) => ctl().openConfigFolder());
}

async function startController(): Promise<void> {
  const history = new HistoryStore(join(HOME, 'desktop-history.json'));
  // MESHDROP_GUEST_PORT moves the LAN guest server off 53320 (e2e uses 0: any free port).
  const guestPort = process.env.MESHDROP_GUEST_PORT !== undefined ? Number(process.env.MESHDROP_GUEST_PORT) : undefined;
  const engineOptions = guestPort !== undefined && Number.isInteger(guestPort) && guestPort >= 0 && guestPort <= 65535 ? { guest: { port: guestPort } } : {};
  controller = new AppController({ home: HOME, settings: settings!, history, platform, engineOptions });
  if (TEST) {
    // Test-only hooks, reachable from Playwright's app.evaluate (main process), never from the page.
    (globalThis as { __meshdropTest?: unknown }).__meshdropTest = {
      setPicked: (p: string[]) => {
        picked = p;
      },
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
}

// One MeshDrop per config home: the Chromium profile lives beside it, and so does the instance lock.
app.setPath('userData', join(HOME, 'electron'));
if (!app.requestSingleInstanceLock()) {
  app.exit(0); // the running instance got our argv through 'second-instance'
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--send-clipboard')) showPicker();
    else showMain();
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
    if (!controller) return;
    e.preventDefault();
    const c = controller;
    controller = null;
    // Sends in flight end 'cancelled' and stay in the outbox (auto-resumed next time). A second
    // app.quit() after preventDefault() here is ignored by Electron: exit once stopped.
    void c.stop().finally(() => app.exit(0));
  });
}
