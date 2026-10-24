import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { Peer } from '../components/Peer.tsx';
import { fmtTime } from '../format.ts';

/** Folder sync: one folder kept the same on this device and the partners ticked here (same Wi-Fi). */
export function Sync({ state, run }: { state: AppState; run: Run }) {
  const s = state.sync;
  if (!s) return <p className="muted">Folder sync is not available here yet.</p>;
  const ticked = new Set(s.partners.map((p) => p.deviceId));
  const candidates = state.devices.filter((d) => d.trusted && d.role !== 'localsend');
  const set = (folder: string, partners: string[]) => run(() => window.meshdrop.syncSet(folder, partners));
  const toggle = (id: string) => void set(s.folder, ticked.has(id) ? [...ticked].filter((x) => x !== id) : [...ticked, id]);
  const choose = () =>
    void run(async () => {
      const p = await window.meshdrop.pickFolder();
      if (p) await window.meshdrop.syncSet(p, [...ticked]);
    });

  return (
    <section>
      <p className="muted">
        One folder stays the same here and on the devices you tick, whenever both are on the same Wi-Fi. Keep it for files you want everywhere, not your working folders. Both devices must tick each other.
      </p>
      <h2>Folder</h2>
      {s.folder === '' ? (
        <div className="row">
          <button className="primary" onClick={() => void set(s.suggested, [...ticked])}>
            Use {s.suggested}
          </button>
          <button onClick={choose}>Choose another…</button>
        </div>
      ) : (
        <div className="row">
          <code className="grow">{s.folder}</code>
          {window.meshdrop.openSyncFolder && <button onClick={() => void run(() => window.meshdrop.openSyncFolder!())}>Open</button>}
          <button onClick={choose}>Change…</button>
          <button onClick={() => void set('', [...ticked])}>Turn off</button>
        </div>
      )}

      <div className="row space">
        <h2>Sync with</h2>
        {s.folder !== '' && ticked.size > 0 && (
          <button onClick={() => void run(() => window.meshdrop.syncNow(), 'Synced')}>Sync now</button>
        )}
      </div>
      {candidates.length === 0 ? (
        <p className="muted">Pair a device first (Send → Add a device).</p>
      ) : (
        <ul className="list">
          {candidates.map((d) => {
            const p = s.partners.find((x) => x.deviceId === d.deviceId);
            const last = p?.last;
            const status = !p
              ? 'Not synced'
              : p.syncing
                ? 'Syncing…'
                : !p.present
                  ? 'Waiting for it on this Wi-Fi'
                  : last?.error
                    ? `Last try failed: ${last.error}`
                    : last
                      ? `Synced ${fmtTime(last.at)}${last.pulled + last.deleted > 0 ? ` · ${last.pulled} new, ${last.deleted} removed` : ''}${last.conflicts ? ` · ${last.conflicts} conflict(s)` : ''}`
                      : 'On this Wi-Fi';
            return (
              <li key={d.deviceId} className="row space" data-sync={d.deviceId}>
                <label className="toggle">
                  <input type="checkbox" checked={!!p} disabled={s.folder === ''} onChange={() => toggle(d.deviceId)} /> <Peer text={d.alias} />
                </label>
                <span className={last?.error ? 'error-text' : 'muted'}>{status}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted hint">Replaced and deleted files are kept 30 days in the folder&apos;s .meshdrop-trash. If a file changed on both sides, both versions are kept.</p>
    </section>
  );
}
