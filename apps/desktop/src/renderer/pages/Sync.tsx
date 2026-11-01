import { useState } from 'react';
import type { AppState, SyncPartnerView, SyncView } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { Peer } from '../components/Peer.tsx';
import { fmtTime } from '../format.ts';
import { t } from '../i18n.ts';

/** How a folder is shown: a path, or the readable part of a picked folder's URI (Android). */
const shown = (f: string) => (f.startsWith('content://') ? decodeURIComponent(f.split('/tree/')[1] ?? f).replace(/^primary:/, '') : f);

function partnerStatus(p: SyncPartnerView | undefined): { text: string; bad: boolean } {
  if (!p) return { text: t('Not synced'), bad: false };
  const last = p.last;
  if (p.syncing) return { text: t('Syncing…'), bad: false };
  if (!p.present) return { text: t('Waiting for it on this Wi-Fi'), bad: false };
  if (last?.error) {
    return { text: /404/.test(last.error) ? t('It has no folder with this name yet') : t('Last try failed: {error}', { error: last.error }), bad: true };
  }
  if (!last) return { text: t('On this Wi-Fi'), bad: false };
  const changed = last.pulled + last.deleted > 0 ? ` · ${t('{new} new, {gone} removed', { new: last.pulled, gone: last.deleted })}` : '';
  return { text: `${t('Synced {time}', { time: fmtTime(last.at) })}${changed}${last.conflicts ? ` · ${t('{n} conflict(s)', { n: last.conflicts })}` : ''}`, bad: false };
}

/** One synced folder: its name (what matches it on the other devices), path, partners and actions. */
function FolderCard({ f, state, run }: { f: SyncView['folders'][number]; state: AppState; run: Run }) {
  const [name, setName] = useState(f.name);
  const [removing, setRemoving] = useState(false);
  const ticked = new Set(f.partners.map((p) => p.deviceId));
  const candidates = state.devices.filter((d) => d.trusted && d.role !== 'localsend');
  const put = (partners: string[], newName = f.name) => run(() => window.meshdrop.syncPut(newName, f.folder, partners, f.name));
  return (
    <section className="sync-folder" data-sync-folder={f.name}>
      <div className="row">
        <input aria-label={t('Sync name')} className="grow" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        {name.trim() !== f.name && (
          <button className="primary" onClick={() => void put([...ticked], name.trim())}>
            {t('Rename')}
          </button>
        )}
      </div>
      <div className="row">
        <code className="grow">{shown(f.folder)}</code>
        {window.meshdrop.openSyncFolder && <button onClick={() => void run(() => window.meshdrop.openSyncFolder!(f.name))}>{t('Open')}</button>}
        {ticked.size > 0 && <button onClick={() => void run(() => window.meshdrop.syncNow(f.name), t('Synced'))}>{t('Sync now')}</button>}
        <button
          className={removing ? 'danger' : ''}
          onClick={() => {
            if (!removing) {
              setRemoving(true);
              setTimeout(() => setRemoving(false), 4000);
              return;
            }
            void run(() => window.meshdrop.syncRemove(f.name), t('No longer synced (its files stay)'));
          }}
        >
          {removing ? t('Tap again to stop syncing') : t('Stop syncing')}
        </button>
      </div>
      {candidates.length === 0 ? (
        <p className="muted">{t('Pair a device first (Send → Add a device).')}</p>
      ) : (
        <ul className="list">
          {candidates.map((d) => {
            const st = partnerStatus(f.partners.find((x) => x.deviceId === d.deviceId));
            return (
              <li key={d.deviceId} className="row space" data-sync={d.deviceId}>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={ticked.has(d.deviceId)}
                    onChange={() => void put(ticked.has(d.deviceId) ? [...ticked].filter((x) => x !== d.deviceId) : [...ticked, d.deviceId])}
                  />{' '}
                  <Peer text={d.alias} />
                </label>
                <span className={st.bad ? 'error-text' : 'muted'}>{st.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Folder sync: folders kept the same here and on the devices ticked for each (same Wi-Fi). */
export function Sync({ state, run }: { state: AppState; run: Run }) {
  const s = state.sync;
  if (!s) return <p className="muted">{t('Folder sync is not available here yet.')}</p>;
  const add = (folder: string) => run(() => window.meshdrop.syncPut('', folder, []));
  const choose = () =>
    void run(async () => {
      const p = await window.meshdrop.pickFolder();
      if (p) await window.meshdrop.syncPut('', p, []);
    });
  return (
    <section>
      <p className="muted">
        {t('Folders you add here stay the same on the devices you tick for them, whenever both are on the same Wi-Fi. Folders match by name: give a folder the same name on each device (it starts as the folder\'s own name). Use folders made for this, not your working folders.')}
      </p>
      {s.folders.map((f) => (
        <FolderCard key={f.name} f={f} state={state} run={run} />
      ))}
      <h2>{s.folders.length === 0 ? t('Add a folder') : t('Add another folder')}</h2>
      <div className="row">
        {s.suggested !== '' && (
          <button className={s.folders.length === 0 ? 'primary' : ''} onClick={() => void add(s.suggested)}>
            {t('Use {name}', { name: s.suggested })}
          </button>
        )}
        <button className={s.suggested === '' && s.folders.length === 0 ? 'primary' : ''} onClick={choose}>
          {t('Choose a folder…')}
        </button>
      </div>
      <p className="muted hint">
        {t('A file deleted or replaced on another device is kept here in that folder\'s')} <strong>{t('Deleted')}</strong> {t('folder (same path), so nothing is lost by accident. Deleted is not synced; empty it yourself when you no longer need it. If a file changed on both sides, both versions are kept.')}
      </p>
      <PhotoBackup state={state} run={run} />
    </section>
  );
}

/** Android: new camera photos and videos go to a PC whenever both are on the same Wi-Fi. */
function PhotoBackup({ state, run }: { state: AppState; run: Run }) {
  const b = state.backup;
  const [existing, setExisting] = useState(false);
  if (!b || !window.meshdrop.backupSet) return null;
  const pcs = state.devices.filter((d) => d.trusted && d.role !== 'localsend' && d.deviceType !== 'mobile');
  const target = state.devices.find((d) => d.deviceId === b.target);
  return (
    <>
      <h2>{t('Photo backup')}</h2>
      <p className="muted">{t('New photos and videos from the camera go to a PC by themselves when both are on the same Wi-Fi. On the PC they land in Pictures/MeshDrop Backup.')}</p>
      {!b.permission && (
        <div className="row">
          <button className="primary" onClick={() => void run(() => window.meshdrop.backupPermission!())}>
            {t('Allow access to photos and videos')}
          </button>
        </div>
      )}
      {b.target === '' ? (
        <>
          <label className="toggle">
            <input type="checkbox" checked={existing} onChange={() => setExisting(!existing)} /> {t('Also back up the photos already on this phone')}
          </label>
          {pcs.length === 0 ? (
            <p className="muted">{t('Pair with your PC first (Send → Add a device).')}</p>
          ) : (
            <div className="row">
              {pcs.map((d) => (
                <button key={d.deviceId} className="primary" disabled={!b.permission} onClick={() => void run(() => window.meshdrop.backupSet!(d.deviceId, existing), t('Photo backup is on'))}>
                  {t('Back up to {name}', { name: d.alias })}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="row space">
          <span>
            {t('To')} <strong>{target?.alias ?? b.target.slice(0, 8)}</strong>
            <span className={b.error ? 'error-text' : 'muted'}>
              {' · '}
              {b.error ?? (b.running ? t('Backing up…') : target?.reach === 'lan' ? (b.lastAt ? t('{n} sent since the app started', { n: b.count }) : t('Up to date')) : t('Waiting for it on this Wi-Fi'))}
            </span>
          </span>
          <button onClick={() => void run(() => window.meshdrop.backupSet!('', false), t('Photo backup is off'))}>{t('Turn off')}</button>
        </div>
      )}
    </>
  );
}
