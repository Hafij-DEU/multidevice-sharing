import { useEffect, useState } from 'react';
import type { Run } from '../App.tsx';

export interface Invite {
  uri: string;
  qrSvg: string;
  expiresAt: number;
}

const fmtLeft = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A single-use invite: QR image, the link with Copy, and a countdown to its expiry. */
export function QrInvite({ invite, onRenew, run }: { invite: Invite; onRenew: () => void; run: Run }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, invite.expiresAt - now);
  const expired = left === 0;
  // The SVG is ASCII (qrcode output), so btoa is safe.
  const src = `data:image/svg+xml;base64,${btoa(invite.qrSvg)}`;
  return (
    <div className="invite">
      <img className={`qr${expired ? ' expired' : ''}`} src={src} alt="Invite QR code" width={220} height={220} />
      <div className="invite-side">
        <p>
          Scan with the MeshDrop app on the other device, or paste the link there. It works once.
        </p>
        <div className="row">
          <input aria-label="Invite link" readOnly value={invite.uri} className="grow" onFocus={(e) => e.target.select()} />
          <button onClick={() => void run(() => navigator.clipboard.writeText(invite.uri), 'Copied')} disabled={expired}>
            Copy
          </button>
        </div>
        <p className={expired ? 'error-text' : 'muted'}>
          {expired ? 'Expired ' : 'Expires in '}
          <span className="countdown">{fmtLeft(left)}</span>
        </p>
        {expired && <button onClick={onRenew}>New invite</button>}
      </div>
    </div>
  );
}
