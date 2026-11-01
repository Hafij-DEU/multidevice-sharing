import { useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { baseName, fmtBytes, fmtTime } from '../format.ts';
import { mark, t } from '../i18n.ts';

const LENGTHS: [number, string][] = [[1 / 24, mark('1 hour')], [1, mark('1 day')], [7, mark('7 days')], [30, mark('30 days')]];

/**
 * Encrypted links for people outside this network (the key lives only in the link). The hub PC makes
 * them itself; a member device seals them here and its hub (or a relay hub) serves the ciphertext.
 */
export function InternetLinks({ state, run }: { state: AppState; run: Run }) {
  const [files, setFiles] = useState<string[]>([]);
  const [days, setDays] = useState(7);
  const [password, setPassword] = useState('');
  const [max, setMax] = useState('');
  const [uploads, setUploads] = useState(false);
  const [auto, setAuto] = useState(false);
  const [made, setMade] = useState<{ url: string; qrSvg: string } | null>(null);
  const isHub = state.hub.role === 'hub';
  if (!state.links || (!isHub && !state.hub.online)) {
    return (
      <p className="muted">
        {state.hub.role === 'member'
          ? t('Internet links need a link to the hub PC or a relay hub: not connected right now.')
          : t('Internet links need a mesh (Mesh → Create a mesh on the PC). They need a hub address on the internet.')}
      </p>
    );
  }
  const dropBox = isHub && uploads && files.length === 0;
  const create = () =>
    run(async () => {
      const r = await window.meshdrop.linkCreate({
        files, days, allowUploads: dropBox || (isHub && uploads), autoAccept: isHub && uploads && auto,
        // no files: a drop box, where they only send to you
        ...(files.length === 0 ? { text: 'Send your files here.' } : {}),
        ...(password ? { password } : {}),
        ...(max ? { maxDownloads: Number(max) } : {}),
      });
      setMade(r);
      setFiles([]);
      setPassword('');
      return t('Link created');
    });
  return (
    <div className="links">
      {isHub && state.hub.urls.length === 0 && <p className="muted">{t('This hub has no internet address yet (Mesh → Hub address): a link works only on this PC until it has one.')}</p>}
      {!isHub && <p className="muted">{state.hub.linkedTo === 'relay' ? t('Sealed on this device; the relay hub keeps only the encrypted files.') : t('Sealed on this device; the hub PC keeps only the encrypted files.')}</p>}
      <div className="row">
        <button onClick={() => void run(async () => setFiles([...files, ...(await window.meshdrop.pickFiles())]))}>{t('Choose files…')}</button>
        <span className="muted">{files.length ? files.map(baseName).join(', ') : t('No files chosen')}</span>
      </div>
      <div className="row">
        <label>
          {t('Works for')}{' '}
          <select aria-label={t('Link length')} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {LENGTHS.map(([d, label]) => (
              <option key={label} value={d}>{t(label)}</option>
            ))}
          </select>
        </label>
        <input aria-label={t('Link password')} type="password" placeholder={t('Password (optional)')} value={password} onChange={(e) => setPassword(e.target.value)} />
        <input aria-label={t('Download limit')} type="number" min={1} max={1000} placeholder={t('Downloads (any)')} value={max} onChange={(e) => setMax(e.target.value)} />
      </div>
      {isHub && (
        <label className="toggle">
          <input type="checkbox" checked={uploads} onChange={(e) => setUploads(e.target.checked)} /> {t('Let them send files to you (with no files chosen, the link is only for that)')}
        </label>
      )}
      {isHub && uploads && (
        <label className="toggle">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t('Accept their files without asking me (they land in your inbox at once)')}
        </label>
      )}
      <button className="primary" disabled={files.length === 0 && !dropBox} onClick={() => void create()}>
        {dropBox ? t('Create a link they send files to') : t('Create link')}
      </button>
      {made && (
        <div className="invite">
          <img className="qr" src={`data:image/svg+xml;base64,${btoa(made.qrSvg)}`} alt={t('Link QR code')} width={180} height={180} />
          <div className="invite-side">
            <input aria-label={t('New link')} readOnly value={made.url} className="grow" onFocus={(e) => e.target.select()} />
            <button onClick={() => void run(() => navigator.clipboard.writeText(made.url), t('Copied'))}>{t('Copy')}</button>
            <p className="muted">{t('Anyone with the whole link can open it. The part after # is the key: the hub never sees it.')}</p>
          </div>
        </div>
      )}
      <ul className="list">
        {state.links.map((l) => (
          <li key={l.id} className="row space" data-link={l.id}>
            <span>
              {l.label} <span className="muted">· {fmtBytes(l.bytes)} · {t('until {time}', { time: fmtTime(l.expiresAt) })} · {t('{n} opened', { n: `${l.downloads}${l.maxDownloads ? `/${l.maxDownloads}` : ''}` })}{l.hasPassword ? ` · ${t('password')}` : ''}{l.allowUploads ? ` · ${l.autoAccept ? t('uploads, accepted beforehand') : t('uploads')}` : ''}</span>
            </span>
            <span className="row">
              {l.url && <button onClick={() => void run(() => navigator.clipboard.writeText(l.url!), t('Copied'))}>{t('Copy link')}</button>}
              <button onClick={() => void run(() => window.meshdrop.linkRevoke(l.id), t('Link removed'))}>{t('Remove')}</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
