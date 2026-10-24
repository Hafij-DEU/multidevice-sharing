import type { DeviceView } from '../../shared/api.ts';
import { Peer } from './Peer.tsx';

const REACH: Record<DeviceView['reach'], string> = { lan: 'On this network', hub: 'Via hub', offline: 'Offline' };
const ROLE: Record<DeviceView['role'], string> = { hub: 'Hub', member: 'Mesh member', paired: 'Paired', nearby: 'Nearby', localsend: 'LocalSend' };

export function DeviceCard({ d, checked, disabled, onToggle, onPair }: { d: DeviceView; checked: boolean; disabled?: boolean; onToggle?: () => void; onPair?: () => void }) {
  // A card with a checkbox is its label; one without must not be (a <label> would make its Pair
  // button take the whole card's text as its name, and any click on the card would press it).
  const Card = onToggle ? 'label' : 'div';
  return (
    <Card className={`device-card${checked ? ' selected' : ''}`} data-device={d.deviceId}>
      {onToggle && <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />}
      <span className="device-main">
        <Peer text={d.alias} className="device-alias" />
        <span className="device-sub">
          {ROLE[d.role]} · <code>{d.deviceId.slice(0, 8)}</code>
        </span>
      </span>
      <span className={`badge reach-${d.reach}`}>{REACH[d.reach]}</span>
      {onPair && (
        <button type="button" className="primary" onClick={onPair}>
          Pair
        </button>
      )}
    </Card>
  );
}
