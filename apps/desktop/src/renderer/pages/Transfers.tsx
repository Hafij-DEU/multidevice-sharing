import type { AppState } from '../../shared/api.ts';
import { ProgressRow } from '../components/ProgressRow.tsx';
import { Peer } from '../components/Peer.tsx';
import { fmtBytes } from '../format.ts';
import type { Run } from '../App.tsx';

const ACTIVE = new Set(['preparing', 'sending', 'receiving', 'waiting']);

export function Transfers({ state, run }: { state: AppState; run: Run }) {
  const active = state.transfers.filter((t) => ACTIVE.has(t.status));
  const past = state.transfers.filter((t) => !ACTIVE.has(t.status)).slice(0, 100);
  if (active.length === 0 && state.outbox.length === 0 && past.length === 0) return <p className="muted">No transfers yet.</p>;
  return (
    <section>
      {active.length > 0 && (
        <>
          <h2>Now</h2>
          {active.map((t) => (
            <ProgressRow key={t.key} t={t} />
          ))}
        </>
      )}

      {state.outbox.length > 0 && (
        <>
          <div className="row space">
            <h2>Unfinished sends</h2>
            <button onClick={() => void run(() => window.meshdrop.resumeOutbox(), 'Resuming…')}>Resume all</button>
          </div>
          <ul className="list">
            {state.outbox.map((o) => (
              <li key={o.sessionId} className="row space">
                <span>
                  To <Peer text={o.alias ?? o.deviceId.slice(0, 8)} /> <span className="muted">· {o.files} file(s), {fmtBytes(o.bytes)}</span>{' '}
                  <span className={o.waiting ? 'muted' : 'error-text'}>{o.waiting ? '· sends when it is online' : `· stopped${o.error ? `: ${o.error}` : ''}`}</span>
                </span>
                <button onClick={() => void run(() => window.meshdrop.removeOutbox(o.sessionId), 'Send cancelled')}>Cancel send</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2>History</h2>
          {past.map((t) => (
            <ProgressRow key={t.key} t={t} />
          ))}
        </>
      )}
    </section>
  );
}
