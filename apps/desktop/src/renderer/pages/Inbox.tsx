import type { AppState, ReceivedRecord } from '../../shared/api.ts';
import { Peer } from '../components/Peer.tsx';
import { baseName, fmtTime } from '../format.ts';
import type { Run } from '../App.tsx';

const SHOWN = 5;

function Record({ r, run }: { r: ReceivedRecord; run: Run }) {
  const more = r.files.length - SHOWN;
  return (
    <li className="record">
      <div className="row space">
        <span>
          From <Peer text={r.alias} /> <span className="muted">· {fmtTime(r.at)}</span>
          {r.clipboard && <span className="badge">Clipboard</span>}
        </span>
        {r.files.length > 0 && <span className="muted">{r.files.length} file{r.files.length === 1 ? '' : 's'}</span>}
      </div>
      {r.files.length > 0 && (
        <ul className="files">
          {r.files.slice(0, SHOWN).map((f) => (
            <li key={f}>
              <Peer text={baseName(f)} />
              <button className="link" onClick={() => void run(() => window.meshdrop.reveal(f))}>
                Reveal
              </button>
            </li>
          ))}
          {more > 0 && <li className="muted">and {more} more</li>}
        </ul>
      )}
      {r.text !== undefined && (
        <div className="text-block">
          <pre dir="auto" className="peer">
            {r.text}
          </pre>
          <button onClick={() => void run(() => navigator.clipboard.writeText(r.text!), 'Copied')}>Copy</button>
        </div>
      )}
    </li>
  );
}

export function Inbox({ state, run }: { state: AppState; run: Run }) {
  return (
    <section>
      <div className="row space">
        <p className="muted">
          Saved in <code>{state.settings.inbox}</code>
        </p>
        <button onClick={() => void run(() => window.meshdrop.openInbox())}>Open folder</button>
      </div>
      {state.received.length === 0 ? (
        <p className="muted">Nothing received yet.</p>
      ) : (
        <ul className="list">
          {state.received.map((r, i) => (
            <Record key={`${r.at}:${i}`} r={r} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}
