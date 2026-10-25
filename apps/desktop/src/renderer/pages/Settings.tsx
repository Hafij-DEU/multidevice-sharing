import { useState } from 'react';
import type { AppState, Settings as S } from '../../shared/api.ts';
import type { Run } from '../App.tsx';

const DEFAULT_BINDING = '<Primary><Alt>c';
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

const DESKTOP_ONLY: (keyof S)[] = ['autostart', 'startHidden', 'closeToTray', 'printFromDevices', 'sortInbox'];

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
      {SWITCHES.filter(([k]) => !(android && DESKTOP_ONLY.includes(k))).map(([k, label]) => (
        <label key={k} className="row">
          <input type="checkbox" checked={draft[k] as boolean} onChange={(e) => set(k, e.target.checked as never)} /> {label}
        </label>
      ))}
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
        <button disabled={!dirty} onClick={() => setDraft(state.settings)}>
          Undo changes
        </button>
      </div>

      {android ? (
        <KeepAlive state={state} run={run} />
      ) : (
        <>
      <h2>Keyboard shortcut</h2>
      <p className="muted">Adds a GNOME shortcut that opens a small window to send what is on your clipboard.</p>
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

      {confirm && (
        <div className="modal-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="sc-title" className="modal">
            <h2 id="sc-title">Add this shortcut?</h2>
            <p>
              GNOME will run “MeshDrop: send clipboard” when you press <code>{binding}</code>. Your other custom shortcuts stay as they are.
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
