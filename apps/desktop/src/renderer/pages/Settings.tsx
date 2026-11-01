import { useEffect, useState, type ReactNode } from 'react';
import type { AppState, Settings as S } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { QrShareSwitch } from './QrShare.tsx';
import { LANGS, langChoice, mark, setLangChoice, t, type Lang, type LangChoice } from '../i18n.ts';
import { PALETTES, THEMES, onThemeChange, palette, setPalette, setThemeChoice, themeChoice, type Palette } from '../theme.ts';

const DEFAULT_BINDING = '<Primary><Alt>c';
/** Windows: MeshDrop holds the shortcut itself (GNOME keeps it in its settings on Linux). */
const WINDOWS = /Windows NT/.test(navigator.userAgent);
/** Appearance: kept on this device, applied at once. */
function Theme() {
  const [choice, setChoice] = useState(themeChoice);
  useEffect(() => onThemeChange(() => setChoice(themeChoice())), []);
  return (
    <div className="field">
      <span>{t('Theme')}</span>
      <div className="segmented" role="radiogroup" aria-label={t('Theme')}>
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
            {t(label)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Language: kept on this device; the app redraws in it at once. Names stay in their own language. */
function Language() {
  const [choice, setChoice] = useState(langChoice);
  return (
    <label className="field">
      <span>{t('Language')}</span>
      <select
        aria-label={t('Language')}
        value={choice}
        onChange={(e) => {
          const v = e.target.value as LangChoice;
          setChoice(v);
          void setLangChoice(v);
        }}
      >
        <option value="system">{t('System')}</option>
        {(Object.keys(LANGS) as Lang[]).map((l) => (
          <option key={l} value={l} lang={l}>
            {LANGS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

const PALETTE_NAME: Record<Palette, string> = {
  aurora: mark('Aurora'),
  ocean: mark('Ocean'),
  sunset: mark('Sunset'),
  forest: mark('Forest'),
  candy: mark('Candy'),
  neon: mark('Neon'),
  graphite: mark('Graphite'),
};

/** Colours: one swatch per palette, kept on this device, applied at once. */
function Colours() {
  const [choice, setChoice] = useState(palette);
  return (
    <div className="field">
      <span>{t('Colours')}</span>
      <div className="swatches" role="radiogroup" aria-label={t('Colours')}>
        {PALETTES.map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={choice === p}
            className={`swatch${choice === p ? ' active' : ''}`}
            data-palette={p}
            onClick={() => {
              setPalette(p);
              setChoice(p);
            }}
          >
            <span className="swatch-chip" aria-hidden="true" />
            {t(PALETTE_NAME[p])}
          </button>
        ))}
      </div>
    </div>
  );
}

const SWITCHES: [keyof S, string][] = [
  ['discovery', mark('Find devices on this network automatically')],
  ['clipboardReceive', mark('Put received clipboard text on my clipboard')],
  ['clipboardSync', mark('Shared clipboard: text I copy goes to my online devices')],
  ['notifications', mark('Show notifications')],
  ['closeToTray', mark('Keep running in the tray when the window is closed')],
  ['autostart', mark('Start MeshDrop when I log in')],
  ['startHidden', mark('Start in the tray (no window)')],
  ['sortInbox', mark('Smart inbox: put received files in Images, Videos, Audio, Documents, Archives or Other')],
  ['sendReceipts', mark('Read receipts: tell the sender when I open what it sent')],
  ['printFromDevices', mark('Print files my devices send with "Print on PC"')],
];

/** M14 No Wi-Fi switches, shown in their own section. */
const NO_WIFI: [keyof S, string][] = [
  ['bluetooth', mark('Use Bluetooth when there is no shared network')],
  ['allBluetooth', mark('Everything over Bluetooth (even on the same network)')],
  ['tetherNoData', mark("When MeshDrop joins a phone's hotspot, never use the phone's mobile data")],
];

const DESKTOP_ONLY: (keyof S)[] = ['autostart', 'startHidden', 'closeToTray', 'printFromDevices', 'sortInbox', 'tetherNoData'];

function KeepAlive({ state, run }: { state: AppState; run: Run }) {
  const k = state.keepAlive;
  if (!k) return null;
  return (
    <>
      <h2>{t('Keep MeshDrop alive')}</h2>
      <p className="muted">{t('Phones stop apps in the background to save battery. These steps keep MeshDrop reachable.')}</p>
      <ul className="list">
        {k.steps.map((s) => (
          <li key={s.id} className="row space">
            <span>
              {s.done ? '✓ ' : ''}
              {s.label}
            </span>
            {!s.done && window.meshdrop.keepAliveAction && (
              <button onClick={() => void run(() => window.meshdrop.keepAliveAction!(s.id))}>{t('Open')}</button>
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
      <summary>{t('How to connect with no Wi-Fi router')}</summary>
      <ul>
        <li>
          <b>{t('Bluetooth')}</b>:{' '}
          {android
            ? t("pair the devices once in the phone's Bluetooth settings. Paired MeshDrop devices then connect by themselves when they share no network. Files, clipboard, remote control, media keys, notifications and sound work over Bluetooth; the camera needs Wi-Fi. Choose Auto, Wi-Fi only or Bluetooth only per device under Paired devices.")
            : t("pair the devices once in the system's Bluetooth settings. Paired MeshDrop devices then connect by themselves when they share no network. Files, clipboard, remote control, media keys, notifications and sound work over Bluetooth; the camera needs Wi-Fi. Choose Auto, Wi-Fi only or Bluetooth only per device under Paired devices.")}
        </li>
        <li>
          <b>{t('Phone hotspot')}</b>:{' '}
          {t('start a hotspot on a phone and join it from the other devices. MeshDrop finds them as on any network; if it does not, add the device by its address (Send → Add a device).')}
        </li>
        <li>
          <b>{t('USB tethering')}</b>:{' '}
          {t('plug the phone into the PC and turn on Settings → Network → Hotspot & tethering → USB tethering.')}{' '}
          <b>{t('Bluetooth tethering')}</b>{' '}
          {t('works the same way over a paired phone. Both give a small network between the phone and the PC.')}
        </li>
        {!android && (
          <li>
            {t(
              'With "never use the phone\'s mobile data" on, this PC keeps its internet and DNS off a phone\'s hotspot that MeshDrop joined: MeshDrop works over it, nothing else does. A hotspot or tether you join yourself works as usual.',
            )}
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
      {nw.guarded && nw.guarded.length > 0 && <p className="muted">{t("Not using the phone's mobile data on: {list}.", { list: nw.guarded.join(', ') })}</p>}
      {ask && (
        <div className="sync-folder">
          <p>{t('This device\'s Wi-Fi is on "{network}". It leaves that network until the hotspot is stopped.', { network: ask.network })}</p>
          <div className="row">
            <button className="primary" onClick={() => { const go = ask.go; setAsk(null); void run(go); }}>{t('Continue')}</button>
            <button onClick={() => setAsk(null)}>{t('Cancel')}</button>
          </div>
        </div>
      )}
      {h?.role === 'host' && (
        <div className="sync-folder">
          <p>
            {t('Hotspot')} <b>{h.ssid}</b> {t('is on. Password:')} <b>{h.psk}</b>
          </p>
          {h.qrSvg && <img className="qr" src={`data:image/svg+xml;base64,${btoa(h.qrSvg)}`} alt={t('Wi-Fi QR code')} width={180} height={180} />}
          <p className="muted">{t('Devices linked over Bluetooth got the password and join on their own. Others scan the code or type it.')}</p>
          <button onClick={() => void run(hotspotStop)}>{t('Stop hotspot')}</button>
        </div>
      )}
      {h?.role === 'joined' && (
        <div className="row space">
          <span>{t('On hotspot')} <b>{h.ssid}</b>.</span>
          <button onClick={() => void run(hotspotStop)}>{t('Leave')}</button>
        </div>
      )}
      {!h && offer && (
        <div className="sync-folder">
          <p>
            {offer.alias ?? t('A device')} {t('shares hotspot')} <b>{offer.ssid}</b>.
          </p>
          {offer.error && <p className="error-text">{offer.error}</p>}
          <div className="row">
            <button className="primary" disabled={offer.joining} onClick={() => void leaving((leave) => hotspotJoin(offer.ssid, offer.psk, offer.hosts, leave))()}>
              {offer.joining ? t('Joining…') : t('Join')}
            </button>
            <button onClick={() => void run(hotspotStop)}>{t('Dismiss')}</button>
          </div>
        </div>
      )}
      {!h && (
        <>
          <div className="row">
            <button onClick={() => void leaving((leave) => hotspotStart(leave))()}>{t('Start a hotspot here')}</button>
          </div>
          <div className="row">
            <input placeholder={t('Hotspot name')} value={ssid} maxLength={32} onChange={(e) => setSsid(e.target.value)} />
            <input placeholder={t('Password')} type="password" value={psk} maxLength={63} onChange={(e) => setPsk(e.target.value)} />
            <button disabled={ssid === '' || psk.length < 8} onClick={() => void leaving((leave) => hotspotJoin(ssid, psk, [], leave))()}>
              {t('Join hotspot')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** About: who made MeshDrop and where to find them. */
export function About() {
  const link = (href: string, text = href) => (
    <a href={href} target="_blank" rel="noreferrer">{text}</a>
  );
  return (
    <>
      <h2>{t('About')}</h2>
      <p><b>MeshDrop</b> {__APP_VERSION__}</p>
      <p>{t('Developed by Md. Hafijur Rahman')}</p>
      <p>{t('GitHub:')} {link('https://github.com/Hafij-DEU/multidevice-sharing')}</p>
      <p>{t('License: GPL-3.0')}</p>
      <p>{t('Privacy:')} {link('https://github.com/Hafij-DEU/multidevice-sharing/blob/main/PRIVACY.md', 'PRIVACY.md')}</p>
      <p className="muted">
        {t('Third-party software: Electron, React, ws, qrcode (MIT/ISC), ZXing and AndroidX (Apache-2.0). Speaks the LocalSend protocol (MIT) to talk to LocalSend apps.')}{' '}
        {link('https://github.com/Hafij-DEU/multidevice-sharing/blob/main/THIRD_PARTY_NOTICES.md', t('Full notices'))}
      </p>
      <p className="muted">{t('This app was generated with AI. Developer support may not be available.')}</p>
    </>
  );
}

/** Icon paths for the setting cards (24×24, stroked). */
const I = {
  device: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  paint: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1-.8-1.4-.8-2.3 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5zM7.5 11h.01M10 7h.01M15 7.5h.01',
  inbox: 'M12 4v10M8 10l4 4 4-4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  power: 'M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0',
  bt: 'M7 7l10 10-5 4V3l5 4L7 17',
  keys: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
};

/** A group of settings: a glass card with an icon header. */
function Card({ title, icon, wide, children }: { title: string; icon: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`set-card${wide ? ' wide' : ''}`}>
      <h2 className="set-head">
        <span className="set-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={icon} />
          </svg>
        </span>
        {t(title)}
      </h2>
      {children}
    </div>
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
    const r = await run(() => window.meshdrop.setSettings(patch), t('Settings saved'));
    if (r) setDraft(r);
  };

  const toggles = (keys: (keyof S)[], all: [keyof S, string][] = SWITCHES) =>
    all
      .filter(([k]) => keys.includes(k) && !(android && DESKTOP_ONLY.includes(k)))
      .map(([k, label]) => (
        <label key={k} className="toggle">
          <input type="checkbox" checked={draft[k] as boolean} disabled={k === 'allBluetooth' && !draft.bluetooth} onChange={(e) => set(k, e.target.checked as never)} /> {t(label)}
        </label>
      ));

  return (
    <section className="settings">
      <div className="set-grid">
      <Card title={mark('This device')} icon={I.device}>
        <label className="field">
          <span>{t('Device name')}</span>
          <input aria-label={t('Device name')} value={draft.alias} maxLength={64} onChange={(e) => set('alias', e.target.value)} />
        </label>
        <label className="field">
          <span>{t('Port')}</span>
          <input aria-label={t('Port')} type="number" min={0} max={65535} value={draft.port} onChange={(e) => set('port', Number(e.target.value))} />
        </label>
      </Card>
      <Card title={mark('Appearance')} icon={I.paint}>
        <Language />
        <Theme />
        <Colours />
      </Card>
      <Card title={mark('Receiving')} icon={I.inbox}>
        {android ? (
          <p className="field">
            <span>{t('Received files are saved in')}</span> <code>Download/MeshDrop</code>
          </p>
        ) : (
          <label className="field">
            <span>{t('Save received files in')}</span>
            <span className="row">
              <input aria-label={t('Inbox folder')} className="grow" value={draft.inbox} onChange={(e) => set('inbox', e.target.value)} />
              <button
                onClick={() =>
                  void run(async () => {
                    const p = await window.meshdrop.pickFolder();
                    if (p) set('inbox', p);
                  })
                }
              >
                {t('Choose…')}
              </button>
            </span>
          </label>
        )}
        {!android && (
          <label className="row">
            {t('Delete received files after')}{' '}
            <select aria-label={t('Clean-up')} value={draft.cleanupDays} onChange={(e) => set('cleanupDays', Number(e.target.value))}>
              {[...new Set([0, 7, 30, 90, 365, draft.cleanupDays])].sort((a, b) => a - b).map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? t('never') : t('{n} days', { n: d })}
                </option>
              ))}
            </select>
          </label>
        )}
        {toggles(['sortInbox', 'sendReceipts', 'printFromDevices'])}
      </Card>
      <Card title={mark('Network and sharing')} icon={I.wifi}>
        {toggles(['discovery'])}
        <label className="field">
          <span>{t('A guest link works for')}</span>
          <select aria-label={t('Guest link length')} value={draft.guestMinutes} onChange={(e) => set('guestMinutes', Number(e.target.value))}>
            {[...new Set([15, 30, 60, 120, 240, 480, 1440, draft.guestMinutes])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {m < 60 ? t('{n} minutes', { n: m }) : m === 60 ? t('1 hour') : t('{n} hours', { n: m / 60 })}
              </option>
            ))}
          </select>
        </label>
      </Card>
      <Card title={mark('Clipboard and notifications')} icon={I.bell}>
        {toggles(['clipboardReceive', 'clipboardSync', 'notifications'])}
      </Card>
      {!android && (
        <Card title={mark('Start-up')} icon={I.power}>
          {toggles(['autostart', 'startHidden', 'closeToTray'])}
        </Card>
      )}
      <Card title={mark('No Wi-Fi')} icon={I.bt} wide>
        {toggles(['bluetooth', 'allBluetooth', 'tetherNoData'], NO_WIFI)}
        <label className="row">
          {t('Sound over Bluetooth')}{' '}
          <select aria-label={t('Sound over Bluetooth')} value={draft.btSoundKbps} onChange={(e) => set('btSoundKbps', Number(e.target.value))}>
            {[8, 12, 16, 24, 32].map((k) => (
              <option key={k} value={k}>
                {k === 8 ? t('8 kbit/s (fewest breaks)') : k === 32 ? t('32 kbit/s (best sound)') : t('{n} kbit/s', { n: k })}
              </option>
            ))}
          </select>
        </label>
        <Hotspot state={state} run={run} />
        <NoWifiHelp android={android} />
      </Card>
      </div>
      <div className={`save-bar${dirty ? ' dirty' : ''}`}>
        <span className="muted">{dirty ? t('You have unsaved changes') : t('All changes saved')}</span>
        <button disabled={!dirty} onClick={() => setDraft(state.settings)}>
          {t('Undo changes')}
        </button>
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          {t('Save')}
        </button>
      </div>

      <div className="set-grid">
      <div className="set-card">
        <QrShareSwitch run={run} />
      </div>

      {android ? (
        <div className="set-card">
          <KeepAlive state={state} run={run} />
        </div>
      ) : (
        <>
          <Card title={mark('Keyboard shortcut')} icon={I.keys}>
            <p className="muted">{WINDOWS ? t('A shortcut that opens a small window to send what is on your clipboard (while MeshDrop runs, also in the tray).') : t('Adds a GNOME shortcut that opens a small window to send what is on your clipboard.')}</p>
            <div className="row">
              <input aria-label={t('Shortcut')} value={binding} onChange={(e) => setBinding(e.target.value)} />
              <button onClick={() => setConfirm(true)}>{t('Set up keyboard shortcut')}</button>
            </div>
          </Card>
          <Card title={mark('Advanced')} icon={I.gear}>
            <div className="row">
              <button onClick={() => void run(() => window.meshdrop.openConfigFolder())}>{t('Open config folder')}</button>
            </div>
          </Card>
        </>
      )}

      <div className="set-card set-about">
        <About />
      </div>
      </div>

      {confirm && (
        <div className="modal-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="sc-title" className="modal">
            <h2 id="sc-title">{t('Add this shortcut?')}</h2>
            <p>
              {WINDOWS ? t('MeshDrop will open “Send clipboard” when you press ') : t('GNOME will run “MeshDrop: send clipboard” when you press ')}<code>{binding}</code>.{WINDOWS ? t(' It replaces the one set before.') : t(' Your other custom shortcuts stay as they are.')}
            </p>
            <div className="row">
              <button onClick={() => setConfirm(false)}>{t('Cancel')}</button>
              <button
                className="primary"
                onClick={() => {
                  setConfirm(false);
                  void run(() => window.meshdrop.registerClipboardShortcut(binding), t('Shortcut added'));
                }}
              >
                {t('Add shortcut')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
