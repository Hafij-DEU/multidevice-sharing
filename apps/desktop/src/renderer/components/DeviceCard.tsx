import type { CSSProperties } from 'react';
import type { DeviceStatus, DeviceView } from '../../shared/api.ts';
import { Peer } from './Peer.tsx';

const REACH: Record<DeviceView['reach'], string> = { lan: 'On this network', hub: 'Via hub', offline: 'Offline' };
const ROLE: Record<DeviceView['role'], string> = { hub: 'Hub', member: 'Mesh member', paired: 'Paired', nearby: 'Nearby', localsend: 'LocalSend' };

/** A stable hue per device, so each one keeps its color everywhere. */
function hueOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function DeviceCard({ d, checked, disabled, onToggle, onPair, status }: { d: DeviceView; checked: boolean; disabled?: boolean; onToggle?: () => void; onPair?: () => void; status?: DeviceStatus }) {
  // A card with a checkbox is its label; one without must not be (a <label> would make its Pair
  // button take the whole card's text as its name, and any click on the card would press it).
  const Card = onToggle ? 'label' : 'div';
  return (
    <Card className={`device-card${checked ? ' selected' : ''}`} data-device={d.deviceId}>
      {onToggle && <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />}
      <span className="avatar" aria-hidden="true" style={{ '--h': hueOf(d.deviceId) } as CSSProperties}>
        {(Array.from(d.alias.trim())[0] ?? '?').toUpperCase()}
      </span>
      <span className="device-main">
        <Peer text={d.alias} className="device-alias" />
        <span className="device-sub" title={`${ROLE[d.role]} · ${d.deviceId.slice(0, 8)}`}>
          <span className={`dot reach-${d.reach}`} aria-hidden="true" />
          {REACH[d.reach]} · {ROLE[d.role]}
          {status?.battery && d.reach !== 'offline' && ` · 🔋 ${status.battery.level}%${status.battery.charging ? '⚡' : ''}`}
        </span>
      </span>
      {onPair && (
        <button type="button" className="primary" onClick={onPair}>
          Pair
        </button>
      )}
    </Card>
  );
}
