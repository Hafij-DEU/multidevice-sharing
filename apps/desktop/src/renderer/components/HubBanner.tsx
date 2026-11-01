import type { AppState } from '../../shared/api.ts';
import { Peer } from './Peer.tsx';

/** The gradient card on top of Home and Send: this device, its mesh, and who is online (with battery). */
export function HubBanner({ state }: { state: AppState }) {
  const trusted = state.devices.filter((d) => d.trusted && d.role !== 'localsend' && d.role !== 'addon');
  const online = trusted.filter((d) => d.reach !== 'offline');
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
  return (
    <div className="hub-banner">
      <span className="hub-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM5 21.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM19 21.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10.8 7.2 6.2 16.8M13.2 7.2l4.6 9.6M7.5 19h9" />
        </svg>
      </span>
      <div className="hub-main">
        <div className="hub-name">
          <Peer text={state.self.alias} />
        </div>
        <div className="hub-line">{hubLine}</div>
      </div>
      <div className="hub-pills">
        <span className="pill">
          <span className="live" aria-hidden="true" />
          {online.length} / {trusted.length} device{trusted.length === 1 ? '' : 's'} online
        </span>
        {online.slice(0, 6).map((d) => {
          const b = state.deviceStatus?.[d.deviceId]?.battery;
          return (
            <span key={d.deviceId} className="pill">
              <Peer text={d.alias} />
              {b && <Battery level={b.level} charging={b.charging} />}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** A small battery glyph and its level. */
export function Battery({ level, charging }: { level: number; charging: boolean }) {
  return (
    <span className={`batt${level <= 15 ? ' low' : ''}`} title={charging ? 'Charging' : undefined}>
      <svg aria-hidden="true" viewBox="0 0 10 16">
        <rect x="1" y="2" width="8" height="13" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <rect x="3.5" y="0.3" width="3" height="1.7" rx="0.5" fill="currentColor" />
        <rect x="2.6" y={3.6 + 9.8 * (1 - Math.min(100, Math.max(0, level)) / 100)} width="4.8" height={9.8 * (Math.min(100, Math.max(0, level)) / 100)} rx="0.6" fill="currentColor" />
      </svg>
      {level}%{charging ? '⚡' : ''}
    </span>
  );
}
