import { useEffect, useState } from 'react';
import type { AppState, ReceivedRecord } from '../../shared/api.ts';
import { Peer } from '../components/Peer.tsx';
import { baseName, fmtTime } from '../format.ts';
import type { Run } from '../App.tsx';
import { t } from '../i18n.ts';

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
      (th) => {
        thumbs.set(path, th);
        if (live) setSrc(th);
      },
      () => thumbs.set(path, null),
    );
    return () => {
      live = false;
    };
  }, [path, media]);
  if (!src) return null;
  return (
    <button className="thumb-btn" onClick={onOpen} aria-label={t('Open {name}', { name: baseName(path) })}>
      <img className="thumb" src={src} alt="" />
    </button>
  );
}

function Record({ r, run, android }: { r: ReceivedRecord; run: Run; android: boolean }) {
  const more = r.files.length - SHOWN;
  const [deleting, setDeleting] = useState(false);
  const del = (files: boolean) => void run(() => window.meshdrop.receivedDelete(r.at, r.from, files), files ? t('Deleted') : t('Removed from the list'));
  return (
    <li className={`record${r.pinned ? ' pinned' : ''}`}>
      <div className="row space">
        <span>
          {r.pinned && <span className="badge pin-badge">{t('Pinned')}</span>}
          {t('From')} <Peer text={r.alias} /> <span className="muted">· {fmtTime(r.at)}</span>
          {r.clipboard && <span className="badge">{t('Clipboard')}</span>}
          {r.burn && !r.burned && (
            <span className="badge burn" title={t('Burn after reading')}>
              🔥 {r.burnAt ? t('deleted {time}', { time: fmtTime(r.burnAt) }) : t('deleted 5 min after you open it')}
            </span>
          )}
          {r.burned && <span className="badge">{t('Deleted after reading')}</span>}
        </span>
        <span className="record-actions">
          {r.files.length > 0 && <span className="muted">{r.files.length === 1 ? t('1 file') : t('{n} files', { n: r.files.length })}</span>}
          <button className="icon-btn small" aria-pressed={!!r.pinned} aria-label={r.pinned ? t('Unpin') : t('Pin')} title={r.pinned ? t('Unpin') : t('Pin to the top')} onClick={() => void run(() => window.meshdrop.receivedPin(r.at, r.from, !r.pinned))}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill={r.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3z" />
            </svg>
          </button>
          <button className="icon-btn small" aria-label={t('Delete')} title={t('Delete')} onClick={() => setDeleting(!deleting)}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
            </svg>
          </button>
        </span>
      </div>
      {deleting && (
        <div className="row delete-ask" role="group" aria-label={t('Delete')}>
          {r.files.length > 0 && (
            <button className="danger" onClick={() => del(true)}>
              {r.files.length === 1 ? t('Delete the file') : t('Delete the files')}
            </button>
          )}
          <button onClick={() => del(false)}>{r.files.length > 0 ? t('Only remove from the list') : t('Remove from the list')}</button>
          <button className="link" onClick={() => setDeleting(false)}>
            {t('Cancel')}
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
                  {t('Show in folder')}
                </button>
              )}
            </li>
          ))}
          {more > 0 && <li className="muted">{t('and {n} more', { n: more })}</li>}
        </ul>
      )}
      {r.text !== undefined && (
        <div className="text-block">
          <pre dir="auto" className="peer">
            {r.text}
          </pre>
          <button onClick={() => void run(() => navigator.clipboard.writeText(r.text!), t('Copied'))}>{t('Copy')}</button>
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
          {t('Saved in')} <code>{state.settings.inbox}</code>
        </p>
        <span className="row">
          <button onClick={() => void run(() => window.meshdrop.openInbox())}>{t('Open folder')}</button>
          {unpinned > 0 && (
            <button
              className={clearing ? 'danger' : ''}
              onBlur={() => setClearing(false)}
              onClick={() => {
                if (!clearing) return setClearing(true);
                setClearing(false);
                void run(() => window.meshdrop.receivedClear(), t('History cleared (pinned items and the files stay)'));
              }}
            >
              {clearing ? t('Tap again to clear') : t('Clear history')}
            </button>
          )}
        </span>
      </div>
      {state.received.length === 0 ? (
        <p className="muted">{t('Nothing received yet.')}</p>
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
