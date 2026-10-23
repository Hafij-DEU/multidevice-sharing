import type { TransferView } from '../../shared/api.ts';
import { fmtBytes } from '../format.ts';
import { Peer } from './Peer.tsx';

const STATUS: Record<TransferView['status'], string> = {
  preparing: 'Preparing', sending: 'Sending', receiving: 'Receiving', done: 'Done',
  held: 'Held on hub', failed: 'Failed', cancelled: 'Paused',
};

export function ProgressRow({ t }: { t: TransferView }) {
  const pct = t.bytes > 0 ? Math.min(100, Math.floor((t.sent / t.bytes) * 100)) : t.status === 'done' ? 100 : 0;
  return (
    <div className={`progress-row status-${t.status}`}>
      <div className="progress-head">
        <span className="dir">{t.direction === 'out' ? 'To' : 'From'}</span> <Peer text={t.alias} />
        <span className="muted">
          {t.files > 0 ? `${t.files} file${t.files === 1 ? '' : 's'} · ` : ''}
          {fmtBytes(t.sent)} of {fmtBytes(t.bytes)} · {pct}%
        </span>
        <span className="status">{STATUS[t.status]}</span>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
      </div>
      {t.error && <div className="error-text">{t.error}</div>}
    </div>
  );
}
