import { useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';

/** M12: host a watch party (one 6-character code), or join one by its code. */
export function WatchParty({ state, run }: { state: AppState; run: Run }) {
  const android = state.platform === 'android';
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [made, setMade] = useState<{ code: string; links: string[]; hostToken: string; qrSvg: string } | null>(null);
  const rooms = state.watch ?? [];
  const open = (url: string) => run(() => window.meshdrop.watchOpen!(url));
  const hostLink = (links: string[], token?: string) => {
    const l = links[0] ?? '';
    return token ? `${l}#h=${token}` : l;
  };

  return (
    <section>
      <p className="lead">Watch together, in step</p>
      <p className="muted">
        Host a room and share its 6-character code. Everyone sees the same moment: play, pause, jump and speed follow along for everybody. YouTube, Google Drive
        and Dropbox links, links to video files, and videos from your {android ? 'phone' : 'PC'} all work. Friends without MeshDrop join in their browser.
      </p>

      <h2>Host a watch party</h2>
      <div className="row wrap">
        <input aria-label="Room name" placeholder="Movie night" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button
          className="primary"
          onClick={() =>
            void run(async () => {
              const r = await window.meshdrop.watchCreate!(name.trim() || `${state.settings.alias}'s watch party`);
              setMade(r);
              if (r.links[0]) await window.meshdrop.watchOpen!(hostLink(r.links, r.hostToken));
            })
          }
        >
          Start a room
        </button>
      </div>
      {made && (
        <div className="invite">
          {made.qrSvg && <img className="qr" src={`data:image/svg+xml;base64,${btoa(made.qrSvg)}`} alt="Watch party QR code" width={180} height={180} />}
          <div className="invite-side">
            <p className="watch-code" aria-label="Room code">
              {made.code}
            </p>
            {made.links.map((l) => (
              <div key={l} className="row">
                <input readOnly value={l} className="grow" aria-label="Room link" onFocus={(e) => e.target.select()} />
                <button onClick={() => void run(() => navigator.clipboard.writeText(l), 'Copied')}>Copy</button>
              </div>
            ))}
            {made.links.length > 0 && !/^https:/.test(made.links[0]!) && (
              <p className="muted">This link works on this Wi-Fi. For friends elsewhere, give the hub PC an internet address (Mesh → Internet access).</p>
            )}
          </div>
        </div>
      )}

      {rooms.length > 0 && (
        <>
          <h2>Your rooms</h2>
          <ul className="list">
            {rooms.map((r) => (
              <li key={r.code} className="row space">
                <span>
                  <b className="watch-code small">{r.code}</b> {r.name}
                  <span className="muted">
                    {r.people !== undefined ? ` · ${r.people} watching` : ''}
                    {r.playing ? ` · ${r.playing}` : ''}
                  </span>
                </span>
                <span className="row">
                  {r.links[0] && <button className="primary" onClick={() => void open(hostLink(r.links, r.hostToken))}>Open</button>}
                  {window.meshdrop.watchPlayLocal && (
                    <button
                      onClick={() =>
                        void run(async () => {
                          const p = await window.meshdrop.pickOpenPath();
                          if (p) await window.meshdrop.watchPlayLocal!(r.code, p);
                          return p ? 'Playing in the room' : undefined;
                        })
                      }
                    >
                      Play a video from this PC…
                    </button>
                  )}
                  <button className="danger" onClick={() => void run(() => window.meshdrop.watchEnd!(r.code), 'Room ended')}>
                    End
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Join with a code</h2>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const url = await window.meshdrop.watchResolve!(code);
            if (!url) throw new Error('No watch party with that code on your hub or on this network. A friend outside your devices can send you the link instead.');
            await window.meshdrop.watchOpen!(url);
            setCode('');
          });
        }}
      >
        <input aria-label="Room code to join" className="watch-input" placeholder="ABC123" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button className="primary" disabled={code.trim().length !== 6}>
          Join
        </button>
      </form>
      <p className="muted">Got a link from a friend? Open it in your browser: it works without MeshDrop.</p>
    </section>
  );
}
