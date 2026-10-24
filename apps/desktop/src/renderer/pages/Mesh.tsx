import { useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import { InternetAccess } from '../components/InternetAccess.tsx';
import { Peer } from '../components/Peer.tsx';
import { QrInvite, type Invite } from '../components/QrInvite.tsx';
import type { Run } from '../App.tsx';

const MIN_PASSPHRASE = 10;
const ROLE = { hub: 'Hub (this PC keeps the mesh)', member: 'Member', provisional: 'Joining… (waiting for the hub)', none: 'Not in a mesh' } as const;

function Recovery({ mode, run }: { mode: 'export' | 'import'; run: Run }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const mismatch = mode === 'export' && p2 !== '' && p1 !== p2;
  const ok = p1.length >= MIN_PASSPHRASE && (mode === 'import' || p1 === p2);
  const go = async () => {
    const path = mode === 'export' ? await window.meshdrop.pickSavePath('meshdrop-recovery.txt') : await window.meshdrop.pickOpenPath();
    if (!path) return;
    const r = await run(
      () => (mode === 'export' ? window.meshdrop.exportRecovery(path, p1) : window.meshdrop.importRecovery(path, p1)),
      mode === 'export' ? 'Recovery file saved. Keep it and the passphrase somewhere safe.' : 'Mesh restored: this PC is now the hub.',
    );
    if (r !== undefined || mode === 'export') {
      setP1('');
      setP2('');
    }
  };
  return (
    <div className="recovery">
      <div className="row">
        <input type="password" aria-label="Passphrase" placeholder={`Passphrase (at least ${MIN_PASSPHRASE} characters)`} value={p1} onChange={(e) => setP1(e.target.value)} />
        {mode === 'export' && <input type="password" aria-label="Repeat passphrase" placeholder="Repeat passphrase" value={p2} onChange={(e) => setP2(e.target.value)} />}
        <button disabled={!ok} onClick={() => void run(go)}>
          {mode === 'export' ? 'Export recovery file' : 'Import recovery file'}
        </button>
      </div>
      {mismatch && <p className="error-text">The passphrases differ.</p>}
    </div>
  );
}

function HubUrls({ urls, run }: { urls: string[]; run: Run }) {
  const [text, setText] = useState(urls.join('\n'));
  const next = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const changed = next.join('\n') !== urls.join('\n');
  return (
    <div>
      <textarea aria-label="Hub URLs" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="wss://meshdrop.example.ts.net (one per line)" />
      <div className="row">
        <button disabled={!changed} onClick={() => void run(() => window.meshdrop.setHubUrls(next), 'Hub address saved')}>
          Save hub address
        </button>
      </div>
    </div>
  );
}

export function Mesh({ state, run }: { state: AppState; run: Run }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [uri, setUri] = useState(state.joinLink ?? '');
  // The phone only joins: creating, inviting, revoking and recovery stay on the PC (the hub).
  const android = state.platform === 'android';
  const [link, setLink] = useState(state.joinLink);
  if (state.joinLink !== link) {
    setLink(state.joinLink);
    if (state.joinLink) setUri(state.joinLink);
  }
  const [revoking, setRevoking] = useState<{ deviceId: string; alias: string } | null>(null);
  const hub = state.hub;
  const isHub = hub.role === 'hub';
  const newInvite = async () => {
    const r = await run(() => window.meshdrop.createInvite());
    if (r) setInvite(r);
  };

  if (hub.role === 'none') {
    return (
      <section>
        <p className="lead">Not in a mesh</p>
        {android ? (
          <p className="muted">A mesh links this phone to your devices through your PC, so they reach each other from anywhere. On the PC, open Mesh → Invite a device, then scan the QR code with this phone&apos;s camera or paste the invite here.</p>
        ) : (
          <>
            <p className="muted">A mesh links your devices through this PC so they can reach each other from anywhere, not only on this network.</p>
            <div className="row">
              <button className="primary" onClick={() => void run(() => window.meshdrop.hubInit([]), 'Mesh created: this PC is the hub')}>
                Create a mesh on this PC (make it the hub)
              </button>
            </div>
          </>
        )}
        <h2>Join with an invite</h2>
        <div className="row">
          <input aria-label="Invite to join" className="grow" placeholder="meshdrop://join?…" value={uri} onChange={(e) => setUri(e.target.value)} />
          {window.meshdrop.scanQr && (
            <button
              onClick={() =>
                void run(async () => {
                  const t = await window.meshdrop.scanQr!();
                  if (!t) return;
                  if (!t.startsWith('meshdrop://join?')) throw new Error('That QR code is not a MeshDrop invite.');
                  setUri(t);
                  return 'Invite scanned: tap Join';
                })
              }
            >
              Scan QR
            </button>
          )}
          <button
            disabled={uri.trim() === ''}
            onClick={() =>
              void run(async () => {
                const r = await window.meshdrop.join(uri.trim());
                setUri('');
                return r === 'member' ? 'Joined the mesh' : 'Invite accepted; finishing when the hub is reachable';
              })
            }
          >
            Join
          </button>
        </div>
        {!android && (
          <>
            <h2>Restore a mesh</h2>
            <p className="muted">Lost the hub PC? Import its recovery file here to make this PC the new hub.</p>
            <Recovery mode="import" run={run} />
          </>
        )}
      </section>
    );
  }

  return (
    <section>
      <p className="lead">{ROLE[hub.role]}</p>
      <p className="muted">
        List version {hub.version} · {hub.members} device{hub.members === 1 ? '' : 's'} ·{' '}
        <span className={hub.online ? 'ok-text' : 'error-text'}>{isHub ? (hub.online ? 'Hub running' : 'Hub stopped') : hub.online ? 'Connected to the hub' : 'Hub not reachable'}</span>
        {isHub && hub.ingressPort > 0 && <> · tunnel ingress 127.0.0.1:{hub.ingressPort}</>}
      </p>

      {!android && isHub && state.reach && (
        <>
          <h2>Internet access</h2>
          <InternetAccess key={`${state.reach.mode}:${state.reach.config.cloudflareHost ?? ''}:${state.reach.config.duckdnsDomain ?? ''}`} reach={state.reach} run={run} />
        </>
      )}
      {!android && (
        <>
          <h2>Hub address on the internet</h2>
          {isHub ? <HubUrls key={hub.urls.join('\n')} urls={hub.urls} run={run} /> : hub.urls.length === 0 ? <p className="muted">None (LAN only).</p> : <ul className="items">{hub.urls.map((u) => <li key={u}><code>{u}</code></li>)}</ul>}

          <h2>Invite a device</h2>
          {invite ? <QrInvite invite={invite} onRenew={() => void newInvite()} run={run} /> : <button onClick={() => void newInvite()}>Invite a device</button>}
        </>
      )}

      <h2>Members</h2>
      <ul className="list">
        {state.members.map((m) => (
          <li key={m.deviceId} className="member row space" data-device={m.deviceId}>
            <span>
              <Peer text={m.alias} /> <span className="muted">· {m.role === 'hub' ? 'Hub' : 'Member'} · <code>{m.deviceId.slice(0, 8)}</code></span>
              {m.self && <span className="badge">{android ? 'This phone' : 'This PC'}</span>}
            </span>
            {isHub && !m.self && <button onClick={() => setRevoking({ deviceId: m.deviceId, alias: m.alias })}>Revoke</button>}
          </li>
        ))}
      </ul>

      {isHub && (
        <>
          <h2>Recovery</h2>
          <p className="muted">Save the mesh key, encrypted with a passphrase, so another PC can take over as hub if this one is lost.</p>
          <Recovery mode="export" run={run} />
        </>
      )}

      {revoking && (
        <div className="modal-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="revoke-title" className="modal">
            <h2 id="revoke-title">Revoke this device?</h2>
            <p>
              <Peer text={revoking.alias} /> (<code>{revoking.deviceId.slice(0, 8)}</code>) leaves the mesh for good. It can only come back with a new invite.
            </p>
            <div className="row">
              <button onClick={() => setRevoking(null)}>Cancel</button>
              <button
                className="danger"
                onClick={() => {
                  const id = revoking.deviceId;
                  setRevoking(null);
                  void run(() => window.meshdrop.revoke(id), 'Device revoked');
                }}
              >
                Revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
