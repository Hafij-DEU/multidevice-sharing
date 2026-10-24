import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { fmtBytes } from '../format.ts';

const fmtLeft = (ms: number) => {
  const m = Math.ceil(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

/** LAN guests: a one-time QR link for a browser on this network, the files offered to it. */
export function Guests({ state, run }: { state: AppState; run: Run }) {
  const g = state.guest;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  if (!g) return <p className="muted">Guests are not available here.</p>;
  if (!g.available) {
    return <p className="muted">{state.mode === 'client-only' ? 'The MeshDrop background service is receiving on this PC: guest links are not available in this window.' : 'Guest links are not available: their port (53320) is used by another app.'}</p>;
  }
  const minutes = state.settings.guestMinutes;

  if (!g.active || !g.url || !g.qrSvg) {
    return (
      <section>
        <p className="lead">Let someone send you files from their phone's browser</p>
        <p className="muted">
          They scan a QR code on the same Wi-Fi and get a page where they can send you files and download what you offer. They see nothing else. You accept every
          send before anything is saved. The link works for one browser, for {fmtLeft(minutes * 60_000)} (change it in Settings).
        </p>
        <button className="primary" onClick={() => void run(() => window.meshdrop.guestStart())}>
          Show a guest QR code
        </button>
      </section>
    );
  }

  const left = Math.max(0, (g.expiresAt ?? 0) - now);
  const src = `data:image/svg+xml;base64,${btoa(g.qrSvg)}`;
  return (
    <section>
      <div className="invite">
        <img className={`qr${left === 0 ? ' expired' : ''}`} src={src} alt="Guest QR code" width={220} height={220} />
        <div className="invite-side">
          <p>Scan with the guest's phone camera (same Wi-Fi). The link works for one browser.</p>
          <div className="row">
            <input aria-label="Guest link" readOnly value={g.url} className="grow" onFocus={(e) => e.target.select()} />
            <button onClick={() => void run(() => navigator.clipboard.writeText(g.url!), 'Copied')}>Copy</button>
          </div>
          <p className={left === 0 ? 'error-text' : 'muted'}>
            {left === 0 ? 'Expired' : `${g.claimed ? 'Opened by a guest · ' : 'Not opened yet · '}${fmtLeft(left)} left`}
          </p>
          <div className="row">
            <button onClick={() => void run(() => window.meshdrop.guestEnd(), 'Guest link ended')}>End</button>
            {left === 0 && <button onClick={() => void run(() => window.meshdrop.guestStart())}>New guest QR code</button>}
          </div>
        </div>
      </div>

      <h2>Files for the guest</h2>
      {g.shared.length === 0 ? (
        <p className="muted">Nothing offered yet.</p>
      ) : (
        <ul className="list">
          {g.shared.map((f) => (
            <li key={f.id} className="row space" data-shared={f.name}>
              <span>
                {f.name} <span className="muted">· {fmtBytes(f.size)}</span>
              </span>
              <button onClick={() => void run(() => window.meshdrop.guestUnshare(f.id))}>Remove</button>
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
        Offer files…
      </button>
    </section>
  );
}
