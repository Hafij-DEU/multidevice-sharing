import { useCallback, useEffect, useState } from 'react';
import type { AppState, WifiEapMethod, WifiPhase2, WifiProfileView, WifiScanAp, WifiSecurity, WifiStatusView } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { mark, t } from '../i18n.ts';

const api = window.meshdrop;

const SEC_LABEL: Record<WifiSecurity, string> = {
  open: mark('Open (no password)'),
  wpa2: mark('Password (WPA/WPA2)'),
  wpa3: mark('Password (WPA3)'),
  enterprise: mark('eduroam / 802.1X'),
};
const EAP_LABEL: Record<WifiEapMethod, string> = { peap: 'PEAP', ttls: 'TTLS', tls: mark('TLS (needs a client certificate)'), pwd: 'PWD' };
const PHASE2_LABEL: Record<WifiPhase2, string> = { mschapv2: 'MSCHAPv2', gtc: 'GTC', pap: 'PAP', none: mark('None') };

function signal(rssi: number): string {
  if (rssi >= -55) return 'strong';
  if (rssi >= -70) return 'ok';
  return 'weak';
}

/**
 * Parses a scanned Wi-Fi QR payload (WIFI:T:WPA;S:ssid;P:pass;H:true;;) into an Add-form draft, or
 * null when the text is not a Wi-Fi QR. Honours the reserved-character escaping (\ ; , : ").
 */
function draftFromWifiUri(text: string): SimpleDraft | null {
  const body = /^WIFI:(.*)$/is.exec(text.trim());
  if (!body) return null;
  const fields: Record<string, string> = {};
  let key = '';
  let val = '';
  let inVal = false;
  const s = body[1] ?? '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[++i] ?? '';
      if (inVal) val += n;
      else key += n;
    } else if (c === ':' && !inVal) {
      inVal = true;
    } else if (c === ';') {
      if (key) fields[key.toUpperCase()] = val;
      key = '';
      val = '';
      inVal = false;
    } else if (inVal) {
      val += c;
    } else {
      key += c;
    }
  }
  if (key) fields[key.toUpperCase()] = val;
  const ssid = fields.S ?? '';
  if (!ssid) return null;
  const type = (fields.T ?? '').toUpperCase();
  const open = type === 'NOPASS' || type === '';
  return { ssid, password: fields.P ?? '', open, hidden: (fields.H ?? '').toLowerCase() === 'true', secBase: type === 'SAE' ? 'wpa3' : 'wpa2' };
}

/** The live Wi-Fi connection on this device, and whether a MeshDrop band lock is in effect. */
function StatusCard({ s, onRefresh }: { s: WifiStatusView | null; onRefresh: () => void }) {
  return (
    <section className="wifi-status">
      <div className="row space">
        <h2>{t('This device')}</h2>
        <button onClick={onRefresh}>{t('Refresh')}</button>
      </div>
      {!s ? (
        <p className="muted">{t('Reading…')}</p>
      ) : !s.enabled ? (
        <p className="error-text">{t('Wi-Fi is off on this device.')}</p>
      ) : !s.connected ? (
        <p className="muted">
          {t('Not connected to Wi-Fi.')}
          {s.locked ? ` ${t('A band lock is set and waiting for its access point.')}` : ''}
        </p>
      ) : s.nameHidden ? (
        <>
          <p>{t('Connected to Wi-Fi · {band} GHz, channel {channel} · {rssi} dBm · {mbps} Mbps', { band: s.band ?? '', channel: s.channel ?? '', rssi: s.rssi ?? '', mbps: s.linkMbps ?? '' })}</p>
          {s.nameHidden === 'permission' ? (
            <div className="row space">
              <span className="muted">{t("Android shows MeshDrop the network's name only with Location allowed.")}</span>
              {api.wifiAskLocation && <button onClick={() => void api.wifiAskLocation!()}>{t('Allow location')}</button>}
            </div>
          ) : (
            <p className="muted">{t("Turn on Location in Android's quick settings to see which network this is.")}</p>
          )}
        </>
      ) : (
        <p>
          {t('On')} <strong>{s.ssid}</strong> · {t('{band} GHz, channel {channel} · {rssi} dBm · {mbps} Mbps', { band: s.band ?? '', channel: s.channel ?? '', rssi: s.rssi ?? '', mbps: s.linkMbps ?? '' })}
          {s.locked ? <span className="wifi-badge lock"> {t('band-locked')}</span> : <span className="muted"> · {t('not locked')}</span>}
        </p>
      )}
    </section>
  );
}

// ---- Add / edit a simple network: just a name and a password -----------------------------------

type SimpleDraft = { id?: string; ssid: string; password: string; open: boolean; hidden: boolean; secBase: WifiSecurity };

function blankSimple(): SimpleDraft {
  return { ssid: '', password: '', open: false, hidden: false, secBase: 'wpa2' };
}

function simpleFromProfile(p: WifiProfileView): SimpleDraft {
  return {
    id: p.id,
    ssid: p.ssid,
    password: '',
    open: p.security === 'open',
    hidden: p.hidden,
    // Keep WPA3 on edit; everything else saves as WPA2 and Android upgrades it to WPA3 if the scan says so.
    secBase: p.security === 'wpa3' ? 'wpa3' : 'wpa2',
  };
}

/** The everyday Add form: a network name and its password. Nothing else — band lock lives in its own section. */
function SimpleEditor({ draft, run, onSaved, onCancel }: { draft: SimpleDraft; run: Run; onSaved: () => void; onCancel: () => void }) {
  const [d, setD] = useState<SimpleDraft>(draft);
  const editing = !!d.id;
  const set = <K extends keyof SimpleDraft>(k: K, v: SimpleDraft[K]) => setD((p) => ({ ...p, [k]: v }));

  const save = () =>
    void run(() => {
      const security: WifiSecurity = d.open ? 'open' : d.secBase === 'wpa3' ? 'wpa3' : 'wpa2';
      // Only name, password, security and hidden go up: leaving the band-lock keys out means the save
      // never disturbs a lock set in the Band lock section below.
      return api.wifiSave!({
        id: d.id,
        ssid: d.ssid.trim(),
        security,
        password: d.open ? undefined : d.password || undefined,
        hidden: d.hidden,
      });
    }, editing ? t('Network updated') : t('Network saved')).then((r) => r && onSaved());

  return (
    <section className="wifi-editor">
      <h2>{editing ? t('Edit network') : t('Add a network')}</h2>

      <label className="field">
        <span>{t('Network name')}</span>
        <input value={d.ssid} maxLength={64} autoCapitalize="none" onChange={(e) => set('ssid', e.target.value)} placeholder={t('Home 5G')} />
      </label>

      {!d.open && (
        <label className="field">
          <span>{editing ? t('Password (leave blank to keep the saved one)') : t('Password')}</span>
          <input type="password" value={d.password} autoCapitalize="none" onChange={(e) => set('password', e.target.value)} placeholder={editing ? '••••••••' : ''} />
        </label>
      )}

      <label className="toggle">
        <input type="checkbox" checked={d.open} onChange={(e) => set('open', e.target.checked)} /> {t('Open network (no password)')}
      </label>
      <label className="toggle">
        <input type="checkbox" checked={d.hidden} onChange={(e) => set('hidden', e.target.checked)} /> {t('This is a hidden network')}
      </label>

      <div className="row">
        <button className="primary" onClick={save}>
          {editing ? t('Save changes') : t('Save network')}
        </button>
        <button onClick={onCancel}>{t('Cancel')}</button>
      </div>
      <p className="muted hint">{t('Saved here and synced to your trusted devices. To connect, use Copy password or Show QR and join from Android. A band lock lets MeshDrop connect for you.')}</p>
    </section>
  );
}

// ---- Add / edit an eduroam / 802.1X network ----------------------------------------------------

type EntDraft = {
  id?: string;
  ssid: string;
  password: string;
  hidden: boolean;
  eapMethod: WifiEapMethod;
  phase2: WifiPhase2;
  identity: string;
  anonymousIdentity: string;
  domainSuffixMatch: string;
  caCertPem: string;
  eapXml: string;
};

function blankEnt(): EntDraft {
  return { ssid: 'eduroam', password: '', hidden: false, eapMethod: 'peap', phase2: 'mschapv2', identity: '', anonymousIdentity: '', domainSuffixMatch: '', caCertPem: '', eapXml: '' };
}

function entFromProfile(p: WifiProfileView): EntDraft {
  return {
    ...blankEnt(),
    id: p.id,
    ssid: p.ssid,
    hidden: p.hidden,
    eapMethod: p.eapMethod ?? 'peap',
    phase2: p.phase2 ?? 'mschapv2',
    identity: p.identity ?? '',
    anonymousIdentity: p.anonymousIdentity ?? '',
    domainSuffixMatch: p.domainSuffixMatch ?? '',
  };
}

/** The separate entry point for enterprise networks: EAP method, identity, certificate and so on. */
function EnterpriseEditor({ draft, run, onSaved, onCancel }: { draft: EntDraft; run: Run; onSaved: () => void; onCancel: () => void }) {
  const [d, setD] = useState<EntDraft>(draft);
  const editing = !!d.id;
  const set = <K extends keyof EntDraft>(k: K, v: EntDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const showPhase2 = d.eapMethod === 'peap' || d.eapMethod === 'ttls';

  const save = () =>
    void run(() =>
      // No band-lock keys here either, so saving the login never clears a lock from the Band lock section.
      api.wifiSave!({
        id: d.id,
        ssid: d.ssid.trim(),
        security: 'enterprise',
        password: d.password || undefined,
        hidden: d.hidden,
        eapMethod: d.eapMethod,
        phase2: d.phase2,
        identity: d.identity.trim(),
        anonymousIdentity: d.anonymousIdentity.trim() || undefined,
        domainSuffixMatch: d.domainSuffixMatch.trim() || undefined,
        caCertPem: d.caCertPem.trim() || undefined,
        eapXml: d.eapXml.trim() || undefined,
      }),
    editing ? t('Network updated') : t('Network saved')).then((r) => r && onSaved());

  return (
    <section className="wifi-editor">
      <h2>{editing ? t('Edit eduroam / 802.1X') : t('Add eduroam / 802.1X')}</h2>
      <p className="muted hint">
        {t("You can paste your university's configuration below to fill in the method, server name and certificate; then just type your own username and password. PEAP or TTLS with MSCHAPv2 is the usual choice.")}
      </p>

      <label className="field">
        <span>{t('Network name')}</span>
        <input value={d.ssid} maxLength={64} autoCapitalize="none" onChange={(e) => set('ssid', e.target.value)} placeholder="eduroam" />
      </label>
      <label className="field">
        <span>{t('EAP method')}</span>
        <select value={d.eapMethod} onChange={(e) => set('eapMethod', e.target.value as WifiEapMethod)}>
          {(Object.keys(EAP_LABEL) as WifiEapMethod[]).map((k) => (
            <option key={k} value={k}>
              {t(EAP_LABEL[k])}
            </option>
          ))}
        </select>
      </label>
      {showPhase2 && (
        <label className="field">
          <span>{t('Inner method (phase 2)')}</span>
          <select value={d.phase2} onChange={(e) => set('phase2', e.target.value as WifiPhase2)}>
            {(Object.keys(PHASE2_LABEL) as WifiPhase2[]).map((k) => (
              <option key={k} value={k}>
                {t(PHASE2_LABEL[k])}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>{t('Username (identity)')}</span>
        <input value={d.identity} autoCapitalize="none" onChange={(e) => set('identity', e.target.value)} placeholder="you@uni.edu" />
      </label>
      {d.eapMethod !== 'tls' && (
        <label className="field">
          <span>{editing ? t('Password (leave blank to keep the saved one)') : t('Password')}</span>
          <input type="password" value={d.password} autoCapitalize="none" onChange={(e) => set('password', e.target.value)} placeholder={editing ? '••••••••' : ''} />
        </label>
      )}
      <label className="field">
        <span>{t('Outer identity (optional)')}</span>
        <input value={d.anonymousIdentity} autoCapitalize="none" onChange={(e) => set('anonymousIdentity', e.target.value)} placeholder="anonymous@uni.edu" />
      </label>
      <label className="field">
        <span>{t('Server name to verify (optional)')}</span>
        <input value={d.domainSuffixMatch} autoCapitalize="none" onChange={(e) => set('domainSuffixMatch', e.target.value)} placeholder="radius.uni.edu" />
      </label>
      <label className="field">
        <span>{t('Paste configuration (.eap-config / CAT XML, optional)')}</span>
        <textarea rows={3} value={d.eapXml} onChange={(e) => set('eapXml', e.target.value)} placeholder="<EAPIdentityProviderList>…" />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={d.hidden} onChange={(e) => set('hidden', e.target.checked)} /> {t('This is a hidden network')}
      </label>

      <div className="row">
        <button className="primary" onClick={save}>
          {editing ? t('Save changes') : t('Save network')}
        </button>
        <button onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </section>
  );
}

// ---- Saved networks ----------------------------------------------------------------------------

/** One saved network: its name, how it is secured, its band-lock state and edit/delete actions. */
function ProfileCard({ p, run, onEdit, onChanged, connected }: { p: WifiProfileView; run: Run; onEdit: () => void; onChanged: () => void; connected?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  return (
    <section className="wifi-profile" data-ssid={p.ssid}>
      <div className="row space">
        <span className="menu-title">
          {p.ssid}
          {connected && <span className="wifi-badge ok"> {t('Connected')}</span>}
        </span>
        <span className="muted">{SEC_LABEL[p.security]}</span>
      </div>
      <div className="row space">
        <span className="muted">
          {p.lockBssid ? (
            <>
              {t('Band-locked to')} <code>{p.lockBssid}</code>
              {p.band ? ` (${p.band} GHz)` : ''}
              {p.fallback ? ` · ${t('with fallback')}` : ''}
            </>
          ) : (
            t('Any access point')
          )}
          {p.enterprise && p.identity ? ` · ${p.identity}` : ''}
          {p.hidden ? ` · ${t('hidden')}` : ''}
        </span>
        <span className="row">
          {api.wifiAddToSystem && !p.enterprise && (
            <button onClick={() => void run(() => api.wifiAddToSystem!(p.id), t('Opening Android to save and connect…'))}>
              {t('Connect')}
            </button>
          )}
          {api.wifiCopy && p.hasPassword && !p.enterprise && (
            <button onClick={() => void run(() => api.wifiCopy!(p.id), t('Password copied — paste it into your Wi-Fi settings'))}>
              {t('Copy password')}
            </button>
          )}
          {api.wifiQr && !p.enterprise && (
            <button onClick={() => (qr ? setQr(null) : void run(() => api.wifiQr!(p.id)).then((svg) => svg && setQr(svg)))}>
              {qr ? t('Hide QR') : t('Show QR')}
            </button>
          )}
          {api.wifiShare && !p.enterprise && (
            <button onClick={() => void run(() => api.wifiShare!(p.id), undefined)}>
              {t('Share')}
            </button>
          )}
          {api.wifiSave && <button onClick={onEdit}>{t('Edit')}</button>}
          {api.wifiDelete && (
            <button
              className={confirm ? 'danger' : ''}
              onClick={() => {
                if (!confirm) {
                  setConfirm(true);
                  setTimeout(() => setConfirm(false), 4000);
                  return;
                }
                void run(() => api.wifiDelete!(p.id), t('Network deleted')).then(onChanged);
              }}
            >
              {confirm ? t('Tap again to delete') : t('Delete')}
            </button>
          )}
        </span>
      </div>
      {qr && (
        <div className="wifi-qr">
          <img alt={t('Wi-Fi QR for {ssid}', { ssid: p.ssid })} src={`data:image/svg+xml;base64,${btoa(qr)}`} />
          <p className="muted hint">{t("Scan with another phone's camera to join {ssid}.", { ssid: p.ssid })}</p>
        </div>
      )}
    </section>
  );
}

// ---- Band lock (its own section) ---------------------------------------------------------------

/** One saved network's band-lock controls: scan, pin an access point, or go back to any access point. */
function BandLockRow({ p, run, onChanged }: { p: WifiProfileView; run: Run; onChanged: () => void }) {
  const [aps, setAps] = useState<WifiScanAp[] | null>(null);

  const scan = () =>
    void run(() => api.wifiScan!(p.ssid || undefined)).then((r) => {
      if (r) setAps([...r].sort((a, b) => b.rssi - a.rssi));
    });
  const pin = (ap: WifiScanAp) =>
    void run(() => api.wifiLock!(p.id, ap.bssid, ap.band, p.fallback), t('Pinned {ssid} to {band} GHz', { ssid: p.ssid, band: ap.band })).then(() => {
      setAps(null);
      onChanged();
    });
  const unpin = () => void run(() => api.wifiLock!(p.id, null, null, false), t('{ssid}: using any access point', { ssid: p.ssid })).then(onChanged);
  const toggleFallback = (v: boolean) => void run(() => api.wifiLock!(p.id, p.lockBssid ?? null, p.band ?? null, v)).then(onChanged);

  return (
    <section className="wifi-profile" data-ssid={p.ssid}>
      <div className="row space">
        <span className="menu-title">{p.ssid}</span>
        <span className="muted">
          {p.lockBssid ? (
            <>
              {t('Pinned to')} <code>{p.lockBssid}</code>
              {p.band ? ` · ${p.band} GHz` : ''}
            </>
          ) : (
            t('Any access point')
          )}
        </span>
      </div>
      <div className="row">
        <button onClick={scan}>{p.lockBssid ? t('Change access point') : t('Pin an access point')}</button>
        {p.lockBssid && <button onClick={unpin}>{t('Use any access point')}</button>}
      </div>
      {aps && (
        <ul className="list wifi-aps">
          {aps.length === 0 ? (
            <li className="muted">{t('No access points found. Make sure Wi-Fi is on and try again.')}</li>
          ) : (
            aps.map((ap) => (
              <li key={ap.bssid} className="row space">
                <button className={p.lockBssid === ap.bssid ? 'primary' : ''} onClick={() => pin(ap)}>
                  {t('{band} GHz · ch {channel}', { band: ap.band, channel: ap.channel })}
                </button>
                <span className={`muted sig-${signal(ap.rssi)}`}>
                  {ap.ssid || t('(hidden)')} · {ap.bssid} · {ap.rssi} dBm
                </span>
              </li>
            ))
          )}
        </ul>
      )}
      <label className="toggle">
        <input type="checkbox" checked={p.fallback} disabled={!p.lockBssid} onChange={(e) => toggleFallback(e.target.checked)} /> {t('Still join on another band when this access point is out of range')}
      </label>
    </section>
  );
}

/** M4: pin saved networks to one access point, each on its own, kept apart from the save form. */
function BandLockSection({ profiles, run, onChanged }: { profiles: WifiProfileView[]; run: Run; onChanged: () => void }) {
  if (!api.wifiLock) return null;
  return (
    <section className="wifi-band-lock">
      <div className="banner" role="note">
        {t("For a band lock to take effect, open Android's own Wi-Fi settings and forget that network there first. A network saved in the system beats MeshDrop's pin, so the system one would win otherwise.")}
      </div>
      <p className="muted hint">
        {t('Pin a saved network to one access point so your device cannot drop to a slower band. Scan, then pick the 5 GHz (or 6 GHz) access point you want. Pinning needs Android 11 or newer.')}
      </p>
      {profiles.length === 0 ? (
        <p className="muted">{t('No saved network matches.')}</p>
      ) : (
        profiles.map((p) => <BandLockRow key={p.id} p={p} run={run} onChanged={onChanged} />)
      )}
    </section>
  );
}

// ---- The Wi-Fi tab -----------------------------------------------------------------------------

/** Whether this run already asked for Location on the user's behalf (the button can still ask again). */
let askedLocation = false;

/** The Wi-Fi tab: the user's own saved networks, applied and synced automatically, with band lock apart. */
export function Wifi({ state: _state, run }: { state: AppState; run: Run }) {
  const [profiles, setProfiles] = useState<WifiProfileView[] | null>(null);
  const [simple, setSimple] = useState<SimpleDraft | null>(null);
  const [enterprise, setEnterprise] = useState<EntDraft | null>(null);
  const [status, setStatus] = useState<WifiStatusView | null>(null);
  // Two views on Android (saved networks, band lock); each opens on the network we are connected to.
  const [view, setView] = useState<'saved' | 'lock'>('saved');
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState('');

  const reload = useCallback(() => void run(() => api.wifiList!()).then((r) => r && setProfiles(r)), [run]);
  useEffect(reload, [reload]);

  // The live link for this device: drives the status card and badges the saved network we are actually on.
  const refreshStatus = useCallback(() => {
    if (!api.wifiStatus) return;
    void run(() => api.wifiStatus!()).then((r) => r && setStatus(r));
  }, [run]);
  useEffect(refreshStatus, [refreshStatus]);

  // Android names the current network only to apps allowed Location: ask once per run, the first time it is hidden.
  useEffect(() => {
    if (status?.nameHidden !== 'permission' || askedLocation || !api.wifiAskLocation) return;
    askedLocation = true;
    void api.wifiAskLocation();
  }, [status?.nameHidden]);

  // "Connect" hands off to Android's own dialog and the link comes up a few seconds later, so keep the
  // badge honest with a quiet poll while this tab is open (no toasts: a failed read just keeps the last one).
  useEffect(() => {
    if (!api.wifiStatus) return;
    const t = setInterval(() => {
      api.wifiStatus!().then(setStatus, () => {});
    }, 4000);
    return () => clearInterval(t);
  }, []);

  // Catch up with the user's other devices on open: pull their networks and push ours, quietly.
  useEffect(() => {
    if (!api.wifiSyncNow) return;
    void run(() => api.wifiSyncNow!(), undefined).then((r) => {
      if (r && r.merged > 0) run(async () => t('{n} network change(s) came in from your devices.', { n: r.merged }));
      reload();
    });
    // Runs once when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!api.wifiList) return <p className="muted">{t('The Wi-Fi tools are available on Android.')}</p>;

  // The desktop app is view-only: it shows the networks synced from the phone and lets the user copy a
  // password, show a join QR or copy the sharable details, but never saves, edits or connects (no api.wifiSave).
  const canEdit = !!api.wifiSave;
  const connectedSsid = status?.connected ? status.ssid : undefined;
  // The connected network first; with one connected, only it shows until "Show all" (a long list is hard to scan on a phone).
  const current = connectedSsid ? profiles?.find((p) => p.ssid === connectedSsid) : undefined;
  const q = filter.trim().toLowerCase();
  const ordered = profiles ? [...(current ? [current] : []), ...profiles.filter((p) => p !== current)] : [];
  const shown = q ? ordered.filter((p) => p.ssid.toLowerCase().includes(q)) : current && !showAll ? [current] : ordered;

  const syncNow = () =>
    void run(() => api.wifiSyncNow!(), undefined).then((r) => {
      if (!r) return;
      const msg =
        r.devices === 0
          ? t('No other trusted devices online to sync with.')
          : t('Synced with {reached}/{devices} device(s). {merged} change(s) came in.', { reached: r.reached, devices: r.devices, merged: r.merged });
      run(async () => msg).then(reload);
    });

  // Scan a Wi-Fi QR (Android's own "Share network" QR, or another phone's) and open the Add form prefilled.
  const scanToAdd = () =>
    void run(() => api.scanQr!()).then((text) => {
      if (!text) return;
      const d = draftFromWifiUri(text);
      if (!d) {
        void run(() => Promise.reject(new Error(t('That QR code is not a Wi-Fi network.'))));
        return;
      }
      setSimple(d);
    });

  if (simple) {
    return (
      <section className="wifi">
        <SimpleEditor draft={simple} run={run} onSaved={() => { setSimple(null); reload(); }} onCancel={() => setSimple(null)} />
      </section>
    );
  }
  if (enterprise) {
    return (
      <section className="wifi">
        <EnterpriseEditor draft={enterprise} run={run} onSaved={() => { setEnterprise(null); reload(); }} onCancel={() => setEnterprise(null)} />
      </section>
    );
  }

  return (
    <section className="wifi">
      {api.wifiStatus && <StatusCard s={status} onRefresh={refreshStatus} />}

      {api.wifiLock && (
        <div className="wifi-tabs" role="tablist" aria-label={t('Wi-Fi')}>
          <button role="tab" aria-selected={view === 'saved'} className={view === 'saved' ? 'active' : ''} onClick={() => setView('saved')}>
            {t('Saved networks')}
          </button>
          <button role="tab" aria-selected={view === 'lock'} className={view === 'lock' ? 'active' : ''} onClick={() => setView('lock')}>
            {t('Band lock')}
          </button>
        </div>
      )}

      {profiles && profiles.length > 1 && (
        <div className="wifi-more">
          {(showAll || !current) && profiles.length > 4 && (
            <input type="search" aria-label={t('Find a network')} placeholder={t('Find among {n} networks', { n: profiles.length })} value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          {current && (
            <button className="link" onClick={() => { setShowAll(!showAll); setFilter(''); }}>
              {showAll ? t('Only the connected network') : t('Show all {n} networks', { n: profiles.length })}
            </button>
          )}
        </div>
      )}

      {view === 'lock' && api.wifiLock ? (
        profiles === null ? <p className="muted">{t('Loading…')}</p> : profiles.length === 0 ? <p className="muted">{t('Save a network first, then pin it here.')}</p> : <BandLockSection profiles={shown} run={run} onChanged={reload} />
      ) : (
      <>
      <div className="row space">
        <h2>{t('Saved networks')}</h2>
        <span className="row">
          {api.scanQr && <button onClick={scanToAdd}>{t('Scan a QR')}</button>}
          {canEdit && (
            <button className="primary" onClick={() => setSimple(blankSimple())}>
              {t('Add a network')}
            </button>
          )}
        </span>
      </div>

      {profiles === null ? (
        <p className="muted">{t('Loading…')}</p>
      ) : profiles.length === 0 ? (
        <p className="muted">
          {canEdit
            ? t('No networks yet. Add one — type a password you know, even one you forgot elsewhere and are re-entering here.')
            : t('No networks yet. Add them on your phone, then use Sync now — they appear here, passwords included.')}
        </p>
      ) : (
        shown.map((p) => (
          <ProfileCard key={p.id} p={p} run={run} connected={!!connectedSsid && p.ssid === connectedSsid} onEdit={() => (p.enterprise ? setEnterprise(entFromProfile(p)) : setSimple(simpleFromProfile(p)))} onChanged={reload} />
        ))
      )}

      <div className="row">
        {canEdit && <button onClick={() => setEnterprise(blankEnt())}>{t('Add eduroam / 802.1X')}</button>}
        {api.wifiSyncNow ? <button onClick={syncNow}>{t('Sync now')}</button> : null}
        {api.wifiForget && (
          <button onClick={() => void run(() => api.wifiForget!(), t("Removed MeshDrop's Wi-Fi suggestions"))}>{t('Remove suggestions')}</button>
        )}
      </div>
      <p className="muted hint">
        {canEdit
          ? t('Saved networks are stored and synced to your own trusted devices, passwords included, over the encrypted link. To join one, use Copy password or Show QR and connect from Android; only a band-locked network is connected by MeshDrop itself. Sync now pulls in networks you added on another device; Remove suggestions clears the band-lock connections MeshDrop registered (your saved networks stay).')
          : t('These networks sync from your phone over the encrypted link, passwords included. To join one here, use Copy password or Show QR and connect from your system Wi-Fi settings — MeshDrop does not connect for you. Sync now pulls in the latest from your other devices.')}
      </p>
      </>
      )}
    </section>
  );
}
