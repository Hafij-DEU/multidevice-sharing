// Runs in the sandboxed preload: exposes exactly the DesktopApi to the page, nothing else.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const call = (method: string) => (...args: unknown[]) => ipcRenderer.invoke(`meshdrop:${method}`, ...args);

const api = {
  getState: call('getState'),
  onState: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('meshdrop:state', h);
    return () => ipcRenderer.removeListener('meshdrop:state', h);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  ...Object.fromEntries(
    [
      'pickFiles', 'pickFolder', 'pickSavePath', 'pickOpenPath', 'send', 'sendClipboard', 'resumeOutbox', 'removeOutbox',
      'addByAddress', 'scanSubnet', 'hubInit', 'setHubUrls', 'createInvite', 'join', 'revoke', 'exportRecovery',
      'importRecovery', 'setSettings', 'openInbox', 'reveal', 'openFile', 'thumb', 'unpair', 'takeSharedItems', 'registerClipboardShortcut', 'openConfigFolder',
      'guestStart', 'guestEnd', 'guestShare', 'guestUnshare', 'guestAccept', 'guestReject', 'linkCreate', 'linkRevoke', 'reachDetect', 'reachSet',
    ].map((m) => [m, call(m)]),
  ),
};

contextBridge.exposeInMainWorld('meshdrop', api);
