import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { InternetLinks } from '../components/InternetLinks.tsx';
import { fmtBytes } from '../format.ts';
import { t } from '../i18n.ts';

const fmtLeft = (ms: number) => {
  const m = Math.ceil(ms / 60_000);
  const h = Math.floor(m / 60);
  return m >= 60 ? (m % 60 ? t('{h} h {min} min', { h, min: m % 60 }) : t('{h} h', { h })) : t('{min} min', { min: m });
};

/** LAN guests: a one-time QR link for a browser on this network, the files offered to it. */
function LanGuests({ state, run }: { state: AppState; run: Run }) {
  const g = state.guest;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  if (!g) return <p className="muted">{t('Guests are not available here.')}</p>;
  if (!g.available) {
    return <p className="muted">{state.mode === 'client-only' ? t('The MeshDrop background service is receiving on this PC: guest links are not available in this window.') : t('Guest links are not available: their port (53320) is used by another app.')}</p>;
  }
  const minutes = state.settings.guestMinutes;

  if (!g.active || !g.url || !g.qrSvg) {
    return (
      <section>
        <p className="lead">{t('Let someone send you files from their phone\'s browser')}</p>
        <p className="muted">
          {t('They scan a QR code on the same Wi-Fi and get a page where they can send you files and download what you offer. They see nothing else. You accept every send before anything is saved. The link works for one browser, for {time} (change it in Settings).', { time: fmtLeft(minutes * 60_000) })}
        </p>
        <p className="muted">
          {t('A browser cannot check this {device}\'s identity, so a guest link is not encrypted: others on the same Wi-Fi could see what is sent. Use it on networks you trust, and pair devices for anything private.', { device: state.platform === 'android' ? t('phone') : t('PC') })}
        </p>
        <button className="primary" onClick={() => void run(() => window.meshdrop.guestStart())}>
          {t('Show a guest QR code')}
        </button>
      </section>
    );
  }

  const left = Math.max(0, (g.expiresAt ?? 0) - now);
  const src = `data:image/svg+xml;base64,${btoa(g.qrSvg)}`;
  return (
    <section>
      <div className="invite">
        <img className={`qr${left === 0 ? ' expired' : ''}`} src={src} alt={t('Guest QR code')} width={220} height={220} />
        <div className="invite-side">
          <p>{t('Scan with the guest\'s phone camera (same Wi-Fi). The link works for one browser.')}</p>
          <div className="row">
            <input aria-label={t('Guest link')} readOnly value={g.url} className="grow" onFocus={(e) => e.target.select()} />
            <button onClick={() => void run(() => navigator.clipboard.writeText(g.url!), t('Copied'))}>{t('Copy')}</button>
          </div>
          <p className={left === 0 ? 'error-text' : 'muted'}>
            {left === 0 ? t('Expired') : g.claimed ? t('Opened by a guest · {time} left', { time: fmtLeft(left) }) : t('Not opened yet · {time} left', { time: fmtLeft(left) })}
          </p>
          <div className="row">
            <button onClick={() => void run(() => window.meshdrop.guestEnd(), t('Guest link ended'))}>{t('End')}</button>
            {left === 0 && <button onClick={() => void run(() => window.meshdrop.guestStart())}>{t('New guest QR code')}</button>}
          </div>
        </div>
      </div>

      <h2>{t('Files for the guest')}</h2>
      {g.shared.length === 0 ? (
        <p className="muted">{t('Nothing offered yet.')}</p>
      ) : (
        <ul className="list">
          {g.shared.map((f) => (
            <li key={f.id} className="row space" data-shared={f.name}>
              <span>
                {f.name} <span className="muted">· {fmtBytes(f.size)}</span>
              </span>
              <button onClick={() => void run(() => window.meshdrop.guestUnshare(f.id))}>{t('Remove')}</button>
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={() =>
          void run(async () => {
            const paths = await window.meshdrop.pickFiles();
            if (paths.length > 0) await window.meshdrop.guestShare(paths);
          })
        }
      >
        {t('Offer files…')}
      </button>
    </section>
  );
}

/** M11 room mode: one QR, a shared board everyone on the Wi-Fi can post to and download from. */
function RoomMode({ state, run }: { state: AppState; run: Run }) {
  const [title, setTitle] = useState('');
  const [hours, setHours] = useState(3);
  const room = state.room;
  if (!room) return null;
  if (!room.active) {
    return (
      <section>
        <p className="muted">{t('At a party or in a class: everyone scans one QR and gets a shared board. Anyone can post photos and files, and everyone can download them. It ends after the time you pick, and then everything in it is deleted (except what you saved).')}</p>
        <div className="row wrap">
          <input aria-label={t('Room name')} placeholder={t('{name}\'s room', { name: state.settings.alias })} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          <select aria-label={t('Room length')} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 3, 6, 12, 24].map((h) => (
              <option key={h} value={h}>
                {h === 1 ? t('1 hour') : t('{n} hours', { n: h })}
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => void run(() => window.meshdrop.roomStart!(hours * 60, title))}>
            {t('Open a room')}
          </button>
        </div>
      </section>
    );
  }
  return (
    <section>
      <div className="invite">
        {room.qrSvg && <img className="qr" src={`data:image/svg+xml;base64,${btoa(room.qrSvg)}`} alt={t('Room QR code')} width={200} height={200} />}
        <div className="invite-side">
          <p>
            <strong>{room.title}</strong> · {t('until {time}', { time: new Date(room.expiresAt ?? 0).toLocaleTimeString() })}
          </p>
          <div className="row">
            <input aria-label={t('Room link')} readOnly value={room.url ?? ''} className="grow" onFocus={(e) => e.target.select()} />
            <button onClick={() => void run(() => navigator.clipboard.writeText(room.url ?? ''), t('Copied'))}>{t('Copy')}</button>
          </div>
          <div className="row">
            <button onClick={() => void run(async () => window.meshdrop.roomPost!(await window.meshdrop.pickFiles()))}>{t('Post files…')}</button>
            <button onClick={() => void run(async () => {
              for (const p of room.posts) await window.meshdrop.roomSave!(p.id);
            }, t('Saved to Received'))} disabled={room.posts.length === 0}>
              {t('Save all')}
            </button>
            <button className="danger" onClick={() => void run(() => window.meshdrop.roomEnd!(), t('Room ended'))}>
              {t('End room')}
            </button>
          </div>
        </div>
      </div>
      <ul className="list">
        {room.posts.map((p) => (
          <li key={p.id} className="row space">
            <span>
              {p.image ? '🖼' : '📄'} {p.name} <span className="muted">· {fmtBytes(p.size)} · {p.by}</span>
            </span>
            <button onClick={() => void run(() => window.meshdrop.roomSave!(p.id), t('Saved to Received'))}>{t('Save')}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Guests({ state, run }: { state: AppState; run: Run }) {
  return (
    <>
      <LanGuests state={state} run={run} />
      {state.room && (
        <>
          <h2>{t('Room')}</h2>
          <RoomMode state={state} run={run} />
        </>
      )}
      <h2>{t('Internet links')}</h2>
      <InternetLinks state={state} run={run} />
    </>
  );
}
