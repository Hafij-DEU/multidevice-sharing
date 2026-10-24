import { useState } from 'react';
import type { ReachInput, ReachMode, ReachView } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { fmtTime } from '../format.ts';

const MODES: [ReachMode, string][] = [
  ['off', 'Off (this network only)'],
  ['tailscale', 'Tailscale Funnel (free account, no domain needed)'],
  ['cloudflare', 'Cloudflare tunnel (your own domain)'],
  ['port-forward', 'Port forwarding (public IP, DuckDNS name)'],
];

/** Hub PC: how devices and internet links reach it from anywhere. */
export function InternetAccess({ reach, run }: { reach: ReachView; run: Run }) {
  const [mode, setMode] = useState<ReachMode>(reach.mode);
  const [host, setHost] = useState(reach.config.cloudflareHost ?? '');
  const [duck, setDuck] = useState(reach.config.duckdnsDomain ?? '');
  const [token, setToken] = useState('');
  const [manual, setManual] = useState(reach.config.mapping === 'manual');
  const d = reach.detection;
  const apply = () => {
    const input: ReachInput = { mode };
    if (mode === 'cloudflare') input.cloudflareHost = host.trim();
    if (mode === 'port-forward') {
      input.duckdnsDomain = duck.trim();
      if (token) input.duckdnsToken = token.trim();
      input.mapping = manual ? 'manual' : 'auto';
    }
    return run(async () => {
      await window.meshdrop.reachSet(input);
      setToken('');
      return mode === 'off' ? 'Internet access turned off' : 'Internet access is on';
    });
  };
  return (
    <div className="reach">
      <p className={reach.state === 'on' ? 'ok-text' : reach.state === 'off' ? 'muted' : 'error-text'}>
        {reach.state === 'on' ? <>Reachable at <code>{reach.url}</code>{reach.certExpiresAt ? <> · certificate until {fmtTime(reach.certExpiresAt)}</> : null}</> : reach.state === 'off' ? 'Not reachable from the internet.' : reach.state === 'starting' ? 'Starting…' : reach.error ?? reach.state}
      </p>
      {reach.fix && reach.state !== 'on' && <p className="muted">To fix: {reach.fix}</p>}
      {reach.mode === 'port-forward' && reach.listenPort !== undefined && reach.mapped === 'manual' && (
        <p className="muted">Your router must forward TCP port 443 to this PC's port {reach.listenPort}.</p>
      )}
      <div className="row">
        <button onClick={() => void run(() => window.meshdrop.reachDetect())}>Check my connection</button>
        {d && <span className={d.cgnat ? 'error-text' : 'muted'}>{d.reason}</span>}
      </div>
      <label className="field">
        <span>Way in</span>
        <select aria-label="Internet access mode" value={mode} onChange={(e) => setMode(e.target.value as ReachMode)}>
          {MODES.map(([m, t]) => (
            <option key={m} value={m}>{t}{d && ((d.suggestion === 'tunnel' && (m === 'tailscale' || m === 'cloudflare')) || (d.suggestion === 'port-forward' && m === 'port-forward')) ? ' — suggested' : ''}</option>
          ))}
        </select>
      </label>
      {mode === 'tailscale' && <p className="muted">Needs Tailscale installed and signed in on this PC, with Funnel allowed for it. MeshDrop turns the funnel on and off.</p>}
      {mode === 'cloudflare' && (
        <label className="field">
          <span>Hostname on your Cloudflare domain</span>
          <input aria-label="Cloudflare hostname" placeholder="drop.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
      )}
      {mode === 'port-forward' && (
        <>
          <label className="field">
            <span>DuckDNS name</span>
            <input aria-label="DuckDNS name" placeholder="myhub (for myhub.duckdns.org)" value={duck} onChange={(e) => setDuck(e.target.value)} />
          </label>
          <label className="field">
            <span>DuckDNS token {reach.tokenSet ? '(saved; leave empty to keep it)' : ''}</span>
            <input aria-label="DuckDNS token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label className="row">
            <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> I forwarded the port on my router myself
          </label>
        </>
      )}
      <button className="primary" onClick={() => void apply()}>
        Apply
      </button>
    </div>
  );
}
