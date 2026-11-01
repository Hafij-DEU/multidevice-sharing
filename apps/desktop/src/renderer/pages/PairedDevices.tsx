import { useState } from 'react';
import type { AppState, LinkMode } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { DeviceCard } from '../components/DeviceCard.tsx';

/** The devices this one trusts: unpair a paired one (Pair re-pairs it); mesh members are managed on the hub. */
export function PairedDevices({ state, run }: { state: AppState; run: Run }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const trusted = state.devices.filter((d) => d.trusted);
  const unpair = (id: string, alias: string) => {
    if (confirming !== id) {
      setConfirming(id);
      setTimeout(() => setConfirming((c) => (c === id ? null : c)), 4000);
      return;
    }
    setConfirming(null);
    void run(() => window.meshdrop.unpair(id), `Unpaired ${alias}. To pair again: Send → Add a device → Pair (on both devices).`);
  };
  return (
    <section>
      <p className="muted">Unpair a device to stop trusting it, or to pair it again from scratch (for example after reinstalling MeshDrop on it).</p>
      {trusted.length === 0 ? (
        <p className="muted">No paired devices yet. Pair one on the Send page (Add a device).</p>
      ) : (
        <ul className="list paired">
          {trusted.map((d) => (
            <li key={d.deviceId} data-paired={d.deviceId}>
              <DeviceCard d={d} checked={false} />
              <div className="paired-actions">
                {state.settings.bluetooth && <Connection id={d.deviceId} alias={d.alias} state={state} run={run} />}
                {d.role === 'paired' ? (
                  <button className={confirming === d.deviceId ? 'danger' : ''} onClick={() => unpair(d.deviceId, d.alias)}>
                    {confirming === d.deviceId ? 'Tap again to unpair' : 'Unpair'}
                  </button>
                ) : (
                  <span className="muted">In your mesh{state.hub.role === 'hub' ? ': remove it under Mesh' : ': removed on the hub PC'}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {window.meshdrop.setupPhones && <PhoneSetup run={run} />}
    </section>
  );
}

const MODES: [LinkMode, string][] = [
  ['auto', 'Auto'],
  ['wifi', 'Wi-Fi only'],
  ['bt', 'Bluetooth only'],
];

/** M14: how this device is reached: the network, else Bluetooth (Auto), only the network, or only Bluetooth. */
function Connection({ id, alias, state, run }: { id: string; alias: string; state: AppState; run: Run }) {
  const s = state.settings;
  const mode: LinkMode = s.allBluetooth ? 'bt' : (s.deviceLinks[id] ?? 'auto');
  const choose = (m: LinkMode) => {
    const next = { ...s.deviceLinks };
    if (m === 'auto') delete next[id];
    else next[id] = m;
    void run(() => window.meshdrop.setSettings({ deviceLinks: next }));
  };
  return (
    <label className="paired-link" title={s.allBluetooth ? 'Everything goes over Bluetooth (Settings → No Wi-Fi)' : undefined}>
      <span className="muted">Connection</span>
      <select aria-label={`Connection for ${alias}`} value={mode} disabled={s.allBluetooth} onChange={(e) => choose(e.target.value as LinkMode)}>
        {MODES.map(([m, label]) => (
          <option key={m} value={m}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

type SetupResult = Awaited<ReturnType<NonNullable<typeof window.meshdrop.setupPhones>>>;

const WHY: Record<Exclude<SetupResult[number]['status'], 'done'>, string> = {
  unauthorized: 'On the phone, tap Allow on "Allow USB debugging?", then press the button again.',
  'not-installed': 'Install MeshDrop on it first (App Hub, or the APK).',
  offline: 'The phone is not answering: unplug it and plug it in again.',
  failed: 'Could not talk to the phone.',
};

/** Keeps MeshDrop running on a phone that stops apps in the background, without a terminal. */
function PhoneSetup({ run }: { run: Run }) {
  const [res, setRes] = useState<SetupResult | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>Set up a phone (USB)</h2>
      <p className="muted">
        Some phones (Xiaomi above all) stop apps in the background. Plug the phone into this PC with USB debugging on (Settings → Developer options), then press the
        button: MeshDrop is allowed to run in the background, start by itself and use the camera, microphone and notifications, with no questions later. Nothing
        else on the phone changes; you can turn USB debugging off afterwards.
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setBusy(true);
            try {
              const r = await window.meshdrop.setupPhones!();
              setRes(r);
              if (r.length === 0) throw new Error('No phone found. Plug it in with USB debugging on, and allow this PC on the phone.');
            } finally {
              setBusy(false);
            }
          })
        }
      >
        {busy ? 'Setting up…' : 'Set up plugged-in phones'}
      </button>
      {res && res.length > 0 && (
        <ul className="list">
          {res.map((p) => (
            <li key={p.serial}>
              <strong>{p.model}</strong>{' '}
              {p.status === 'done' ? (
                <span className="ok-text">
                  ready: {p.steps.filter((s) => s.ok).length} of {p.steps.length} settings applied (the rest do not apply to this phone)
                </span>
              ) : (
                <span className="error-text">{WHY[p.status]}</span>
              )}
              {p.hint && <div className="muted">{p.hint}</div>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
