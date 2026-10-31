import { useCallback, useEffect, useState } from 'react';
import type { AppState, WifiEapMethod, WifiPhase2, WifiProfileView, WifiScanAp, WifiSecurity, WifiStatusView } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { fmtTime } from '../format.ts';

const api = window.meshdrop;

const SEC_LABEL: Record<WifiSecurity, string> = {
  open: 'Open (no password)',
  wpa2: 'WPA/WPA2 (password)',
  wpa3: 'WPA3 (password)',
  enterprise: 'Enterprise 802.1X / eduroam',
};
const EAP_LABEL: Record<WifiEapMethod, string> = { peap: 'PEAP', ttls: 'TTLS', tls: 'TLS (needs a client certificate)', pwd: 'PWD' };
const PHASE2_LABEL: Record<WifiPhase2, string> = { mschapv2: 'MSCHAPv2', gtc: 'GTC', pap: 'PAP', none: 'None' };

function signal(rssi: number): string {
  if (rssi >= -55) return 'strong';
  if (rssi >= -70) return 'ok';
  return 'weak';
}

/** The live Wi-Fi connection on this device, and whether a MeshDrop band lock is in effect. */
function StatusCard({ run }: { run: Run }) {
  const [s, setS] = useState<WifiStatusView | null>(null);
  const refresh = useCallback(() => void run(() => api.wifiStatus!()).then((r) => r && setS(r)), [run]);
  useEffect(refresh, [refresh]);
  return (
    <section className="wifi-status">
      <div className="row space">
        <h2>This device</h2>
        <button onClick={refresh}>Refresh</button>
      </div>
      {!s ? (
        <p className="muted">Reading…</p>
      ) : !s.enabled ? (
        <p className="error-text">Wi-Fi is off on this device.</p>
      ) : !s.connected ? (
        <p className="muted">Not connected to Wi-Fi.{s.locked ? ' A band lock is set and waiting for its access point.' : ''}</p>
      ) : (
        <p>
          On <strong>{s.ssid}</strong> · {s.band} GHz, channel {s.channel} · {s.rssi} dBm · {s.linkMbps} Mbps
          {s.locked ? <span className="wifi-badge lock"> band-locked</span> : <span className="muted"> · not locked</span>}
        </p>
      )}
    </section>
  );
}

type Draft = {
  id?: string;
  ssid: string;
  security: WifiSecurity;
  password: string;
  lockBssid: string | null;
  band: string | null;
  fallback: boolean;
  hidden: boolean;
  eapMethod: WifiEapMethod;
  phase2: WifiPhase2;
  identity: string;
  anonymousIdentity: string;
  domainSuffixMatch: string;
  caCertPem: string;
  eapXml: string;
};

function blankDraft(): Draft {
  return {
    ssid: '',
    security: 'wpa2',
    password: '',
    lockBssid: null,
    band: null,
    fallback: false,
    hidden: false,
    eapMethod: 'peap',
    phase2: 'mschapv2',
    identity: '',
    anonymousIdentity: '',
    domainSuffixMatch: '',
    caCertPem: '',
    eapXml: '',
  };
}

function fromProfile(p: WifiProfileView): Draft {
  return {
    ...blankDraft(),
    id: p.id,
    ssid: p.ssid,
    security: p.security,
    lockBssid: p.lockBssid ?? null,
    band: p.band ?? null,
    fallback: p.fallback,
    hidden: p.hidden,
    eapMethod: p.eapMethod ?? 'peap',
    phase2: p.phase2 ?? 'mschapv2',
    identity: p.identity ?? '',
    anonymousIdentity: p.anonymousIdentity ?? '',
    domainSuffixMatch: p.domainSuffixMatch ?? '',
  };
}

/** Add or edit one network. Enterprise fields and the band-lock scanner appear only when they apply. */
function Editor({ draft, editing, run, onSaved, onCancel }: { draft: Draft; editing: boolean; run: Run; onSaved: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [aps, setAps] = useState<WifiScanAp[] | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const open = d.security === 'open';
  const enterprise = d.security === 'enterprise';
  const showPhase2 = enterprise && (d.eapMethod === 'peap' || d.eapMethod === 'ttls');
  const pwLabel = enterprise ? 'Password' : 'Wi-Fi password';
  const pwHint = editing ? ' (leave blank to keep the saved one)' : '';

  const scan = () =>
    void run(() => api.wifiScan!(d.ssid.trim() || undefined)).then((r) => {
      if (r) setAps([...r].sort((a, b) => b.rssi - a.rssi));
    });

  const save = () =>
    void run(() => {
      const input = {
        id: d.id,
        ssid: d.ssid.trim(),
        security: d.security,
        password: d.password || undefined,
        lockBssid: d.lockBssid,
        band: d.band,
        fallback: d.fallback,
        hidden: d.hidden,
        ...(enterprise
          ? {
              eapMethod: d.eapMethod,
              phase2: d.phase2,
              identity: d.identity.trim(),
              anonymousIdentity: d.anonymousIdentity.trim() || undefined,
              domainSuffixMatch: d.domainSuffixMatch.trim() || undefined,
              caCertPem: d.caCertPem.trim() || undefined,
              eapXml: d.eapXml.trim() || undefined,
            }
          : {}),
      };
      return api.wifiSave!(input);
    }, editing ? 'Network updated' : 'Network saved').then((r) => r && onSaved());

  return (
    <section className="wifi-editor">
      <h2>{editing ? 'Edit network' : 'Add a network'}</h2>

      <label className="field">
        <span>Network name (SSID)</span>
        <input value={d.ssid} maxLength={64} autoCapitalize="none" onChange={(e) => set('ssid', e.target.value)} placeholder="eduroam" />
      </label>

      <label className="field">
        <span>Security</span>
        <select value={d.security} onChange={(e) => set('security', e.target.value as WifiSecurity)}>
          {(Object.keys(SEC_LABEL) as WifiSecurity[]).map((k) => (
            <option key={k} value={k}>
              {SEC_LABEL[k]}
            </option>
          ))}
        </select>
      </label>

      {enterprise && (
        <>
          <p className="muted hint">
            For eduroam, you can paste your university&apos;s configuration below to fill in the method, server name and certificate; then just type your
            own username and password. PEAP or TTLS with MSCHAPv2 is the usual choice.
          </p>
          <label className="field">
            <span>EAP method</span>
            <select value={d.eapMethod} onChange={(e) => set('eapMethod', e.target.value as WifiEapMethod)}>
              {(Object.keys(EAP_LABEL) as WifiEapMethod[]).map((k) => (
                <option key={k} value={k}>
                  {EAP_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          {showPhase2 && (
            <label className="field">
              <span>Inner method (phase 2)</span>
              <select value={d.phase2} onChange={(e) => set('phase2', e.target.value as WifiPhase2)}>
                {(Object.keys(PHASE2_LABEL) as WifiPhase2[]).map((k) => (
                  <option key={k} value={k}>
                    {PHASE2_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Username (identity)</span>
            <input value={d.identity} autoCapitalize="none" onChange={(e) => set('identity', e.target.value)} placeholder="you@uni.edu" />
          </label>
          <label className="field">
            <span>Outer identity (optional)</span>
            <input value={d.anonymousIdentity} autoCapitalize="none" onChange={(e) => set('anonymousIdentity', e.target.value)} placeholder="anonymous@uni.edu" />
          </label>
          <label className="field">
            <span>Server name to verify (optional)</span>
            <input value={d.domainSuffixMatch} autoCapitalize="none" onChange={(e) => set('domainSuffixMatch', e.target.value)} placeholder="radius.uni.edu" />
          </label>
          <label className="field">
            <span>Paste configuration (.eap-config / CAT XML, optional)</span>
            <textarea rows={3} value={d.eapXml} onChange={(e) => set('eapXml', e.target.value)} placeholder="<EAPIdentityProviderList>…" />
          </label>
        </>
      )}

      {!open && d.eapMethod !== 'tls' && (
        <label className="field">
          <span>
            {pwLabel}
            {pwHint}
          </span>
          <input type="password" value={d.password} autoCapitalize="none" onChange={(e) => set('password', e.target.value)} placeholder={editing ? '••••••••' : ''} />
        </label>
      )}

      <h3>Band lock (optional)</h3>
      <p className="muted hint">
        Pin this network to one access point so your device cannot drop to a slower band. Scan, then pick the 5 GHz (or 6 GHz) access point you want. Pinning needs
        Android 11 or newer.
      </p>
      <div className="row">
        <button onClick={scan}>Scan nearby</button>
        {d.lockBssid && (
          <button onClick={() => { set('lockBssid', null); set('band', null); }}>Use any access point</button>
        )}
      </div>
      {d.lockBssid && (
        <p>
          Pinned to <code>{d.lockBssid}</code>
          {d.band ? ` · ${d.band} GHz` : ''}
        </p>
      )}
      {aps && (
        <ul className="list wifi-aps">
          {aps.length === 0 ? (
            <li className="muted">No access points found. Make sure Wi-Fi is on and try again.</li>
          ) : (
            aps.map((ap) => (
              <li key={ap.bssid} className="row space">
                <button
                  className={d.lockBssid === ap.bssid ? 'primary' : ''}
                  onClick={() => { set('lockBssid', ap.bssid); set('band', ap.band); if (!d.ssid) set('ssid', ap.ssid); }}
                >
                  {ap.band} GHz · ch {ap.channel}
                </button>
                <span className={`muted sig-${signal(ap.rssi)}`}>
                  {ap.ssid || '(hidden)'} · {ap.bssid} · {ap.rssi} dBm
                </span>
              </li>
            ))
          )}
        </ul>
      )}

      <label className="toggle">
        <input type="checkbox" checked={d.fallback} disabled={!d.lockBssid} onChange={(e) => set('fallback', e.target.checked)} /> Still join on another band when this access point is out of range
      </label>
      <label className="toggle">
        <input type="checkbox" checked={d.hidden} onChange={(e) => set('hidden', e.target.checked)} /> This is a hidden network
      </label>

      <div className="row">
        <button className="primary" onClick={save}>
          {editing ? 'Save changes' : 'Save network'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

/** One saved network: its name, how it is secured, its band-lock state and edit/delete actions. */
function ProfileCard({ p, run, onEdit, onChanged }: { p: WifiProfileView; run: Run; onEdit: () => void; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="wifi-profile" data-ssid={p.ssid}>
      <div className="row space">
        <span className="menu-title">{p.ssid}</span>
        <span className="muted">{SEC_LABEL[p.security]}</span>
      </div>
      <div className="row space">
        <span className="muted">
          {p.lockBssid ? (
            <>
              Band-locked to <code>{p.lockBssid}</code>
              {p.band ? ` (${p.band} GHz)` : ''}
              {p.fallback ? ' · with fallback' : ''}
            </>
          ) : (
            'Any access point'
          )}
          {p.enterprise && p.identity ? ` · ${p.identity}` : ''}
          {p.hidden ? ' · hidden' : ''}
        </span>
        <span className="row">
          <button onClick={onEdit}>Edit</button>
          <button
            className={confirm ? 'danger' : ''}
            onClick={() => {
              if (!confirm) {
                setConfirm(true);
                setTimeout(() => setConfirm(false), 4000);
                return;
              }
              void run(() => api.wifiDelete!(p.id), 'Network deleted').then(onChanged);
            }}
          >
            {confirm ? 'Tap again to delete' : 'Delete'}
          </button>
        </span>
      </div>
    </section>
  );
}

/** M4: the Wi-Fi tab — the user's own saved networks, band lock, and eduroam/802.1X, all in MeshDrop. */
export function Wifi({ state: _state, run }: { state: AppState; run: Run }) {
  const [profiles, setProfiles] = useState<WifiProfileView[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  const reload = useCallback(() => void run(() => api.wifiList!()).then((r) => r && setProfiles(r)), [run]);
  useEffect(reload, [reload]);

  if (!api.wifiList || !api.wifiSave) return <p className="muted">The Wi-Fi tools are available on Android.</p>;

  const applyAll = () =>
    void run(() => api.wifiApply!(), undefined).then((r) => {
      if (!r) return;
      const msg = r.canLock
        ? `Applied ${r.profiles} network(s).`
        : `Applied ${r.profiles} network(s). This Android is too old to pin a band — the networks still connect.`;
      run(async () => msg);
    });

  return (
    <section className="wifi">
      <StatusCard run={run} />

      <div className="banner" role="note">
        For a band lock to take effect, open Android&apos;s own Wi-Fi settings and forget that network there first. A network saved in the system beats
        MeshDrop&apos;s pin, so the system one would win otherwise.
      </div>

      {editing ? (
        <Editor
          draft={editing}
          editing={!!editing.id}
          run={run}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="row space">
            <h2>Saved networks</h2>
            <button className="primary" onClick={() => setEditing(blankDraft())}>
              Add a network
            </button>
          </div>

          {profiles === null ? (
            <p className="muted">Loading…</p>
          ) : profiles.length === 0 ? (
            <p className="muted">No networks yet. Add one — type a password you know, even one you forgot elsewhere and are re-entering here.</p>
          ) : (
            <>
              {profiles.map((p) => (
                <ProfileCard key={p.id} p={p} run={run} onEdit={() => setEditing(fromProfile(p))} onChanged={reload} />
              ))}
              <div className="row">
                <button className="primary" onClick={applyAll}>
                  Apply all
                </button>
                <button onClick={() => void run(() => api.wifiForget!(), "Removed MeshDrop's Wi-Fi suggestions")}>Remove suggestions</button>
              </div>
              <p className="muted hint">
                Apply tells Android to offer these networks (and keep the band locks). Remove suggestions undoes that; your saved networks here stay.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
