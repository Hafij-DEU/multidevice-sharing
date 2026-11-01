import type { AppState } from '../../shared/api.ts';
import { ProgressRow } from '../components/ProgressRow.tsx';
import { Peer } from '../components/Peer.tsx';
import { fmtBytes } from '../format.ts';
import type { Run } from '../App.tsx';
import { t } from '../i18n.ts';

const ACTIVE = new Set(['preparing', 'sending', 'receiving', 'waiting']);

export function Transfers({ state, run }: { state: AppState; run: Run }) {
  const active = state.transfers.filter((x) => ACTIVE.has(x.status));
  const past = state.transfers.filter((x) => !ACTIVE.has(x.status)).slice(0, 100);
  if (active.length === 0 && state.outbox.length === 0 && past.length === 0) return <p className="muted">{t('No transfers yet.')}</p>;
  return (
    <section>
      {active.length > 0 && (
        <>
          <h2>{t('Now')}</h2>
          {active.map((x) => (
            <ProgressRow key={x.key} t={x} />
          ))}
        </>
      )}

      {state.outbox.length > 0 && (
        <>
          <div className="row space">
            <h2>{t('Unfinished sends')}</h2>
            <button onClick={() => void run(() => window.meshdrop.resumeOutbox(), t('Resuming…'))}>{t('Resume all')}</button>
          </div>
          <ul className="list">
            {state.outbox.map((o) => (
              <li key={o.sessionId} className="row space">
                <span>
                  {t('To')} <Peer text={o.alias ?? o.deviceId.slice(0, 8)} />{' '}
                  <span className="muted">· {t('{n} file(s), {size}', { n: o.files, size: fmtBytes(o.bytes) })}</span>{' '}
                  <span className={o.waiting ? 'muted' : 'error-text'}>
                    · {o.waiting ? t('sends when it is online') : o.error ? t('stopped: {error}', { error: o.error }) : t('stopped')}
                  </span>
                </span>
                <button onClick={() => void run(() => window.meshdrop.removeOutbox(o.sessionId), t('Send cancelled'))}>{t('Cancel send')}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2>{t('History')}</h2>
          {past.map((x) => (
            <ProgressRow key={x.key} t={x} />
          ))}
        </>
      )}
    </section>
  );
}
