// Electron entry: one window over the app controller. Security: isolated, sandboxed renderer that
// can only call the DesktopApi; no navigation, no new windows.
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

const TEST = process.env.MESHDROP_TEST === '1';
let win: BrowserWindow | null = null;

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

void app.whenReady().then(() => {
  win = createWindow();
});
app.on('window-all-closed', () => app.quit());
export { win };
