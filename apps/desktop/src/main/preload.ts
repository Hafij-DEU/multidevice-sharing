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
      'pairProbe', 'addByAddress', 'appSend', 'ringStop', 'setupPhones', 'handoffSend', 'handoffExtension', 'watchCreate', 'watchResolve', 'watchOpen', 'watchEnd', 'watchPlayLocal', 'noteDismiss', 'streamStop', 'streamStart', 'hotspotStart', 'hotspotJoin', 'hotspotStop', 'scheduleCancel', 'saveBlob', 'roomStart', 'roomEnd', 'roomPost', 'roomSave', 'scanSubnet', 'hubInit', 'setHubUrls', 'relaysSet', 'createInvite', 'join', 'revoke', 'exportRecovery',
      'importRecovery', 'setSettings', 'openInbox', 'reveal', 'openFile', 'thumb', 'unpair', 'takeSharedItems', 'registerClipboardShortcut', 'openConfigFolder',
      'guestStart', 'guestEnd', 'guestShare', 'guestUnshare', 'guestAccept', 'guestReject', 'linkCreate', 'linkRevoke', 'reachDetect', 'reachSet', 'syncPut', 'syncRemove', 'syncNow', 'openSyncFolder',
      'wifiList', 'wifiCopy', 'wifiQr', 'wifiShare', 'wifiSyncNow',
    ].map((m) => [m, call(m)]),
  ),
};

contextBridge.exposeInMainWorld('meshdrop', api);
