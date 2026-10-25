import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { Peer } from '../components/Peer.tsx';

/** M13: carry on with a page on another device, at the same spot (scroll, video time). */
export function Handoff({ state, run }: { state: AppState; run: Run }) {
  const android = state.platform === 'android';
  if (android) {
    return (
      <section>
        <p className="lead">Pick up where you were</p>
        <button
          className="primary big"
          onClick={() =>
            void run(async () => {
              const title = await window.meshdrop.handoffPull!();
              return title ? `Opening ${title}` : 'Nothing open in the PC browser right now.';
            })
          }
        >
          Continue from PC
        </button>
        <p className="muted">Opens the page your PC browser shows, at the same spot: the same scroll position, and the same second of a video.</p>
        <h2>From this phone to the PC</h2>
        <p className="muted">
          In Chrome, YouTube or any app: Share → <b>Continue on PC</b>. The page opens on your PC; a YouTube video continues at the second you were at.
        </p>
      </section>
    );
  }
  const h = state.handoff;
  const phones = state.devices.filter((d) => d.trusted && d.reach !== 'offline' && d.deviceType === 'mobile');
  return (
    <section>
      <p className="lead">Carry on with a page on another device</p>
      {h?.extension ? (
        <p className="ok-text">Browser extension connected{h.page ? `: ${h.page.title}` : ''}</p>
      ) : (
        <>
          <p className="muted">
            Add the MeshDrop extension to your browser once, so MeshDrop knows which page you are on (and how far you scrolled, and where a video is). It talks only
            to MeshDrop on this PC.
          </p>
          <ol className="steps">
            <li>
              <button onClick={() => void run(async () => `The extension is in ${await window.meshdrop.handoffExtension!()}`)}>Get the extension folder</button>
            </li>
            <li>
              Open <code>brave://extensions</code> (Chrome: <code>chrome://extensions</code>, Opera: <code>opera://extensions</code>) and turn on <b>Developer mode</b>.
            </li>
            <li>
              Press <b>Load unpacked</b> and pick the <b>MeshDrop Browser Extension</b> folder in Documents.
            </li>
          </ol>
        </>
      )}
      <h2>Continue on a phone</h2>
      {phones.length === 0 ? (
        <p className="muted">No phone is reachable right now.</p>
      ) : (
        <div className="row wrap">
          {phones.map((d) => (
            <button key={d.deviceId} className="primary" disabled={!h?.page} onClick={() => void run(() => window.meshdrop.handoffSend!(d.deviceId), `Opening on ${d.alias}`)}>
              Send this page to <Peer text={d.alias} />
            </button>
          ))}
        </div>
      )}
      <p className="muted">The phone can also take it by itself (Home → Continue from PC), and the extension button in the browser does the same. From a phone to this PC: Share → Continue on PC.</p>
    </section>
  );
}
