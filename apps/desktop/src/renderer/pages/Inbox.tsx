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
  const [deleting, setDeleting] = useState(false);
  const del = (files: boolean) => void run(() => window.meshdrop.receivedDelete(r.at, r.from, files), files ? 'Deleted' : 'Removed from the list');
  return (
    <li className={`record${r.pinned ? ' pinned' : ''}`}>
      <div className="row space">
        <span>
          {r.pinned && <span className="badge pin-badge">Pinned</span>}
          From <Peer text={r.alias} /> <span className="muted">· {fmtTime(r.at)}</span>
          {r.clipboard && <span className="badge">Clipboard</span>}
          {r.burn && !r.burned && (
            <span className="badge burn" title="Burn after reading">
              🔥 {r.burnAt ? `deleted ${fmtTime(r.burnAt)}` : 'deleted 5 min after you open it'}
            </span>
          )}
          {r.burned && <span className="badge">Deleted after reading</span>}
        </span>
        <span className="record-actions">
          {r.files.length > 0 && <span className="muted">{r.files.length} file{r.files.length === 1 ? '' : 's'}</span>}
          <button className="icon-btn small" aria-pressed={!!r.pinned} aria-label={r.pinned ? 'Unpin' : 'Pin'} title={r.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => void run(() => window.meshdrop.receivedPin(r.at, r.from, !r.pinned))}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill={r.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3z" />
            </svg>
          </button>
          <button className="icon-btn small" aria-label="Delete" title="Delete" onClick={() => setDeleting(!deleting)}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
            </svg>
          </button>
        </span>
      </div>
      {deleting && (
        <div className="row delete-ask" role="group" aria-label="Delete">
          {r.files.length > 0 && (
            <button className="danger" onClick={() => del(true)}>
              Delete the file{r.files.length === 1 ? '' : 's'}
            </button>
          )}
          <button onClick={() => del(false)}>{r.files.length > 0 ? 'Only remove from the list' : 'Remove from the list'}</button>
          <button className="link" onClick={() => setDeleting(false)}>
            Cancel
          </button>
        </div>
      )}
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
  const [clearing, setClearing] = useState(false);
  // pinned records first, each group newest first (the store keeps newest first)
  const list = [...state.received.filter((r) => r.pinned), ...state.received.filter((r) => !r.pinned)];
  const unpinned = state.received.length - state.received.filter((r) => r.pinned).length;
  return (
    <section>
      <div className="row space">
        <p className="muted">
          Saved in <code>{state.settings.inbox}</code>
        </p>
        <span className="row">
          <button onClick={() => void run(() => window.meshdrop.openInbox())}>Open folder</button>
          {unpinned > 0 && (
            <button
              className={clearing ? 'danger' : ''}
              onBlur={() => setClearing(false)}
              onClick={() => {
                if (!clearing) return setClearing(true);
                setClearing(false);
                void run(() => window.meshdrop.receivedClear(), 'History cleared (pinned items and the files stay)');
              }}
            >
              {clearing ? 'Tap again to clear' : 'Clear history'}
            </button>
          )}
        </span>
      </div>
      {state.received.length === 0 ? (
        <p className="muted">Nothing received yet.</p>
      ) : (
        <ul className="list">
          {list.map((r) => (
            <Record key={`${r.at}:${r.from}`} r={r} run={run} android={state.platform === 'android'} />
          ))}
        </ul>
      )}
    </section>
  );
}
