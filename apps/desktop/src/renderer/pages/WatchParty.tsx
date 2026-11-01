import { useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { t } from '../i18n.ts';

/** M12: host a watch party (one 6-character code), or join one by its code. */
export function WatchParty({ state, run }: { state: AppState; run: Run }) {
  const android = state.platform === 'android';
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [made, setMade] = useState<{ code: string; links: string[]; hostToken: string; qrSvg: string; qrSvgs?: string[] } | null>(null);
  const rooms = state.watch ?? [];
  const open = (url: string) => run(() => window.meshdrop.watchOpen!(url));
  const hostLink = (links: string[], token?: string) => {
    const l = links[0] ?? '';
    return token ? `${l}#h=${token}` : l;
  };

  return (
    <section>
      <p className="lead">{t('Watch together, in step')}</p>
      <p className="muted">
        {t('Host a room and share its 6-character code. Everyone sees the same moment: play, pause, jump and speed follow along for everybody. YouTube, Google Drive and Dropbox links, links to video files, and videos from your {device} all work. Friends without MeshDrop join in their browser.', { device: android ? t('phone') : t('PC') })}
      </p>

      <h2>{t('Host a watch party')}</h2>
      <div className="row wrap">
        <input aria-label={t('Room name')} placeholder={t('Movie night')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button
          className="primary"
          onClick={() =>
            void run(async () => {
              const r = await window.meshdrop.watchCreate!(name.trim() || t('{name}\'s watch party', { name: state.settings.alias }));
              setMade(r);
              if (r.links[0]) await window.meshdrop.watchOpen!(hostLink(r.links, r.hostToken));
            })
          }
        >
          {t('Start a room')}
        </button>
      </div>
      {made && (
        <>
          <p className="watch-code" aria-label={t('Room code')}>
            {made.code}
          </p>
          {made.links.map((l, i) => {
            // every link gets its own QR code: the internet one and the Wi-Fi one
            const svg = made.qrSvgs?.[i] ?? (i === 0 ? made.qrSvg : '');
            const net = /^https:/.test(l);
            return (
              <div key={l} className="invite">
                {svg && <img className="qr" src={`data:image/svg+xml;base64,${btoa(svg)}`} alt={net ? t('Internet link QR code') : t('Wi-Fi link QR code')} width={180} height={180} />}
                <div className="invite-side">
                  <p>
                    <b>{net ? t('From anywhere') : android ? t('On the same Wi-Fi as the PC') : t('On the same Wi-Fi as this PC')}</b>
                  </p>
                  <div className="row">
                    <input readOnly value={l} className="grow" aria-label={t('Room link')} onFocus={(e) => e.target.select()} />
                    <button onClick={() => void run(() => navigator.clipboard.writeText(l), t('Copied'))}>{t('Copy')}</button>
                  </div>
                  {!net && <p className="muted">{t('Phones on the PC\'s Wi-Fi or hotspot open this one, no internet needed.')}</p>}
                </div>
              </div>
            );
          })}
          {made.links.length > 0 && !made.links.some((l) => /^https:/.test(l)) && (
            <p className="muted">{t('This link works on this Wi-Fi. For friends elsewhere, give the hub PC an internet address (Mesh → Internet access).')}</p>
          )}
        </>
      )}

      {rooms.length > 0 && (
        <>
          <h2>{t('Your rooms')}</h2>
          <ul className="list">
            {rooms.map((r) => (
              <li key={r.code} className="row space">
                <span>
                  <b className="watch-code small">{r.code}</b> {r.name}
                  <span className="muted">
                    {r.people !== undefined ? ` · ${t('{n} watching', { n: r.people })}` : ''}
                    {r.playing ? ` · ${r.playing}` : ''}
                  </span>
                </span>
                <span className="row">
                  {r.links[0] && <button className="primary" onClick={() => void open(hostLink(r.links, r.hostToken))}>{t('Open')}</button>}
                  {window.meshdrop.watchPlayLocal && (
                    <button
                      onClick={() =>
                        void run(async () => {
                          const p = await window.meshdrop.pickOpenPath();
                          if (p) await window.meshdrop.watchPlayLocal!(r.code, p);
                          return p ? t('Playing in the room') : undefined;
                        })
                      }
                    >
                      {t('Play a video from this PC…')}
                    </button>
                  )}
                  <button className="danger" onClick={() => void run(() => window.meshdrop.watchEnd!(r.code), t('Room ended'))}>
                    {t('End')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>{t('Join with a code')}</h2>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const url = await window.meshdrop.watchResolve!(code);
            if (!url) throw new Error(t('No watch party with that code on your hub or on this network. A friend outside your devices can send you the link instead.'));
            await window.meshdrop.watchOpen!(url);
            setCode('');
          });
        }}
      >
        <input aria-label={t('Room code to join')} className="watch-input" placeholder="ABC123" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button className="primary" disabled={code.trim().length !== 6}>
          {t('Join')}
        </button>
      </form>
      <p className="muted">{t('Got a link from a friend? Open it in your browser: it works without MeshDrop.')}</p>
    </section>
  );
}
