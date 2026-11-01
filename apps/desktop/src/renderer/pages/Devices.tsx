import { useEffect, useRef, useState } from 'react';
import type { AppState, SendItemInput } from '../../shared/api.ts';
import { DeviceCard } from '../components/DeviceCard.tsx';
import { DropZone } from '../components/DropZone.tsx';
import { HubBanner } from '../components/HubBanner.tsx';
import { ProgressRow } from '../components/ProgressRow.tsx';
import { QrInvite, type Invite } from '../components/QrInvite.tsx';
import { baseName } from '../format.ts';
import { t } from '../i18n.ts';
import type { Run } from '../App.tsx';

const DEFAULT_PORT = 53318;

function Icon({ d }: { d: string }) {
  return (
    <svg className="act-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const MIC = 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3';

/** "host", "host:port", "[v6]:port" or a bare IPv6 address. */
function parseAddress(s: string): { host: string; port: number } | null {
  const str = s.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(str);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : DEFAULT_PORT };
  const parts = str.split(':');
  if (parts.length > 2) return { host: str, port: DEFAULT_PORT };
  const [host, port] = parts;
  if (!host) return null;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return null;
  return { host, port: port ? Number(port) : DEFAULT_PORT };
}

/** M11 voice notes: record here, then it goes in the list like a file. */
function VoiceNote({ run, onDone }: { run: Run; onDone: (path: string) => void }) {
  const [rec, setRec] = useState<{ r: MediaRecorder; started: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!rec) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [rec]);
  const start = () =>
    void run(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const r = new MediaRecorder(stream, type ? { mimeType: type } : {});
      const parts: Blob[] = [];
      r.ondataavailable = (e) => parts.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((tk) => tk.stop());
        void run(async () => {
          const blob = new Blob(parts, { type: r.mimeType });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          const ext = r.mimeType.includes('ogg') ? 'ogg' : 'webm';
          const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
          onDone(await window.meshdrop.saveBlob(`Voice note ${stamp}.${ext}`, btoa(bin)));
        });
      };
      r.start();
      setRec({ r, started: Date.now() });
    });
  if (rec) {
    const s = Math.floor((now - rec.started) / 1000);
    return (
      <button className="danger" onClick={() => (rec.r.stop(), setRec(null))}>
        ■ {t('Stop recording')} {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
      </button>
    );
  }
  return (
    <button className="act" onClick={start}>
      <Icon d={MIC} />
      <span>{t('Voice Note')}</span>
    </button>
  );
}

/**
 * One QR for all your devices: the PC shows a group invite (making itself the hub first if there is
 * no mesh yet); a phone scans it. Every device that joins sees every other one, no pairing needed.
 */
function OneQr({ state, run }: { state: AppState; run: Run }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const android = state.platform === 'android';
  const role = state.hub.role;
  if (android || window.meshdrop.scanQr) {
    if (!window.meshdrop.scanQr) return null;
    if (role === 'member' || role === 'hub') return null;
    return (
      <div className="one-qr">
        <p className="muted">{t('Quickest: scan the QR shown on your PC (Send → Add a device there). This {what} joins all your devices at once.', { what: android ? t('phone') : t('device') })}</p>
        <button
          className="primary"
          onClick={() =>
            void run(async () => {
              const code = await window.meshdrop.scanQr!();
              if (!code) return;
              if (!code.startsWith('meshdrop://join?')) throw new Error(t('That QR code is not a MeshDrop QR.'));
              const r = await window.meshdrop.join(code);
              return r === 'member' ? t('Joined: your devices are connected.') : t('Joined: it completes when the PC is reachable.');
            })
          }
        >
          {t('Scan QR')}
        </button>
      </div>
    );
  }
  const show = () =>
    void run(async () => {
      if (role === 'none') await window.meshdrop.hubInit([]);
      setInvite(await window.meshdrop.createInvite(true));
    });
  return (
    <div className="one-qr">
      {invite ? (
        <QrInvite invite={invite} onRenew={show} run={run} group />
      ) : (
        <>
          <p className="muted">
            {t('Quickest: show one QR and scan it with each phone or PC.')}
            {role === 'none' ? ` ${t('This PC becomes the hub that links them.')}` : ''}
          </p>
          <button className="primary" onClick={show}>
            {t('Show one QR for all my devices')}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The Send page. `compact` is the "Send to Devices" card on the PC's Home: devices, items and the
 * Send button only (no shared-in items, scheduled list, history or Add a device).
 */
export function Devices({ state, run, compact }: { state: AppState; run: Run; compact?: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<SendItemInput[]>([]);
  const [text, setText] = useState<string | null>(null);
  const [addr, setAddr] = useState('');
  const [name, setName] = useState('');
  const flick = useRef<{ y: number; t: number } | null>(null);
  const [burn, setBurn] = useState(false);
  const [print, setPrint] = useState(false);
  const [later, setLater] = useState('');
  const [showOpts, setShowOpts] = useState(false);
  const [pairing, setPairing] = useState<{ host: string; port: number; name: string; deviceId: string; alias: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(state.devices.every((d) => !d.trusted && d.role !== 'localsend' && d.role !== 'addon'));

  // LocalSend apps and add-on peers (Quick Share, ...) can be sent to (they ask their user), so they sit with the trusted devices.
  const trusted = state.devices.filter((d) => d.trusted || d.role === 'localsend' || d.role === 'addon');
  const nearby = state.devices.filter((d) => !d.trusted && d.role !== 'localsend' && d.role !== 'addon');
  const targets = all ? trusted.filter((d) => d.reach !== 'offline').map((d) => d.deviceId) : [...selected].filter((id) => trusted.some((d) => d.deviceId === id));
  const payload: SendItemInput[] = [...items, ...(text !== null && text !== '' ? [{ kind: 'text' as const, text }] : [])];
  const canSend = targets.length > 0 && payload.length > 0 && !busy;

  const android = state.platform === 'android';
  const shared = state.sharedPending ?? 0;
  useEffect(() => {
    if (!compact && shared > 0 && window.meshdrop.takeSharedItems) {
      void run(async () => {
        const got = await window.meshdrop.takeSharedItems!();
        const files = got.filter((g) => g.kind !== 'text');
        const txt = got.find((g) => g.kind === 'text');
        if (files.length > 0) setItems((cur) => [...cur, ...files]);
        if (txt?.text) setText(txt.text);
      });
    }
  }, [shared]);

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
    const at = later ? new Date(later).getTime() : undefined;
    const opts = { ...(burn ? { burn: true } : {}), ...(print ? { print: true } : {}), ...(at && at > Date.now() ? { at } : {}) };
    const ok = await run(() => window.meshdrop.send(all ? 'all' : targets, payload, opts), at && at > Date.now() ? t('Scheduled for {when}', { when: new Date(at).toLocaleString() }) : t('Sending…'));
    setBusy(false);
    if (ok !== undefined) {
      setItems([]);
      setText(null);
      setLater('');
    }
  };

  const addByAddress = async () => {
    const a = parseAddress(addr);
    if (!a) {
      await run(() => Promise.reject(new Error(t('Enter an address like 192.168.1.20 or 192.168.1.20:53318.'))));
      return;
    }
    await startPair(a.host, a.port, name.trim());
  };

  /** Shows the pairing code first: trust is added only after the user saw the same code on both screens. */
  const startPair = async (host: string, port: number, alias: string) => {
    const p = await run(() => window.meshdrop.pairProbe(host, port));
    if (p !== undefined) setPairing({ host, port, name: alias, ...p });
  };
  const confirmPair = async () => {
    if (!pairing) return;
    const { host, port, name: alias, deviceId } = pairing;
    const who = alias || pairing.alias;
    setPairing(null);
    const ok = await run(
      () => window.meshdrop.addByAddress(host, port, who, deviceId),
      t('Paired with {name}. Now press Pair for this {what} on {name} too: both sides must trust each other.', { name: who, what: android ? t('phone') : t('PC') }),
    );
    if (ok !== undefined) {
      setAddr('');
      setName('');
    }
  };

  const recent = state.transfers.filter((x) => x.direction === 'out').slice(0, 5);
  const pick = (kind: 'file' | 'dir') =>
    void run(async () => {
      if (window.meshdrop.pickItems) return add(await window.meshdrop.pickItems(kind));
      if (kind === 'file') return add((await window.meshdrop.pickFiles()).map((path) => ({ kind: 'file' as const, path })));
      const p = await window.meshdrop.pickFolder();
      if (p) add([{ kind: 'dir', path: p }]);
    });

  return (
    <section className={compact ? 'send compact' : 'send'}>
      {!compact && <HubBanner state={state} />}
      <div className="send-card">
      <div className="row space card-head">
        <h2>
          <Icon d="M4 12l16-8-6 16-2-7-8-1z" />
          {t('Send to')}
          <span className="wide-only">{t('Devices')}</span>
        </h2>
        {trusted.length > 1 && (
          <label className="toggle">
            <input type="checkbox" checked={all} onChange={() => setAll(!all)} /> <span className="wide-only">{t('Select')} </span>{t('All')}
          </label>
        )}
      </div>
      {trusted.length === 0 ? (
        <p className="muted">{t('No devices yet.')} {compact ? t('Add one on the Send page.') : t('Add one below.')}</p>
      ) : (
        <div className="cards">
          {trusted.map((d) => (
            <DeviceCard key={d.deviceId} d={d} status={state.deviceStatus?.[d.deviceId]} checked={all ? d.reach !== 'offline' : selected.has(d.deviceId)} disabled={all} onToggle={() => toggle(d.deviceId)} />
          ))}
        </div>
      )}

      {!android && <DropZone onItems={add} />}
      <div className="actions">
        {/* The By Type chooser (Android) has its own Files tab and Browse…, so it takes Add Files' place. */}
        {window.meshdrop.chooseItems ? (
          <button className="act" onClick={() => void run(async () => add(await window.meshdrop.chooseItems!()))}>
            <Icon d="M12 3l2.5 4.5L19 9l-3.5 3.5.8 5L12 15l-4.3 2.5.8-5L5 9l4.5-1.5z" />
            <span>{t('By Type')}</span>
          </button>
        ) : (
          <button className="act" onClick={() => pick('file')}>
            <Icon d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 10v6M9 13h6" />
            <span>{t('Add Files')}</span>
          </button>
        )}
        <button className="act" onClick={() => pick('dir')}>
          <Icon d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 12h4M17 10v4" />
          <span>{t('Add Folder')}</span>
        </button>
        <button className="act" onClick={() => setText(text === null ? '' : null)} aria-pressed={text !== null}>
          <Icon d="M5 5h14M12 5v14M9 19h6" />
          <span>{t('Text')}</span>
        </button>
        <button className="act" onClick={() => void run(() => window.meshdrop.sendClipboard(all ? 'all' : targets), t('Clipboard sent'))} disabled={targets.length === 0}>
          <Icon d="M9 4h6v3H9zM7 6H5v14h14V6h-2" />
          <span>{t('Clipboard')}</span>
        </button>
        <VoiceNote run={run} onDone={(path) => add([{ kind: 'file', path }])} />
        {window.meshdrop.scanDocument && (
          <button
            className="act"
            onClick={() =>
              void run(async () => {
                const it = await window.meshdrop.scanDocument!();
                if (it) add([it]);
              })
            }
          >
            <Icon d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />
            <span>{t('Scan to PDF')}</span>
          </button>
        )}
      </div>
      <button className="link options-toggle" aria-expanded={showOpts} onClick={() => setShowOpts(!showOpts)}>
        <span className="chev" aria-hidden="true">›</span> {t('Options')}
        {burn || print || later ? ` ${t('(on)')}` : ''}
      </button>
      {showOpts && (
        <div className="send-options">
          <label className="toggle">
            <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} /> 🔥 {t('Burn after reading (deleted 5 minutes after it is opened)')}
          </label>
          <label className="toggle">
            <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> 🖨 {t('Print on the PC')}
          </label>
          <label className="row">
            ⏰ {t('Send later')}
            <input aria-label={t('Send at')} type="datetime-local" value={later} onChange={(e) => setLater(e.target.value)} />
            {later && (
              <button className="link" onClick={() => setLater('')}>
                {t('now')}
              </button>
            )}
          </label>
        </div>
      )}
      {text !== null && <textarea aria-label={t('Text to send')} value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={t('Type a message or paste a link')} />}
      {items.length > 0 && (
        <ul
          className="items"
          title={t('Flick up to send')}
          onPointerDown={(e) => (flick.current = { y: e.clientY, t: Date.now() })}
          onPointerUp={(e) => {
            // M11: a quick flick up on the list sends it (like throwing it to the device)
            const f = flick.current;
            flick.current = null;
            if (f && f.y - e.clientY > 100 && Date.now() - f.t < 400 && canSend) void send();
          }}
        >
          {items.map((it) => (
            <li key={`${it.kind}:${it.path}`}>
              <span className="muted">{it.kind === 'dir' ? t('Folder') : t('File')}</span> {it.name ?? baseName(it.path ?? '')}
              <button className="link" aria-label={t('Remove {name}', { name: it.name ?? baseName(it.path ?? '') })} onClick={() => setItems(items.filter((x) => x !== it))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="primary big send-btn" disabled={!canSend} onClick={() => void send()}>
        <Icon d="M4 12l16-8-6 16-2-7-8-1zM12 13l8-9" />
        <span>{t('Send')}</span>
      </button>
      {text !== null && /^https?:\/\/\S+$/i.test(text.trim()) && targets.length > 0 && (
        <button
          onClick={() =>
            void run(async () => {
              for (const id of all ? trusted.filter((d) => d.reach !== 'offline').map((d) => d.deviceId) : targets) {
                const r = await window.meshdrop.appSend(id, { kind: 'open-url', url: text.trim() });
                if (r.status !== 200) throw new Error(r.status === 403 ? t('That device does not open links from other devices (its Settings).') : t('The device could not open the link.'));
              }
              setText(null);
            }, t('Opened on the device'))
          }
        >
          {t('Open link on device')}
        </button>
      )}
      {targets.length === 0 && trusted.length > 0 && <p className="muted hint">{t('Pick a device above. An offline one gets it when it is back.')}</p>}
      </div>
      {!compact && (
      <>

      {(state.scheduled ?? []).length > 0 && (
        <>
          <h2>{t('Scheduled')}</h2>
          <ul className="list">
            {(state.scheduled ?? []).map((j) => (
              <li key={j.id} className="row space">
                <span>
                  ⏰ {new Date(j.at).toLocaleString()} → {j.aliases.join(', ')} <span className="muted">· {j.names.join(', ')}</span>
                </span>
                <button onClick={() => void run(() => window.meshdrop.scheduleCancel(j.id), t('Cancelled'))}>{t('Cancel')}</button>
              </li>
            ))}
          </ul>
          {state.platform === 'android' && <p className="muted hint">{t('Keep MeshDrop running: scheduled sends go out from this device.')}</p>}
        </>
      )}

      {recent.length > 0 && (
        <>
          <h2>{t('Sent')}</h2>
          {recent.map((x) => (
            <ProgressRow key={x.key} t={x} />
          ))}
        </>
      )}

      <details className="add-device" open={adding} onToggle={(e) => setAdding((e.target as HTMLDetailsElement).open)}>
        <summary>{t('Add a device')}</summary>
        <OneQr state={state} run={run} />
        <p className="muted">{t('Open MeshDrop on the other device too. Press Pair on both: each side must trust the other.')}</p>
        {nearby.length === 0 ? (
          <p className="muted">{t('No other MeshDrop devices seen on this network yet.')}</p>
        ) : (
          <div className="cards">
            {nearby.map((d) => (
              <DeviceCard
                key={d.deviceId}
                d={d}
                checked={false}
                {...(d.host && d.port
                  ? {
                      onPair: () => void startPair(d.host!, d.port!, d.alias),
                    }
                  : {})}
              />
            ))}
          </div>
        )}
        <div className="row">
          <button onClick={() => void run(async () => t('{n} new device(s) found', { n: await window.meshdrop.scanSubnet() }))}>{t('Scan network')}</button>
        </div>
        <p className="muted">
          {t('Not found? Type its address.')}
          {state.self.addrs?.[0] && (
            <>
              {' '}
              {t('This {what} is', { what: android ? t('phone') : t('PC') })} <code>{`${state.self.addrs[0]}:${state.self.port}`}</code>
            </>
          )}
        </p>
        <div className="row">
          <input aria-label={t('Address')} placeholder="192.168.1.20:53318" value={addr} onChange={(e) => setAddr(e.target.value)} />
          <input aria-label={t('Name')} placeholder={t('Name (optional)')} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          <button onClick={() => void addByAddress()} disabled={addr.trim() === ''}>
            {t('Add by address')}
          </button>
        </div>
      </details>
      </>
      )}
      {pairing && (
        <div className="modal-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="pair-title" className="modal">
            <h2 id="pair-title">{t('Pair with {name}?', { name: pairing.name || pairing.alias })}</h2>
            <p className="pair-code" aria-label={t('Pairing code')}>{pairing.code}</p>
            <p className="muted">
              {t('Press Pair for this {what} on {name} too. Pair only if it shows the same code. A different code means another device is in between.', {
                what: android ? t('phone') : t('PC'),
                name: pairing.name || pairing.alias,
              })}
            </p>
            <div className="row">
              <button className="primary" onClick={() => void confirmPair()}>
                {t('Same code, pair')}
              </button>
              <button onClick={() => setPairing(null)}>{t('Cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
