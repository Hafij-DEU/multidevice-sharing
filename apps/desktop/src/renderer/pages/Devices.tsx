import { useState } from 'react';
import type { AppState, SendItemInput } from '../../shared/api.ts';
import { DeviceCard } from '../components/DeviceCard.tsx';
import { DropZone } from '../components/DropZone.tsx';
import { baseName } from '../format.ts';
import type { Run } from '../App.tsx';

const DEFAULT_PORT = 53318;

/** "host", "host:port", "[v6]:port" or a bare IPv6 address. */
function parseAddress(s: string): { host: string; port: number } | null {
  const t = s.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : DEFAULT_PORT };
  const parts = t.split(':');
  if (parts.length > 2) return { host: t, port: DEFAULT_PORT };
  const [host, port] = parts;
  if (!host) return null;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return null;
  return { host, port: port ? Number(port) : DEFAULT_PORT };
}

export function Devices({ state, run }: { state: AppState; run: Run }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<SendItemInput[]>([]);
  const [text, setText] = useState<string | null>(null);
  const [addr, setAddr] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const trusted = state.devices.filter((d) => d.trusted);
  const nearby = state.devices.filter((d) => !d.trusted);
  const targets = all ? trusted.filter((d) => d.reach !== 'offline').map((d) => d.deviceId) : [...selected].filter((id) => trusted.some((d) => d.deviceId === id));
  const payload: SendItemInput[] = [...items, ...(text !== null && text !== '' ? [{ kind: 'text' as const, text }] : [])];
  const canSend = targets.length > 0 && payload.length > 0 && !busy;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const add = (more: SendItemInput[]) => setItems((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.kind === m.kind && c.path === m.path))]);

  const send = async () => {
    setBusy(true);
    const ok = await run(() => window.meshdrop.send(all ? 'all' : targets, payload), 'Sending…');
    setBusy(false);
    if (ok !== undefined) {
      setItems([]);
      setText(null);
    }
  };

  const addByAddress = async () => {
    const a = parseAddress(addr);
    if (!a) {
      await run(() => Promise.reject(new Error('Enter an address like 192.168.1.20 or 192.168.1.20:53318.')));
      return;
    }
    const ok = await run(() => window.meshdrop.addByAddress(a.host, a.port, name.trim()), 'Device added');
    if (ok !== undefined) {
      setAddr('');
      setName('');
    }
  };

  return (
    <section>
      <div className="row space">
        <h2>Send to</h2>
        <label className="toggle">
          <input type="checkbox" checked={all} onChange={() => setAll(!all)} /> All devices
        </label>
      </div>
      {trusted.length === 0 ? (
        <p className="muted">No devices yet. Add one by address below, or join a mesh on the Mesh page.</p>
      ) : (
        <div className="cards">
          {trusted.map((d) => (
            <DeviceCard key={d.deviceId} d={d} checked={all ? d.reach !== 'offline' : selected.has(d.deviceId)} disabled={all} onToggle={() => toggle(d.deviceId)} />
          ))}
        </div>
      )}

      <h2>What</h2>
      <DropZone onItems={add} />
      <div className="row">
        <button onClick={() => void run(async () => add((await window.meshdrop.pickFiles()).map((path) => ({ kind: 'file' as const, path }))))}>Add files</button>
        <button
          onClick={() =>
            void run(async () => {
              const p = await window.meshdrop.pickFolder();
              if (p) add([{ kind: 'dir', path: p }]);
            })
          }
        >
          Add folder
        </button>
        <button onClick={() => setText(text === null ? '' : null)} aria-pressed={text !== null}>
          Text
        </button>
        <button onClick={() => void run(() => window.meshdrop.sendClipboard(all ? 'all' : targets), 'Clipboard sent')} disabled={targets.length === 0}>
          Send clipboard
        </button>
      </div>
      {text !== null && <textarea aria-label="Text to send" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Type a message or paste a link" />}
      {items.length > 0 && (
        <ul className="items">
          {items.map((it) => (
            <li key={`${it.kind}:${it.path}`}>
              <span className="muted">{it.kind === 'dir' ? 'Folder' : 'File'}</span> {baseName(it.path ?? '')}
              <button className="link" aria-label={`Remove ${baseName(it.path ?? '')}`} onClick={() => setItems(items.filter((x) => x !== it))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="primary" disabled={!canSend} onClick={() => void send()}>
          Send
        </button>
      </div>

      <h2>Nearby</h2>
      <div className="row">
        <input aria-label="Address" placeholder="192.168.1.20:53318" value={addr} onChange={(e) => setAddr(e.target.value)} />
        <input aria-label="Name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        <button onClick={() => void addByAddress()} disabled={addr.trim() === ''}>
          Add by address
        </button>
        <button onClick={() => void run(async () => `${await window.meshdrop.scanSubnet()} new device(s) found`)}>Scan network</button>
      </div>
      {nearby.length === 0 ? (
        <p className="muted">No other MeshDrop devices seen on this network.</p>
      ) : (
        <div className="cards">
          {nearby.map((d) => (
            <DeviceCard key={d.deviceId} d={d} checked={false} />
          ))}
        </div>
      )}
    </section>
  );
}
