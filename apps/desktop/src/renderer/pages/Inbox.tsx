import { useEffect, useState } from 'react';
import type { AppState, ReceivedRecord } from '../../shared/api.ts';
import { Peer } from '../components/Peer.tsx';
import { baseName, fmtTime } from '../format.ts';
import type { Run } from '../App.tsx';

const SHOWN = 5;
const MEDIA = /\.(png|jpe?g|webp|gif|bmp|heic|mp4|mkv|webm|mov|avi|3gp)$/i;
/** Previews already fetched (null: none), shared by every record. */
const thumbs = new Map<string, string | null>();

function Thumb({ path, onOpen }: { path: string; onOpen: () => void }) {
  const media = MEDIA.test(path.split('?')[0] ?? path) || path.startsWith('content://');
  const [src, setSrc] = useState(thumbs.get(path));
  useEffect(() => {
    if (!media || thumbs.has(path)) return;
    let live = true;
    window.meshdrop.thumb(path).then(
      (t) => {
        thumbs.set(path, t);
        if (live) setSrc(t);
      },
      () => thumbs.set(path, null),
    );
    return () => {
      live = false;
    };
  }, [path, media]);
  if (!src) return null;
  return (
    <button className="thumb-btn" onClick={onOpen} aria-label={`Open ${baseName(path)}`}>
      <img className="thumb" src={src} alt="" />
    </button>
  );
}

function Record({ r, run, android }: { r: ReceivedRecord; run: Run; android: boolean }) {
  const more = r.files.length - SHOWN;
  return (
    <li className="record">
      <div className="row space">
        <span>
          From <Peer text={r.alias} /> <span className="muted">· {fmtTime(r.at)}</span>
          {r.clipboard && <span className="badge">Clipboard</span>}
          {r.burn && !r.burned && (
            <span className="badge burn" title="Burn after reading">
              🔥 {r.burnAt ? `deleted ${fmtTime(r.burnAt)}` : 'deleted 5 min after you open it'}
            </span>
          )}
          {r.burned && <span className="badge">Deleted after reading</span>}
        </span>
        {r.files.length > 0 && <span className="muted">{r.files.length} file{r.files.length === 1 ? '' : 's'}</span>}
      </div>
      {r.files.length > 0 && (
        <ul className="files">
          {r.files.slice(0, SHOWN).map((f) => (
            <li key={f}>
              <Thumb path={f} onOpen={() => void run(() => window.meshdrop.openFile(f))} />
              <button className="link file-name" onClick={() => void run(() => window.meshdrop.openFile(f))}>
                <Peer text={baseName(f)} />
              </button>
              {!android && (
                <button className="link" onClick={() => void run(() => window.meshdrop.reveal(f))}>
                  Show in folder
                </button>
              )}
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
            <Record key={`${r.at}:${i}`} r={r} run={run} android={state.platform === 'android'} />
          ))}
        </ul>
      )}
    </section>
  );
}
