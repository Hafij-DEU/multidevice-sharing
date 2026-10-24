import { useState } from 'react';
import type { AppState } from '../../shared/api.ts';
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
            <li key={d.deviceId} className="row space" data-paired={d.deviceId}>
              <DeviceCard d={d} checked={false} />
              {d.role === 'paired' ? (
                <button className={confirming === d.deviceId ? 'danger' : ''} onClick={() => unpair(d.deviceId, d.alias)}>
                  {confirming === d.deviceId ? 'Tap again to unpair' : 'Unpair'}
                </button>
              ) : (
                <span className="muted">In your mesh{state.hub.role === 'hub' ? ': remove it under Mesh' : ': removed on the hub PC'}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
