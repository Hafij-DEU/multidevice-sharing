// MeshDrop Handoff: tells the MeshDrop app (on this PC, 127.0.0.1:53321) which page you are on, and
// opens pages your phone hands over, at the same spot. Nothing leaves this PC except through MeshDrop.
const api = globalThis.browser ?? globalThis.chrome;
const APP = 'http://127.0.0.1:53321';

async function post(path, body) {
  try {
    const r = await fetch(APP + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}

/** The active tab's place, from its content script (null: a page we cannot read, e.g. the new-tab page). */
async function activeSnapshot() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url ?? '')) return null;
  try {
    return await api.tabs.sendMessage(tab.id, { type: 'snapshot' });
  } catch {
    return { url: tab.url, title: tab.title ?? '', scroll: 0, text: '', at: Date.now() };
  }
}

let pushTimer = null;
function pushSoon() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const s = await activeSnapshot();
    if (s) await post('/state', s);
  }, 800);
}
api.tabs.onActivated.addListener(pushSoon);
api.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && tab.active) pushSoon();
});
api.windows?.onFocusChanged?.addListener(pushSoon);
api.runtime.onMessage.addListener((m, sender) => {
  if (m?.type === 'state' && sender.tab?.active) void post('/state', m.state);
  if (m?.type === 'send-to-phone') return post('/send', { to: m.to, state: m.state });
  if (m?.type === 'status') return fetch(APP + '/status').then((r) => r.json()).catch(() => null);
  return undefined;
});

/** Opens a page from the phone and takes it to the same spot. */
async function openHere(o) {
  const tab = await api.tabs.create({ url: o.url, active: true });
  const done = (id, info) => {
    if (id !== tab.id || info.status !== 'complete') return;
    api.tabs.onUpdated.removeListener(done);
    api.tabs.sendMessage(tab.id, { type: 'restore', scroll: o.scroll, time: o.time }).catch(() => {});
  };
  api.tabs.onUpdated.addListener(done);
}

// Waits for the app: "give me where the user is" (a phone asked) or "open this" (a phone handed over).
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      let r;
      try {
        // The app answers within 25 s; a hung app must not leave this fetch pending forever.
        r = await fetch(APP + '/poll', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(35_000),
        });
      } catch {
        break; // the app is not running (or hung): the alarm tries again
      }
      if (!r.ok) break;
      const cmd = await r.json().catch(() => ({}));
      if (cmd.type === 'snapshot') await post('/state', (await activeSnapshot()) ?? { none: true });
      else if (cmd.type === 'open' && /^https?:\/\//.test(cmd.url ?? '')) await openHere(cmd);
    }
  } finally {
    polling = false;
  }
}
api.alarms.create('meshdrop-poll', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(() => void poll());
api.runtime.onStartup?.addListener(() => void poll());
api.runtime.onInstalled?.addListener(() => void poll());
void poll();
