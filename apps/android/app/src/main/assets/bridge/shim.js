// window.meshdrop (DesktopApi) over the Android JS bridge (MeshDropBridge). Loaded before the app's
// own script. Results come back through window.__mdResolve, state pushes through window.__mdState.
(() => {
  const pending = new Map();
  const stateListeners = new Set();
  let nextId = 1;
  window.__mdResolve = (id, ok, json) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    const value = json === null ? undefined : JSON.parse(json);
    if (ok) p.resolve(value);
    else p.reject(new Error(typeof value === 'string' ? value : 'failed'));
  };
  window.__mdState = (json) => {
    const s = JSON.parse(json);
    for (const cb of stateListeners) {
      try {
        cb(s);
      } catch (e) {
        console.error(e);
      }
    }
  };
  const call = (method) => (...args) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      window.MeshDropBridge.call(id, method, JSON.stringify(args));
    });
  const api = {
    onState(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    pathForFile() {
      return '';
    },
  };
  for (const m of [
    'getState', 'pickFiles', 'pickFolder', 'pickSavePath', 'pickOpenPath', 'pickItems', 'scanQr', 'scanDocument', 'send', 'sendClipboard', 'resumeOutbox',
    'removeOutbox', 'pairProbe', 'addByAddress', 'appSend', 'ringStop', 'noteDismiss', 'handoffPull', 'watchCreate', 'watchResolve', 'watchOpen', 'watchEnd', 'streamStop', 'streamStart', 'scheduleCancel', 'saveBlob', 'scanSubnet', 'hubInit', 'setHubUrls', 'relaysSet', 'createInvite', 'join', 'revoke', 'exportRecovery',
    'importRecovery', 'setSettings', 'openInbox', 'reveal', 'registerClipboardShortcut', 'openConfigFolder', 'takeSharedItems',
    'keepAliveAction', 'guestStart', 'guestEnd', 'guestShare', 'guestUnshare', 'guestAccept', 'guestReject', 'linkCreate', 'linkRevoke', 'openFile', 'thumb', 'unpair', 'syncPut', 'syncRemove', 'syncNow', 'backupSet', 'backupPermission',
    'hotspotStart', 'hotspotJoin', 'hotspotStop',
    'wifiList', 'wifiSave', 'wifiDelete', 'wifiApply', 'wifiForget', 'wifiStatus', 'wifiScan', 'wifiSyncNow',
  ]) {
    api[m] = call(m);
  }
  window.meshdrop = api;
  window.close = () => window.MeshDropBridge.close();
})();
