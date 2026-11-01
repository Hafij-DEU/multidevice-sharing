import { useState } from 'react';
import type { ReachInput, ReachMode, ReachView } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { fmtTime } from '../format.ts';
import { mark, t } from '../i18n.ts';

/** Text with its https links clickable (a provider's page to approve something opens in the browser). */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https:\/\/\S+)/).map((part, i) =>
        i % 2 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Tailscale Funnel, step by step; finished steps tick themselves off from what MeshDrop sees. */
function TailscaleSetup({ reach, run }: { reach: ReachView; run: Run }) {
  const applied = reach.mode === 'tailscale';
  // how far along: installed (1), signed in (2), MeshDrop may drive it (3), all on (6)
  const done = !applied
    ? 0
    : reach.state === 'on'
      ? 6
      : reach.state === 'missing'
        ? 0
        : reach.state === 'logged-out'
          ? 1
          : /operator/.test(reach.fix ?? '')
            ? 2
            : reach.state === 'error'
              ? 3
              : 0;
  const approve = /https:\/\/login\.tailscale\.com\/f\/\S+/.exec(reach.fix ?? '')?.[0];
  const cmd = (c: string) => (
    <span className="row">
      <code>{c}</code>
      <button onClick={() => void run(() => navigator.clipboard.writeText(c), t('Copied: paste it in a terminal'))}>{t('Copy')}</button>
    </span>
  );
  const steps: [string, React.ReactNode][] = [
    [t('Install Tailscale (free) in a terminal'), cmd('curl -fsSL https://tailscale.com/install.sh | sh')],
    [t('Sign in: open the link it prints'), cmd('sudo tailscale up')],
    [t('Let MeshDrop turn the funnel on and off'), cmd('sudo tailscale set --operator=$USER')],
    [
      t('Turn on HTTPS certificates'),
      <>
        <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">{t('Tailscale admin → DNS')}</a> → {t('HTTPS Certificates')} → <b>{t('Enable HTTPS')}</b>
      </>,
    ],
    [
      t('Allow Funnel for this PC'),
      approve ? (
        <>
          <a href={approve} target="_blank" rel="noreferrer">{t('Open the approval page')}</a> → <b>{t('Enable')}</b>
        </>
      ) : (
        <>
          {t('Press Apply below: if Funnel is not allowed yet, the approval link shows up here. (Or in')}{' '}
          <a href="https://login.tailscale.com/admin/acls" target="_blank" rel="noreferrer">{t('Access controls')}</a>{t(', add the node attribute')} <code>funnel</code>.)
        </>
      ),
    ],
    [t('Press Apply. Then open MeshDrop once on each phone on the same Wi-Fi, so it learns the new address.'), null],
  ];
  return (
    <div className="setup">
      <p className="muted">{t('Reach this PC from anywhere through Tailscale Funnel: free, no domain, works behind CGNAT. Once, on this PC:')}</p>
      <ol className="steps">
        {steps.map(([title, body], i) => (
          <li key={title} className={i < done ? 'done' : ''}>
            <span>{title}</span>
            {body && <div className="step-body">{body}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

const MODES: [ReachMode, string][] = [
  ['off', mark('Off (this network only)')],
  ['tailscale', mark('Tailscale Funnel (free account, no domain needed)')],
  ['cloudflare', mark('Cloudflare tunnel (your own domain)')],
  ['port-forward', mark('Port forwarding (public IP, DuckDNS name)')],
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
      return mode === 'off' ? t('Internet access turned off') : t('Internet access is on');
    });
  };
  return (
    <div className="reach">
      <p className={reach.state === 'on' ? 'ok-text' : reach.state === 'off' ? 'muted' : 'error-text'}>
        {reach.state === 'on' ? <>{t('Reachable at')} <code>{reach.url}</code>{reach.certExpiresAt ? <> · {t('certificate until {time}', { time: fmtTime(reach.certExpiresAt) })}</> : null}</> : reach.state === 'off' ? t('Not reachable from the internet.') : reach.state === 'starting' ? t('Starting…') : <Linked text={reach.error ?? reach.state} />}
      </p>
      {reach.fix && reach.state !== 'on' && (
        <p className="muted">
          {t('To fix:')} <Linked text={reach.fix} />
        </p>
      )}
      {reach.mode === 'port-forward' && reach.listenPort !== undefined && reach.mapped === 'manual' && (
        <p className="muted">{t('Your router must forward TCP port 443 to this PC\'s port {port}.', { port: reach.listenPort })}</p>
      )}
      <div className="row">
        <button onClick={() => void run(() => window.meshdrop.reachDetect())}>{t('Check my connection')}</button>
        {d && <span className={d.cgnat ? 'error-text' : 'muted'}>{d.reason}</span>}
      </div>
      <label className="field">
        <span>{t('Way in')}</span>
        <select aria-label={t('Internet access mode')} value={mode} onChange={(e) => setMode(e.target.value as ReachMode)}>
          {MODES.map(([m, label]) => (
            <option key={m} value={m}>{d && ((d.suggestion === 'tunnel' && (m === 'tailscale' || m === 'cloudflare')) || (d.suggestion === 'port-forward' && m === 'port-forward')) ? t('{mode} — suggested', { mode: t(label) }) : t(label)}</option>
          ))}
        </select>
      </label>
      {mode === 'tailscale' && reach.state !== 'on' && <TailscaleSetup reach={reach} run={run} />}
      {mode === 'cloudflare' && (
        <label className="field">
          <span>{t('Hostname on your Cloudflare domain')}</span>
          <input aria-label={t('Cloudflare hostname')} placeholder="drop.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
      )}
      {mode === 'port-forward' && (
        <>
          <label className="field">
            <span>{t('DuckDNS name')}</span>
            <input aria-label={t('DuckDNS name')} placeholder={t('myhub (for myhub.duckdns.org)')} value={duck} onChange={(e) => setDuck(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('DuckDNS token')} {reach.tokenSet ? t('(saved; leave empty to keep it)') : ''}</span>
            <input aria-label={t('DuckDNS token')} type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label className="row">
            <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> {t('I forwarded the port on my router myself')}
          </label>
        </>
      )}
      <button className="primary" onClick={() => void apply()}>
        {t('Apply')}
      </button>
    </div>
  );
}
