import type { DeviceView } from '../../shared/api.ts';
import { Peer } from './Peer.tsx';

const REACH: Record<DeviceView['reach'], string> = { lan: 'On this network', hub: 'Via hub', offline: 'Offline' };
const ROLE: Record<DeviceView['role'], string> = { hub: 'Hub', member: 'Mesh member', paired: 'Paired', nearby: 'Nearby' };

export function DeviceCard({ d, checked, disabled, onToggle }: { d: DeviceView; checked: boolean; disabled?: boolean; onToggle?: () => void }) {
  return (
    <label className={`device-card${checked ? ' selected' : ''}`} data-device={d.deviceId}>
      {onToggle && <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />}
      <span className="device-main">
        <Peer text={d.alias} className="device-alias" />
        <span className="device-sub">
          {ROLE[d.role]} · <code>{d.deviceId.slice(0, 8)}</code>
        </span>
      </span>
      <span className={`badge reach-${d.reach}`}>{REACH[d.reach]}</span>
    </label>
  );
}
