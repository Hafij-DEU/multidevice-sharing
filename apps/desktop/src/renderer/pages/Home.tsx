import type { CSSProperties } from 'react';
import type { AppState } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { Peer } from '../components/Peer.tsx';

/** Where a tile leads: a tab, a More page, or an action. */
export type Go = (to: { tab: 'Send' | 'Received' } | { sub: string }) => void;

interface Tile {
  id: string;
  title: string;
  hint: string;
  icon: string;
  hue: number;
  onOpen: () => void;
}

/** The home page: what is going on, and every feature one tap away. */
export function Home({ state, run, go }: { state: AppState; run: Run; go: Go }) {
  const android = state.platform === 'android';
  const trusted = state.devices.filter((d) => d.trusted && d.role !== 'localsend');
  const online = trusted.filter((d) => d.reach !== 'offline');
  const waiting = state.outbox.length;
  const unseen = state.received.length;
  const hub = state.hub;
  const hubLine =
    hub.role === 'none'
      ? 'No mesh: devices reach each other on this network'
      : hub.role === 'hub'
        ? 'This is the hub of your mesh'
        : hub.online
          ? hub.linkedTo === 'relay'
            ? 'Linked through a relay hub (the hub PC is away)'
            : 'Linked to your hub'
          : 'Hub not reachable: sends wait until it is';

  const tiles: Tile[] = [
    { id: 'send', title: 'Send', hint: 'Files, folders, text', icon: 'M4 12l16-8-6 16-2-7-8-1z', hue: 262, onOpen: () => go({ tab: 'Send' }) },
    { id: 'received', title: 'Received', hint: unseen ? `${unseen} item${unseen === 1 ? '' : 's'}` : 'Your inbox', icon: 'M12 4v11M7 10l5 5 5-5M5 20h14', hue: 200, onOpen: () => go({ tab: 'Received' }) },
    {
      id: 'clipboard', title: 'Send clipboard', hint: 'What you copied, to all online devices', icon: 'M9 4h6v3H9zM7 6H5v14h14V6h-2', hue: 330,
      onOpen: () => void run(() => window.meshdrop.sendClipboard('all'), 'Clipboard sent'),
    },
    { id: 'voice', title: 'Voice note', hint: 'Record and send', icon: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3', hue: 15, onOpen: () => go({ tab: 'Send' }) },
    ...(window.meshdrop.scanDocument
      ? [{
          id: 'scan', title: 'Scan to PDF', hint: 'Photo of a page, as a PDF', icon: 'M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M8 12h8', hue: 140,
          onOpen: () => go({ tab: 'Send' }),
        }]
      : []),
    { id: 'remote', title: android ? 'Remote control' : 'Remote', hint: android ? 'Touchpad, keys, slides for your PC' : 'Control a device, who may control this PC', icon: 'M7 3h10v18H7zM12 17h.01M10 7h4M9 11h6', hue: 280, onOpen: () => go({ sub: 'Remote' }) },
    { id: 'find', title: 'Find my device', hint: 'Ring it, even on silent', icon: 'M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7zM12 7v4', hue: 0, onOpen: () => go({ sub: 'Remote' }) },
    ...(state.guest ? [{ id: 'guests', title: 'Guests', hint: 'A browser sends or gets files', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', hue: 45, onOpen: () => go({ sub: 'Guests' }) }] : []),
    ...(state.room ? [{ id: 'room', title: 'Room', hint: state.room.active ? `Open · ${state.room.posts.length} posts` : 'One QR, a shared board', icon: 'M3 21V9l9-6 9 6v12zM9 21v-6h6v6', hue: 170, onOpen: () => go({ sub: 'Guests' }) }] : []),
    { id: 'links', title: 'Internet links', hint: 'Share with anyone, encrypted', icon: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1', hue: 220, onOpen: () => go({ sub: 'Guests' }) },
    ...(state.sync ? [{ id: 'sync', title: 'Sync & backup', hint: `${state.sync.folders.length} folder${state.sync.folders.length === 1 ? '' : 's'} synced`, icon: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4', hue: 190, onOpen: () => go({ sub: 'Sync' }) }] : []),
    { id: 'devices', title: 'Devices', hint: android ? 'Paired devices' : 'Paired devices, set up a phone', icon: 'M4 5h10v14H4zM16 9h4v10h-4M8 16h2', hue: 240, onOpen: () => go({ sub: 'Devices' }) },
    { id: 'mesh', title: 'Mesh', hint: 'Reach your devices from anywhere', icon: 'M5 12a2 2 0 1 0 0 .01M19 5a2 2 0 1 0 0 .01M19 19a2 2 0 1 0 0 .01M7 11l10-5M7 13l10 5', hue: 300, onOpen: () => go({ sub: 'Mesh' }) },
    ...(android ? [{ id: 'extendo', title: 'Second screen', hint: 'Extendo', icon: 'M3 5h12v9H3zM17 8h4v11h-9v-3', hue: 100, onOpen: () => void run(() => window.meshdrop.keepAliveAction!('extendo')) }] : []),
    { id: 'transfers', title: 'Transfers', hint: waiting ? `${waiting} waiting` : 'History, unfinished sends', icon: 'M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4', hue: 30, onOpen: () => go({ sub: 'Transfers' }) },
    { id: 'settings', title: 'Settings', hint: 'Name, notifications, options', icon: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4', hue: 210, onOpen: () => go({ sub: 'Settings' }) },
  ];

  return (
    <section className="home">
      <div className="home-status">
        <div>
          <div className="home-title">{state.self.alias}</div>
          <div className="muted">
            {online.length} of {trusted.length} device{trusted.length === 1 ? '' : 's'} online · {hubLine}
          </div>
        </div>
        {online.length > 0 && (
          <div className="home-devices">
            {online.slice(0, 6).map((d) => {
              const b = state.deviceStatus?.[d.deviceId]?.battery;
              return (
                <span key={d.deviceId} className="chip">
                  <Peer text={d.alias} />
                  {b && <span className="muted"> · {b.level}%</span>}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {state.ringing && (
        <div className="banner warn row space" role="alert">
          <span>This device is ringing (Find my device).</span>
          <button className="primary" onClick={() => void run(() => window.meshdrop.ringStop())}>
            Stop
          </button>
        </div>
      )}
      {(state.phoneNotes ?? []).length > 0 && (
        <button className="home-notes" onClick={() => go({ sub: 'Remote' })}>
          🔔 {(state.phoneNotes ?? []).length} notification{(state.phoneNotes ?? []).length === 1 ? '' : 's'} from your phone
        </button>
      )}
      <div className="tiles">
        {tiles.map((t) => (
          <button key={t.id} className="tile" data-tile={t.id} style={{ '--h': t.hue } as CSSProperties} onClick={t.onOpen}>
            <span className="tile-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={t.icon} />
              </svg>
            </span>
            <span className="tile-title">{t.title}</span>
            <span className="tile-hint">{t.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
