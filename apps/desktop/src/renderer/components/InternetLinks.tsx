import { useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { baseName, fmtBytes, fmtTime } from '../format.ts';

const LENGTHS: [number, string][] = [[1 / 24, '1 hour'], [1, '1 day'], [7, '7 days'], [30, '30 days']];

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
  const [made, setMade] = useState<{ url: string; qrSvg: string } | null>(null);
  const isHub = state.hub.role === 'hub';
  if (!state.links || (!isHub && !state.hub.online)) {
    return (
      <p className="muted">
        {state.hub.role === 'member'
          ? 'Internet links need a link to the hub PC or a relay hub: not connected right now.'
          : 'Internet links need a mesh (Mesh → Create a mesh on the PC). They need a hub address on the internet.'}
      </p>
    );
  }
  const create = () =>
    run(async () => {
      const r = await window.meshdrop.linkCreate({
        files, days, allowUploads: isHub && uploads,
        ...(password ? { password } : {}),
        ...(max ? { maxDownloads: Number(max) } : {}),
      });
      setMade(r);
      setFiles([]);
      setPassword('');
      return 'Link created';
    });
  return (
    <div className="links">
      {isHub && state.hub.urls.length === 0 && <p className="muted">This hub has no internet address yet (Mesh → Hub address): a link works only on this PC until it has one.</p>}
      {!isHub && <p className="muted">Sealed on this device; the {state.hub.linkedTo === 'relay' ? 'relay hub' : 'hub PC'} keeps only the encrypted files.</p>}
      <div className="row">
        <button onClick={() => void run(async () => setFiles([...files, ...(await window.meshdrop.pickFiles())]))}>Choose files…</button>
        <span className="muted">{files.length ? files.map(baseName).join(', ') : 'No files chosen'}</span>
      </div>
      <div className="row">
        <label>
          Works for{' '}
          <select aria-label="Link length" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {LENGTHS.map(([d, t]) => (
              <option key={t} value={d}>{t}</option>
            ))}
          </select>
        </label>
        <input aria-label="Link password" type="password" placeholder="Password (optional)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input aria-label="Download limit" type="number" min={1} max={1000} placeholder="Downloads (any)" value={max} onChange={(e) => setMax(e.target.value)} />
      </div>
      {isHub && (
        <label className="row">
          <input type="checkbox" checked={uploads} onChange={(e) => setUploads(e.target.checked)} /> Let them send files back (you accept each send)
        </label>
      )}
      <button className="primary" disabled={files.length === 0} onClick={() => void create()}>
        Create link
      </button>
      {made && (
        <div className="invite">
          <img className="qr" src={`data:image/svg+xml;base64,${btoa(made.qrSvg)}`} alt="Link QR code" width={180} height={180} />
          <div className="invite-side">
            <input aria-label="New link" readOnly value={made.url} className="grow" onFocus={(e) => e.target.select()} />
            <button onClick={() => void run(() => navigator.clipboard.writeText(made.url), 'Copied')}>Copy</button>
            <p className="muted">Anyone with the whole link can open it. The part after # is the key: the hub never sees it.</p>
          </div>
        </div>
      )}
      <ul className="list">
        {state.links.map((l) => (
          <li key={l.id} className="row space" data-link={l.id}>
            <span>
              {l.label} <span className="muted">· {fmtBytes(l.bytes)} · until {fmtTime(l.expiresAt)} · {l.downloads}{l.maxDownloads ? `/${l.maxDownloads}` : ''} opened{l.hasPassword ? ' · password' : ''}{l.allowUploads ? ' · uploads' : ''}</span>
            </span>
            <span className="row">
              {l.url && <button onClick={() => void run(() => navigator.clipboard.writeText(l.url!), 'Copied')}>Copy link</button>}
              <button onClick={() => void run(() => window.meshdrop.linkRevoke(l.id), 'Link removed')}>Remove</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
