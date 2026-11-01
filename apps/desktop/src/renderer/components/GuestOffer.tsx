import type { GuestView } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { fmtBytes } from '../format.ts';
import { t } from '../i18n.ts';
import { Peer } from './Peer.tsx';

const SAFE_THUMB = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const SHOWN = 50;

/** The accept prompt for a guest's send: names, sizes, browser-made thumbnails and the message. */
export function GuestOffer({ offer, run }: { offer: GuestView['offers'][number]; run: Run }) {
  const total = offer.files.reduce((n, f) => n + f.size, 0);
  return (
    <div className="modal-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby="guest-offer-title" className="modal guest-offer">
        <h2 id="guest-offer-title">
          {offer.via === 'link' ? t('Someone with your link wants to send')
            : offer.via === 'localsend' ? <><Peer text={offer.alias ?? t('A LocalSend device')} /> {t('(LocalSend) wants to send')}</>
            : offer.via === 'addon' ? <><Peer text={offer.alias ?? t('A nearby device')} /> (<Peer text={offer.transport ?? t('add-on')} />) {t('wants to send')}</>
            : t('A guest wants to send')}
        </h2>
        {offer.pin && (
          <p className="guest-pin">
            {t('Check that the other screen shows')} <strong><Peer text={offer.pin} /></strong>
          </p>
        )}
        {offer.files.length > 0 && (
          <p className="muted">
            {offer.files.length === 1 ? t('1 file') : t('{n} files', { n: offer.files.length })} · {fmtBytes(total)}
          </p>
        )}
        <ul className="files">
          {offer.files.slice(0, SHOWN).map((f, i) => (
            <li key={i} className="row">
              {f.thumb && SAFE_THUMB.test(f.thumb) ? <img className="thumb" src={f.thumb} alt="" width={48} height={48} /> : <span className="thumb" />}
              <span className="grow">
                <Peer text={f.name} />
              </span>
              <span className="muted">{fmtBytes(f.size)}</span>
            </li>
          ))}
          {offer.files.length > SHOWN && <li className="muted">{t('and {n} more', { n: offer.files.length - SHOWN })}</li>}
        </ul>
        {offer.text !== undefined && (
          <blockquote className="guest-text">
            <Peer text={offer.text} />
          </blockquote>
        )}
        <div className="row">
          <button onClick={() => void run(() => window.meshdrop.guestReject(offer.id), t('Declined'))}>{t('Decline')}</button>
          <button className="primary" onClick={() => void run(() => window.meshdrop.guestAccept(offer.id), t('Accepted: receiving…'))}>
            {t('Accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
