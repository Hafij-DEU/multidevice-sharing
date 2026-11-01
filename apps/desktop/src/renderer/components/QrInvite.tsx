import { useEffect, useMemo, useState } from 'react';
import type { Run } from '../App.tsx';
import { t } from '../i18n.ts';

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
export function QrInvite({ invite, onRenew, run, group }: { invite: Invite; onRenew: () => void; run: Run; group?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000); // the countdown shows whole seconds
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, invite.expiresAt - now);
  const expired = left === 0;
  // The SVG is ASCII (qrcode output), so btoa is safe.
  const src = useMemo(() => `data:image/svg+xml;base64,${btoa(invite.qrSvg)}`, [invite.qrSvg]);
  return (
    <div className="invite">
      <img className={`qr${expired ? ' expired' : ''}`} src={src} alt={t('Invite QR code')} width={220} height={220} />
      <div className="invite-side">
        <p>
          {group
            ? t('Scan it with the MeshDrop app on each of your devices (Send → Add a device → Scan QR). They all join, and every device then sees every other one.')
            : t('Scan with the MeshDrop app on the other device, or paste the link there. It works once.')}
        </p>
        <div className="row">
          <input aria-label={t('Invite link')} readOnly value={invite.uri} className="grow" onFocus={(e) => e.target.select()} />
          <button onClick={() => void run(() => navigator.clipboard.writeText(invite.uri), t('Copied'))} disabled={expired}>
            {t('Copy')}
          </button>
        </div>
        <p className={expired ? 'error-text' : 'muted'}>
          {expired ? t('Expired') : t('Expires in')}{' '}
          <span className="countdown">{fmtLeft(left)}</span>
        </p>
        {expired && <button onClick={onRenew}>{t('New invite')}</button>}
      </div>
    </div>
  );
}
