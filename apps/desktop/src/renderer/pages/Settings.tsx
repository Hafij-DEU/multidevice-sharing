import { useState } from 'react';
import type { AppState, Settings as S } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { QrShareSwitch } from './QrShare.tsx';
import { setThemeChoice, themeChoice, type ThemeChoice } from '../theme.ts';

const DEFAULT_BINDING = '<Primary><Alt>c';
/** Windows: MeshDrop holds the shortcut itself (GNOME keeps it in its settings on Linux). */
const WINDOWS = /Windows NT/.test(navigator.userAgent);
const THEMES: [ThemeChoice, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/** Appearance: kept on this device, applied at once. */
function Theme() {
  const [choice, setChoice] = useState(themeChoice);
  return (
    <div className="field">
      <span>Theme</span>
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {THEMES.map(([v, label]) => (
          <button
            key={v}
            role="radio"
            aria-checked={choice === v}
            className={choice === v ? 'active' : ''}
            onClick={() => {
              setThemeChoice(v);
              setChoice(v);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

const SWITCHES: [keyof S, string][] = [
  ['discovery', 'Find devices on this network automatically'],
  ['clipboardReceive', 'Put received clipboard text on my clipboard'],
  ['clipboardSync', 'Shared clipboard: text I copy goes to my online devices'],
  ['notifications', 'Show notifications'],
  ['closeToTray', 'Keep running in the tray when the window is closed'],
  ['autostart', 'Start MeshDrop when I log in'],
  ['startHidden', 'Start in the tray (no window)'],
  ['sortInbox', 'Smart inbox: put received files in Images, Videos, Audio, Documents, Archives or Other'],
  ['sendReceipts', 'Read receipts: tell the sender when I open what it sent'],
  ['printFromDevices', 'Print files my devices send with "Print on PC"'],
];

/** M14 No Wi-Fi switches, shown in their own section. */
const NO_WIFI: [keyof S, string][] = [
  ['bluetooth', 'Use Bluetooth when there is no shared network'],
  ['allBluetooth', 'Everything over Bluetooth (even on the same network)'],
  ['tetherNoData', "When MeshDrop joins a phone's hotspot, never use the phone's mobile data"],
];

const DESKTOP_ONLY: (keyof S)[] = ['autostart', 'startHidden', 'closeToTray', 'printFromDevices', 'sortInbox', 'tetherNoData'];

function KeepAlive({ state, run }: { state: AppState; run: Run }) {
  const k = state.keepAlive;
  if (!k) return null;
  return (
    <>
      <h2>Keep MeshDrop alive</h2>
      <p className="muted">Phones stop apps in the background to save battery. These steps keep MeshDrop reachable.</p>
      <ul className="list">
        {k.steps.map((s) => (
          <li key={s.id} className="row space">
            <span>
              {s.done ? '✓ ' : ''}
              {s.label}
            </span>
            {!s.done && window.meshdrop.keepAliveAction && (
              <button onClick={() => void run(() => window.meshdrop.keepAliveAction!(s.id))}>Open</button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** How to connect without a router: Bluetooth, a phone's hotspot, or USB/Bluetooth tethering. */
function NoWifiHelp({ android }: { android: boolean }) {
  return (
    <details className="help">
      <summary>How to connect with no Wi-Fi router</summary>
      <ul>
        <li>
          <b>Bluetooth</b>: pair the devices once in the {android ? "phone's" : "system's"} Bluetooth settings. Paired MeshDrop devices then connect by
          themselves when they share no network. Files, clipboard, remote control, media keys, notifications and sound work over Bluetooth; the camera needs
          Wi-Fi. Choose Auto, Wi-Fi only or Bluetooth only per device under Paired devices.
        </li>
        <li>
          <b>Phone hotspot</b>: start a hotspot on a phone and join it from the other devices. MeshDrop finds them as on any network; if it does not,
          add the device by its address (Send → Add a device).
        </li>
        <li>
          <b>USB tethering</b>: plug the phone into the PC and turn on Settings → Network → Hotspot &amp; tethering → USB tethering.{' '}
          <b>Bluetooth tethering</b> works the same way over a paired phone. Both give a small network between the phone and the PC.
        </li>
        {!android && (
          <li>
            With "never use the phone's mobile data" on, this PC keeps its internet and DNS off a phone's hotspot that MeshDrop joined: MeshDrop works
            over it, nothing else does. A hotspot or tether you join yourself works as usual.
          </li>
        )}
      </ul>
    </details>
  );
}

/** M14: host a hotspot (devices linked over Bluetooth get its password) or join one, where this device can. */
function Hotspot({ state, run }: { state: AppState; run: Run }) {
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [ask, setAsk] = useState<{ network: string; go: () => Promise<void> } | null>(null);
  const nw = state.noWifi;
  const api = window.meshdrop;
  if (!nw || !api.hotspotStart || !api.hotspotJoin || !api.hotspotStop) return null;
  const { hotspotStart, hotspotJoin, hotspotStop } = api;
  // the Wi-Fi is on a network: say so and go on only when the user agrees
  const leaving = (go: (leave: boolean) => Promise<void>) => async () => {
    try {
      await go(false);
    } catch (e) {
      const m = /wifi-busy:(.*)$/.exec(e instanceof Error ? e.message : String(e));
      if (m) setAsk({ network: m[1]!, go: () => go(true) });
      else await run(() => Promise.reject(e));
    }
  };
  const h = nw.hotspot;
  const offer = nw.offer;
  return (
    <>
      {nw.guarded && nw.guarded.length > 0 && <p className="muted">Not using the phone's mobile data on: {nw.guarded.join(', ')}.</p>}
      {ask && (
        <div className="sync-folder">
          <p>This device's Wi-Fi is on "{ask.network}". It leaves that network until the hotspot is stopped.</p>
          <div className="row">
            <button className="primary" onClick={() => { const go = ask.go; setAsk(null); void run(go); }}>Continue</button>
            <button onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </div>
      )}
      {h?.role === 'host' && (
        <div className="sync-folder">
          <p>
            Hotspot <b>{h.ssid}</b> is on. Password: <b>{h.psk}</b>
          </p>
          {h.qrSvg && <img className="qr" src={`data:image/svg+xml;base64,${btoa(h.qrSvg)}`} alt="Wi-Fi QR code" width={180} height={180} />}
          <p className="muted">Devices linked over Bluetooth got the password and join on their own. Others scan the code or type it.</p>
          <button onClick={() => void run(hotspotStop)}>Stop hotspot</button>
        </div>
      )}
      {h?.role === 'joined' && (
        <div className="row space">
          <span>On hotspot <b>{h.ssid}</b>.</span>
          <button onClick={() => void run(hotspotStop)}>Leave</button>
        </div>
      )}
      {!h && offer && (
        <div className="sync-folder">
          <p>
            {offer.alias ?? 'A device'} shares hotspot <b>{offer.ssid}</b>.
          </p>
          {offer.error && <p className="error-text">{offer.error}</p>}
          <div className="row">
            <button className="primary" disabled={offer.joining} onClick={() => void leaving((leave) => hotspotJoin(offer.ssid, offer.psk, offer.hosts, leave))()}>
              {offer.joining ? 'Joining…' : 'Join'}
            </button>
            <button onClick={() => void run(hotspotStop)}>Dismiss</button>
          </div>
        </div>
      )}
      {!h && (
        <>
          <div className="row">
            <button onClick={() => void leaving((leave) => hotspotStart(leave))()}>Start a hotspot here</button>
          </div>
          <div className="row">
            <input placeholder="Hotspot name" value={ssid} maxLength={32} onChange={(e) => setSsid(e.target.value)} />
            <input placeholder="Password" type="password" value={psk} maxLength={63} onChange={(e) => setPsk(e.target.value)} />
            <button disabled={ssid === '' || psk.length < 8} onClick={() => void leaving((leave) => hotspotJoin(ssid, psk, [], leave))()}>
              Join hotspot
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** About: who made MeshDrop and where to find them. */
function About() {
  const link = (href: string, text = href) => (
    <a href={href} target="_blank" rel="noreferrer">{text}</a>
  );
  return (
    <>
      <h2>About</h2>
      <p><b>MeshDrop</b> {__APP_VERSION__}</p>
      <p>Developed by Md. Hafijur Rahman</p>
      <p>GitHub: {link('https://github.com/Hafij-DEU/multidevice-sharing')}</p>
      <p>License: GPL-3.0</p>
      <p>Privacy: {link('https://github.com/Hafij-DEU/multidevice-sharing/blob/main/PRIVACY.md', 'PRIVACY.md')}</p>
      <p className="muted">
        Third-party software: Electron, React, ws, qrcode (MIT/ISC), ZXing and AndroidX (Apache-2.0). Speaks the LocalSend
        protocol (MIT) to talk to LocalSend apps. {link('https://github.com/Hafij-DEU/multidevice-sharing/blob/main/THIRD_PARTY_NOTICES.md', 'Full notices')}
      </p>
      <p className="muted">This app was generated with AI. Developer support may not be available.</p>
    </>
  );
}

export function Settings({ state, run }: { state: AppState; run: Run }) {
  const android = state.platform === 'android';
  const [draft, setDraft] = useState<S>(state.settings);
  const [binding, setBinding] = useState(DEFAULT_BINDING);
  const [confirm, setConfirm] = useState(false);
  const patch = Object.fromEntries(Object.entries(draft).filter(([k, v]) => state.settings[k as keyof S] !== v)) as Partial<S>;
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof S>(k: K, v: S[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    const r = await run(() => window.meshdrop.setSettings(patch), 'Settings saved');
    if (r) setDraft(r);
  };

  return (
    <section className="settings">
      <label className="field">
        <span>Device name</span>
        <input aria-label="Device name" value={draft.alias} maxLength={64} onChange={(e) => set('alias', e.target.value)} />
      </label>
      <Theme />
      {android ? (
        <p className="field">
          <span>Received files are saved in</span> <code>Download/MeshDrop</code>
        </p>
      ) : (
      <label className="field">
        <span>Save received files in</span>
        <span className="row">
          <input aria-label="Inbox folder" className="grow" value={draft.inbox} onChange={(e) => set('inbox', e.target.value)} />
          <button
            onClick={() =>
              void run(async () => {
                const p = await window.meshdrop.pickFolder();
                if (p) set('inbox', p);
              })
            }
          >
            Choose…
          </button>
        </span>
      </label>
      )}
      <label className="field">
        <span>Port</span>
        <input aria-label="Port" type="number" min={0} max={65535} value={draft.port} onChange={(e) => set('port', Number(e.target.value))} />
      </label>
      <label className="field">
        <span>A guest link works for</span>
        <select aria-label="Guest link length" value={draft.guestMinutes} onChange={(e) => set('guestMinutes', Number(e.target.value))}>
          {[...new Set([15, 30, 60, 120, 240, 480, 1440, draft.guestMinutes])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`}
            </option>
          ))}
        </select>
      </label>
      {!android && (
        <label className="row">
          Delete received files after{' '}
          <select aria-label="Clean-up" value={draft.cleanupDays} onChange={(e) => set('cleanupDays', Number(e.target.value))}>
            {[...new Set([0, 7, 30, 90, 365, draft.cleanupDays])].sort((a, b) => a - b).map((d) => (
              <option key={d} value={d}>
                {d === 0 ? 'never' : `${d} days`}
              </option>
            ))}
          </select>
        </label>
      )}
      {SWITCHES.filter(([k]) => !(android && DESKTOP_ONLY.includes(k))).map(([k, label]) => (
        <label key={k} className="toggle">
          <input type="checkbox" checked={draft[k] as boolean} onChange={(e) => set(k, e.target.checked as never)} /> {label}
        </label>
      ))}
      <h2>No Wi-Fi</h2>
      {NO_WIFI.filter(([k]) => !(android && DESKTOP_ONLY.includes(k))).map(([k, label]) => (
        <label key={k} className="toggle">
          <input type="checkbox" checked={draft[k] as boolean} disabled={k === 'allBluetooth' && !draft.bluetooth} onChange={(e) => set(k, e.target.checked as never)} /> {label}
        </label>
      ))}
      <label className="row">
        Sound over Bluetooth{' '}
        <select aria-label="Sound over Bluetooth" value={draft.btSoundKbps} onChange={(e) => set('btSoundKbps', Number(e.target.value))}>
          {[8, 12, 16, 24, 32].map((k) => (
            <option key={k} value={k}>
              {k === 8 ? '8 kbit/s (fewest breaks)' : k === 32 ? '32 kbit/s (best sound)' : `${k} kbit/s`}
            </option>
          ))}
        </select>
      </label>
      <Hotspot state={state} run={run} />
      <NoWifiHelp android={android} />
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
        <button disabled={!dirty} onClick={() => setDraft(state.settings)}>
          Undo changes
        </button>
      </div>

      <QrShareSwitch run={run} />

      {android ? (
        <KeepAlive state={state} run={run} />
      ) : (
        <>
      <h2>Keyboard shortcut</h2>
      <p className="muted">{WINDOWS ? 'A shortcut that opens a small window to send what is on your clipboard (while MeshDrop runs, also in the tray).' : 'Adds a GNOME shortcut that opens a small window to send what is on your clipboard.'}</p>
      <div className="row">
        <input aria-label="Shortcut" value={binding} onChange={(e) => setBinding(e.target.value)} />
        <button onClick={() => setConfirm(true)}>Set up keyboard shortcut</button>
      </div>

      <h2>Advanced</h2>
      <div className="row">
        <button onClick={() => void run(() => window.meshdrop.openConfigFolder())}>Open config folder</button>
      </div>

        </>
      )}

      <About />

      {confirm && (
        <div className="modal-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="sc-title" className="modal">
            <h2 id="sc-title">Add this shortcut?</h2>
            <p>
              {WINDOWS ? 'MeshDrop will open “Send clipboard” when you press ' : 'GNOME will run “MeshDrop: send clipboard” when you press '}<code>{binding}</code>.{WINDOWS ? ' It replaces the one set before.' : ' Your other custom shortcuts stay as they are.'}
            </p>
            <div className="row">
              <button onClick={() => setConfirm(false)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  setConfirm(false);
                  void run(() => window.meshdrop.registerClipboardShortcut(binding), 'Shortcut added');
                }}
              >
                Add shortcut
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
