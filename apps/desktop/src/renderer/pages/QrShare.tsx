import { useEffect, useState } from 'react';
import type { AppState, QrShareStatus } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { fmtBytes } from '../format.ts';

/** Polls the Share to Xiaomi add-on while the page is open. */
export function useQrShare(): [QrShareStatus | null, (s: QrShareStatus) => void] {
  const [st, setSt] = useState<QrShareStatus | null>(null);
  useEffect(() => {
    const api = window.meshdrop;
    if (!api.qrShareStatus) return;
    let live = true;
    const tick = () =>
      api.qrShareStatus!()
        .then((s) => live && setSt(s))
        .catch(() => undefined);
    void tick();
    const t = setInterval(tick, 700);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return [st, setSt];
}

/** The switch in Settings → Add-ons. */
export function QrShareSwitch({ run }: { run: Run }) {
  const [st, setSt] = useQrShare();
  const api = window.meshdrop;
  if (!api.qrShareSetEnabled || !st) return null;
  const set = api.qrShareSetEnabled;
  return (
    <>
      <h2>Add-ons</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={st.enabled}
          onChange={(e) => {
            const on = e.target.checked;
            void run(() => set(on)).then((s) => s && setSt(s));
          }}
        />
        <span>
          <b>Share to Xiaomi</b> <span className="muted">— send to and receive from Xiaomi phones (ShareMe), using the app they already have (More → Share to Xiaomi)</span>
        </span>
      </label>
    </>
  );
}

const BUSY = new Set(['joining', 'connecting', 'waiting', 'transferring']);

export function QrShare({ run }: { state: AppState; run: Run }) {
  const [st, setSt] = useQrShare();
  const [showLog, setShowLog] = useState(false);
  const api = window.meshdrop;
  if (!st) return <p className="muted">Loading…</p>;

  if (!st.enabled)
    return (
      <div className="sm-card sm-off">
        <p className="lead">Share to Xiaomi is off</p>
        <p className="muted">Swap files with Xiaomi phones (ShareMe): they use their app, you use MeshDrop.</p>
        <p className="muted" style={{ fontSize: 12 }}>Not affiliated with Xiaomi. ShareMe is a trademark of Xiaomi.</p>
        <button className="primary" onClick={() => void run(() => api.qrShareSetEnabled!(true)).then((s) => s && setSt(s))}>
          Turn on Share to Xiaomi
        </button>
      </div>
    );

  const send = async () => {
    if (!api.scanQr || !api.chooseItems) return;
    const code = await run(() => api.scanQr!());
    if (!code) return;
    const items = await run(() => api.chooseItems!());
    if (!items?.length) return;
    const s = await run(() => api.qrShareSend!(code, items));
    if (s) setSt(s);
  };
  const receive = async () => {
    const s = await run(() => api.qrShareReceive!());
    if (s) setSt(s);
  };
  const stop = async () => {
    const s = await run(() => api.qrShareStop!());
    if (s) setSt(s);
  };

  const idle = st.mode === 'idle';
  const busy = BUSY.has(st.phase);
  const pct = st.total > 0 ? Math.min(100, Math.round((st.done / st.total) * 100)) : 0;

  return (
    <div className="sm">
      {idle ? (
        <div className="sm-pick">
          <button className="sm-big sm-send" onClick={() => void send()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12l16-8-6 16-2-7-8-1z" />
            </svg>
            <span className="sm-big-title">Send</span>
            <span className="sm-big-hint">On their phone: open ShareMe → Receive. Scan its code, pick files.</span>
          </button>
          <button className="sm-big sm-recv" onClick={() => void receive()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
            </svg>
            <span className="sm-big-title">Receive</span>
            <span className="sm-big-hint">Shows a code. On their phone: open ShareMe → Send, pick files, scan it.</span>
          </button>
        </div>
      ) : (
        <div className="sm-card">
          <div className="sm-head">
            <span className={`sm-badge sm-${st.phase}`}>{st.mode === 'send' ? 'Sending' : 'Receiving'}</span>
            {st.peer && <b>{st.peer}</b>}
            <span className="space" />
            <button className={busy ? 'danger' : ''} onClick={() => void stop()}>
              {busy ? 'Cancel' : st.phase === 'ready' || st.mode === 'receive' ? 'Stop' : 'Done'}
            </button>
          </div>
          <p className={st.phase === 'error' ? 'error-text' : st.phase === 'done' ? 'ok-text' : ''}>{st.text}</p>
          {st.qrSvg && st.mode === 'receive' && !busy && (
            <div className="sm-qr qr" dangerouslySetInnerHTML={{ __html: st.qrSvg }} />
          )}
          {st.total > 0 && (
            <div className="sm-progress">
              <div className="sm-bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              <span className="muted">
                {fmtBytes(st.done)} / {fmtBytes(st.total)} · {pct}%
              </span>
            </div>
          )}
          {st.files.length > 0 && (
            <ul className="sm-files">
              {st.files.map((f, i) => (
                <li key={i}>
                  <span className={`sm-dot${f.done ? ' on' : ''}`} />
                  <span className="sm-name">{f.name}</span>
                  <span className="muted">{fmtBytes(f.size)}</span>
                  {f.located && api.qrShareOpen && (
                    <button className="link" onClick={() => void run(() => api.qrShareOpen!(f.located!))}>
                      Open
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {st.log.length > 0 && (
        <details className="sm-log" open={showLog} onToggle={(e) => setShowLog((e.target as HTMLDetailsElement).open)}>
          <summary className="muted">Details</summary>
          <pre>{st.log.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}
