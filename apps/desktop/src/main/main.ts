// Electron entry: one window over the app controller. Security: isolated, sandboxed renderer that
// can only call the DesktopApi (every argument type-checked here); no navigation, no new windows.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { configDir } from '@meshdrop/core/src/paths.ts';
import type { AppState, SendItemInput, Settings } from '../shared/api.ts';
import { AppController, type Platform } from './controller.ts';
import { HistoryStore } from './history.ts';
import { SettingsStore, defaultSettings } from './settings.ts';

const TEST = process.env.MESHDROP_TEST === '1';
let win: BrowserWindow | null = null;
let controller: AppController | null = null;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'MeshDrop',
    show: !TEST,
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
  void w.loadFile(join(__dirname, '../renderer/index.html'));
  return w;
}

const platform: Platform = {
  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
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

function wireIpc(): void {
  const handle = (name: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(`meshdrop:${name}`, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!win || e.sender !== win.webContents) throw new Error('unknown sender');
      return fn(...args);
    });
  };
  handle('getState', () => ctl().state());
  handle('pickFiles', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('pickSavePath', async (name) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: str(name, 255) });
    return r.canceled ? null : (r.filePath ?? null);
  });
  handle('pickOpenPath', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('send', (t, i) => ctl().send(targets(t), items(i)));
  handle('sendClipboard', (t) => ctl().sendClipboard(targets(t)));
  handle('resumeOutbox', () => ctl().resumeOutbox());
  handle('removeOutbox', (id) => ctl().removeOutbox(str(id, 128)));
  handle('addByAddress', (h, p, a) => ctl().addByAddress(str(h, 255), int(p), str(a, 64)));
  handle('scanSubnet', () => ctl().scanSubnet());
  handle('hubInit', (u) => ctl().hubInit(strs(u, 16)));
  handle('setHubUrls', (u) => ctl().setHubUrls(strs(u, 16)));
  handle('createInvite', () => ctl().createInvite());
  handle('join', (u) => ctl().join(str(u)));
  handle('revoke', (id) => ctl().revoke(str(id, 64)));
  handle('exportRecovery', (p, pw) => ctl().exportRecovery(str(p), str(pw, 1024)));
  handle('importRecovery', (p, pw) => ctl().importRecovery(str(p), str(pw, 1024)));
  handle('setSettings', (p) => ctl().setSettings(settingsPatch(p)));
  handle('openInbox', () => ctl().openInbox());
  handle('reveal', (p) => ctl().reveal(str(p)));
  handle('registerClipboardShortcut', () => {
    throw new Error('not available yet');
  });
  handle('openConfigFolder', () => ctl().openConfigFolder());
}

async function startController(): Promise<void> {
  const home = process.env.MESHDROP_HOME ?? configDir();
  const over: Partial<Settings> = {};
  if (process.env.MESHDROP_INBOX) over.inbox = process.env.MESHDROP_INBOX;
  const settings = new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings(over));
  if (process.env.MESHDROP_PORT !== undefined) settings.set({ port: Number(process.env.MESHDROP_PORT) });
  controller = new AppController({ home, settings, history: new HistoryStore(join(home, 'desktop-history.json')), platform });
  controller.on('state', (s: AppState) => win?.webContents.send('meshdrop:state', s));
  await controller.start();
}

void app.whenReady().then(async () => {
  wireIpc();
  win = createWindow();
  try {
    await startController();
  } catch (x) {
    const msg = x instanceof Error ? x.message : String(x);
    console.error(`MeshDrop could not start: ${x instanceof Error ? (x.stack ?? msg) : msg}`);
    if (!TEST) dialog.showErrorBox('MeshDrop could not start', msg);
  }
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', (e) => {
  if (!controller) return;
  e.preventDefault();
  const c = controller;
  controller = null;
  // A second app.quit() after preventDefault() here is ignored by Electron: exit once stopped.
  void c.stop().finally(() => app.exit(0));
});
