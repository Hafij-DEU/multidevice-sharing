import type { TransferView } from '../../shared/api.ts';
import { fmtBytes } from '../format.ts';
import { Peer } from './Peer.tsx';

const STATUS: Record<TransferView['status'], string> = {
  preparing: 'Preparing', sending: 'Sending', receiving: 'Receiving', done: 'Done',
  held: 'Held on hub', waiting: 'Waiting for device', failed: 'Failed', cancelled: 'Paused',
};

/** "12 s", "3 min", "1 h 5 min". */
function fmtLeft(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export function ProgressRow({ t }: { t: TransferView }) {
  const moving = (t.status === 'sending' || t.status === 'receiving') && t.bytesPerSec !== undefined && t.bytesPerSec > 0;
  const speed = moving ? `${fmtBytes(Math.round(t.bytesPerSec!))}/s · ${fmtLeft((t.bytes - t.sent) / t.bytesPerSec!)} left` : null;
  const pct = t.bytes > 0 ? Math.min(100, Math.floor((t.sent / t.bytes) * 100)) : t.status === 'done' ? 100 : 0;
  return (
    <div className={`progress-row status-${t.status}`}>
      <div className="progress-head">
        <span className="dir">{t.direction === 'out' ? 'To' : 'From'}</span> <Peer text={t.alias} />
        <span className="muted">
          {t.files > 0 ? `${t.files} file${t.files === 1 ? '' : 's'} · ` : ''}
          {fmtBytes(t.sent)} of {fmtBytes(t.bytes)} · {pct}%
        </span>
        {speed && <span className="speed">{speed}</span>}
        <span className="status">{STATUS[t.status]}</span>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
      </div>
      {t.error && <div className="error-text">{t.error}</div>}
    </div>
  );
}
