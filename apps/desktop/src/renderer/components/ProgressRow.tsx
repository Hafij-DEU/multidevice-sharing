import type { TransferView } from '../../shared/api.ts';
import { fmtBytes } from '../format.ts';
import { mark, t } from '../i18n.ts';
import { Peer } from './Peer.tsx';

const STATUS: Record<TransferView['status'], string> = {
  preparing: mark('Preparing'), sending: mark('Sending'), receiving: mark('Receiving'), done: mark('Done'),
  held: mark('Held on hub'), waiting: mark('Waiting for device'), failed: mark('Failed'), cancelled: mark('Paused'),
};

/** "12 s", "3 min", "1 h 5 min". */
function fmtLeft(sec: number): string {
  if (sec < 60) return t('{n} s', { n: Math.max(1, Math.round(sec)) });
  const m = Math.round(sec / 60);
  if (m < 60) return t('{n} min', { n: m });
  const h = Math.floor(m / 60);
  return m % 60 ? t('{h} h {m} min', { h, m: m % 60 }) : t('{n} h', { n: h });
}

/** Plain words for the errors people actually meet. */
function explain(tr: TransferView): string {
  const e = tr.error ?? '';
  if (/^http-403\b/.test(e)) return t('{name} has not paired with this device yet. On {name}, open Send → Add a device and press Pair for this device.', { name: tr.alias });
  if (/^http-503 paused/.test(e)) return t('{name} has paused receiving.', { name: tr.alias });
  if (/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timed out/i.test(e)) return t('{name} did not answer. Is MeshDrop open on it, on the same Wi-Fi?', { name: tr.alias });
  return e;
}

export function ProgressRow({ t: tr }: { t: TransferView }) {
  const moving = (tr.status === 'sending' || tr.status === 'receiving') && tr.bytesPerSec !== undefined && tr.bytesPerSec > 0;
  const speed = moving ? t('{speed}/s · {left} left', { speed: fmtBytes(Math.round(tr.bytesPerSec!)), left: fmtLeft((tr.bytes - tr.sent) / tr.bytesPerSec!) }) : null;
  const pct = tr.bytes > 0 ? Math.min(100, Math.floor((tr.sent / tr.bytes) * 100)) : tr.status === 'done' ? 100 : 0;
  return (
    <div className={`progress-row status-${tr.status}`}>
      <div className="progress-head">
        <span className="dir">{tr.direction === 'out' ? t('To') : t('From')}</span> <Peer text={tr.alias} />
        <span className="muted">
          {tr.files > 0 ? `${tr.files === 1 ? t('1 file') : t('{n} files', { n: tr.files })} · ` : ''}
          {t('{sent} of {total}', { sent: fmtBytes(tr.sent), total: fmtBytes(tr.bytes) })} · {pct}%
        </span>
        {speed && <span className="speed">{speed}</span>}
        <span className="status">{t(STATUS[tr.status])}</span>
        {tr.openedAt !== undefined && <span className="badge opened">{t('Opened')}</span>}
      </div>
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
      </div>
      {tr.error && <div className="error-text">{explain(tr)}</div>}
    </div>
  );
}
