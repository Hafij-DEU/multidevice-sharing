import type { GuestView } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { fmtBytes } from '../format.ts';
import { Peer } from './Peer.tsx';

const SAFE_THUMB = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const SHOWN = 50;

/** The accept prompt for a guest's send: names, sizes, browser-made thumbnails and the message. */
export function GuestOffer({ offer, run }: { offer: GuestView['offers'][number]; run: Run }) {
  const total = offer.files.reduce((n, f) => n + f.size, 0);
  return (
    <div className="modal-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby="guest-offer-title" className="modal guest-offer">
        <h2 id="guest-offer-title">A guest wants to send</h2>
        {offer.files.length > 0 && (
          <p className="muted">
            {offer.files.length} file{offer.files.length === 1 ? '' : 's'} · {fmtBytes(total)}
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
          {offer.files.length > SHOWN && <li className="muted">and {offer.files.length - SHOWN} more</li>}
        </ul>
        {offer.text !== undefined && (
          <blockquote className="guest-text">
            <Peer text={offer.text} />
          </blockquote>
        )}
        <div className="row">
          <button onClick={() => void run(() => window.meshdrop.guestReject(offer.id), 'Declined')}>Decline</button>
          <button className="primary" onClick={() => void run(() => window.meshdrop.guestAccept(offer.id), 'Accepted: receiving…')}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
