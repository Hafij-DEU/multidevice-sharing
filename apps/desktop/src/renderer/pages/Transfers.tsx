import type { AppState } from '../../shared/api.ts';
import { ProgressRow } from '../components/ProgressRow.tsx';
import { Peer } from '../components/Peer.tsx';
import { fmtBytes } from '../format.ts';
import type { Run } from '../App.tsx';

const ACTIVE = new Set(['preparing', 'sending', 'receiving']);

export function Transfers({ state, run }: { state: AppState; run: Run }) {
  const active = state.transfers.filter((t) => ACTIVE.has(t.status));
  const past = state.transfers.filter((t) => !ACTIVE.has(t.status)).slice(0, 100);
  return (
    <section>
      <h2>Active</h2>
      {active.length === 0 ? <p className="muted">Nothing is moving right now.</p> : active.map((t) => <ProgressRow key={t.key} t={t} />)}

      <div className="row space">
        <h2>Unfinished sends</h2>
        {state.outbox.length > 0 && <button onClick={() => void run(() => window.meshdrop.resumeOutbox(), 'Resuming…')}>Resume all</button>}
      </div>
      {state.outbox.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="list">
          {state.outbox.map((o) => (
            <li key={o.sessionId} className="row space">
              <span>
                To <Peer text={o.alias ?? o.deviceId.slice(0, 8)} /> <span className="muted">· {o.files} file(s), {fmtBytes(o.bytes)}</span>
              </span>
              <button onClick={() => void run(() => window.meshdrop.removeOutbox(o.sessionId), 'Removed')}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <h2>History</h2>
      {past.length === 0 ? <p className="muted">No transfers yet.</p> : past.map((t) => <ProgressRow key={t.key} t={t} />)}
    </section>
  );
}
