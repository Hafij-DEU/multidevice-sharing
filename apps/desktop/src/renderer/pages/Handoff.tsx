import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { Peer } from '../components/Peer.tsx';
import { t } from '../i18n.ts';

/** M13: carry on with a page on another device, at the same spot (scroll, video time). */
export function Handoff({ state, run }: { state: AppState; run: Run }) {
  const android = state.platform === 'android';
  if (android) {
    return (
      <section>
        <p className="lead">{t('Pick up where you were')}</p>
        <button
          className="primary big"
          onClick={() =>
            void run(async () => {
              const title = await window.meshdrop.handoffPull!();
              return title ? t('Opening {title}', { title }) : t('Nothing open in the PC browser right now.');
            })
          }
        >
          {t('Continue from PC')}
        </button>
        <p className="muted">{t('Opens the page your PC browser shows, at the same spot: the same scroll position, and the same second of a video.')}</p>
        <h2>{t('From this phone to the PC')}</h2>
        <p className="muted">
          {t('In Chrome, YouTube or any app: Share →')} <b>{t('Continue on PC')}</b>. {t('The page opens on your PC; a YouTube video continues at the second you were at.')}
        </p>
      </section>
    );
  }
  const h = state.handoff;
  const phones = state.devices.filter((d) => d.trusted && d.reach !== 'offline' && d.deviceType === 'mobile');
  return (
    <section>
      <p className="lead">{t('Carry on with a page on another device')}</p>
      {h?.extension ? (
        <p className="ok-text">{h.page ? t('Browser extension connected: {title}', { title: h.page.title }) : t('Browser extension connected')}</p>
      ) : (
        <>
          <p className="muted">
            {t('Add the MeshDrop extension to your browser once, so MeshDrop knows which page you are on (and how far you scrolled, and where a video is). It talks only to MeshDrop on this PC.')}
          </p>
          <ol className="steps">
            <li>
              <button onClick={() => void run(async () => t('The extension is in {path}', { path: await window.meshdrop.handoffExtension!() }))}>{t('Get the extension folder')}</button>
            </li>
            <li>
              {t('Open')} <code>brave://extensions</code> ({t('Chrome:')} <code>chrome://extensions</code>, {t('Opera:')} <code>opera://extensions</code>) {t('and turn on')} <b>{t('Developer mode')}</b>.
            </li>
            <li>
              {t('Press')} <b>{t('Load unpacked')}</b> {t('and pick the')} <b>MeshDrop Browser Extension</b> {t('folder in Documents.')}
            </li>
          </ol>
        </>
      )}
      <h2>{t('Continue on a phone')}</h2>
      {phones.length === 0 ? (
        <p className="muted">{t('No phone is reachable right now.')}</p>
      ) : (
        <div className="row wrap">
          {phones.map((d) => (
            <button key={d.deviceId} className="primary" disabled={!h?.page} onClick={() => void run(() => window.meshdrop.handoffSend!(d.deviceId), t('Opening on {name}', { name: d.alias }))}>
              {t('Send this page to')} <Peer text={d.alias} />
            </button>
          ))}
        </div>
      )}
      <p className="muted">{t('The phone can also take it by itself (Home → Continue from PC), and the extension button in the browser does the same. From a phone to this PC: Share → Continue on PC.')}</p>
    </section>
  );
}
