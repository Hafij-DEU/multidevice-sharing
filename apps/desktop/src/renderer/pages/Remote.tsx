import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { AppState, DeviceView, RemoteEvent } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { Peer } from '../components/Peer.tsx';
import { fmtBytes } from '../format.ts';
import { mark, t } from '../i18n.ts';

const SPEED = 1.6;
const SPEED_KEY = 'md.pointerSpeed';
/** This window runs on Windows (the PC app; the phone's WebView says Android). */
const WINDOWS = /Windows NT/.test(navigator.userAgent);
const TAP_MS = 220;
const TAP_SLOP = 8;

const ERRORS: Record<string, string> = {
  'remote-off': mark('That PC does not allow this device yet: on the PC, open More → Remote and tick this device under "Devices that may control this PC".'),
  'input-unavailable': mark('The PC cannot take input right now.'),
  unsupported: mark('That PC cannot do this yet: sound, camera and microphone need MeshDrop on Linux for now.'),
  'not-playing': mark('The PC hears no Bluetooth audio from this phone now.'),
};

/** What an app message answered, as an error to show (undefined: it worked). */
function problem(r: { status: number; body: unknown } | undefined): string | undefined {
  if (!r) return undefined;
  if (r.status === 200) return undefined;
  const b = (r.body ?? {}) as { error?: string; reason?: string };
  if (b.reason) return b.reason;
  return (b.error && ERRORS[b.error] && t(ERRORS[b.error]!)) || t('The device said no ({code}).', { code: b.error ?? r.status });
}

/**
 * Sends input events to one device, one request at a time: while a request is out, moves and scrolls
 * add up, so a slow link never builds a queue.
 */
function useSender(target: string | null, onError: (e: string) => void) {
  const queue = useRef<RemoteEvent[]>([]);
  const busy = useRef(false);
  const sentTo = useRef(target);
  if (sentTo.current !== target) {
    if (sentTo.current) queue.current = []; // input meant for one PC never lands on another
    sentTo.current = target;
  }
  const flush = async () => {
    if (busy.current || !target || queue.current.length === 0) return;
    busy.current = true;
    const events = queue.current;
    queue.current = [];
    try {
      const err = problem(await window.meshdrop.appSend(target, { kind: 'input', events }));
      if (err) onError(err);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      if (queue.current.length) void flush();
    }
  };
  return (e: RemoteEvent) => {
    const last = queue.current[queue.current.length - 1];
    if (e.t === 'move' && last?.t === 'move') {
      last.dx += e.dx;
      last.dy += e.dy;
    } else if (e.t === 'scroll' && last?.t === 'scroll') {
      last.dx += e.dx;
      last.dy += e.dy;
    } else if (e.t === 'laser' && last?.t === 'laser') {
      queue.current[queue.current.length - 1] = e;
    } else queue.current.push(e);
    void flush();
  };
}

/** The touchpad's pointer speed, kept per device. */
function savedSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return v >= 0.5 && v <= 5 ? v : SPEED;
  } catch {
    return SPEED;
  }
}

/** One finger moves and taps (left click); two fingers scroll, a two-finger tap is a right click. */
function Touchpad({ send, speed }: { send: (e: RemoteEvent) => void; speed: number }) {
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef({ t: 0, moved: 0, max: 0 });
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pts.current.size === 0) start.current = { t: Date.now(), moved: 0, max: 0 };
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start.current.max = Math.max(start.current.max, pts.current.size);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const p = pts.current.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    start.current.moved += Math.abs(dx) + Math.abs(dy);
    if (pts.current.size >= 2) send({ t: 'scroll', dx: dx / 4, dy: -dy / 4 });
    else send({ t: 'move', dx: dx * speed, dy: dy * speed });
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size > 0) return;
    const s = start.current;
    if (Date.now() - s.t < TAP_MS && s.moved < TAP_SLOP) send({ t: 'click', b: s.max >= 2 ? 'right' : 'left' });
  };
  return (
    <div className="touchpad" aria-label={t('Touchpad')} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <span className="muted">{t('Move with one finger · tap to click · two fingers to scroll, tap for right click')}</span>
    </div>
  );
}

/** Typing goes to the device as it is typed; deleting sends Backspace. */
function Keyboard({ send }: { send: (e: RemoteEvent) => void }) {
  const [v, setV] = useState('');
  const key = (k: string, mods?: string[]) => send(mods ? { t: 'key', k, mods } : { t: 'key', k });
  const KEYS: [string, string, string[]?][] = [[mark('Esc'), 'Escape'], [mark('Tab'), 'Tab'], ['⌫', 'BackSpace'], ['↵', 'Return'], ['←', 'Left'], ['↑', 'Up'], ['↓', 'Down'], ['→', 'Right'], [mark('Super'), 'Super'], [mark('Copy'), 'c', ['Control']], [mark('Paste'), 'v', ['Control']]];
  return (
    <div>
      <input
        aria-label={t('Type on the device')}
        placeholder={t('Type here: it appears on the device')}
        value={v}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => {
          const n = e.target.value;
          if (n.startsWith(v)) send({ t: 'text', s: n.slice(v.length) });
          else if (v.startsWith(n)) for (let i = 0; i < v.length - n.length; i++) key('BackSpace');
          else send({ t: 'text', s: n });
          setV(n.length > 200 ? '' : n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') key('Return');
          else if (e.key === 'Backspace' && v === '') key('BackSpace');
        }}
      />
      <div className="row wrap">
        {KEYS.map(([label, k, mods]) => (
          <button key={k + label} onClick={() => key(k, mods)}>
            {t(label)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Media({ send }: { send: (e: RemoteEvent) => void }) {
  const B: [string, string, string][] = [['⏮', 'AudioPrev', mark('Prev')], ['⏯', 'AudioPlay', mark('Play')], ['⏭', 'AudioNext', mark('Next')], ['🔉', 'AudioLowerVolume', mark('Volume down')], ['🔇', 'AudioMute', mark('Mute')], ['🔊', 'AudioRaiseVolume', mark('Volume up')]];
  return (
    <div className="row wrap media-keys">
      {B.map(([l, k, name]) => (
        <button key={k} aria-label={t(name)} onClick={() => send({ t: 'key', k })}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Next/previous slide, start/end the show, and a laser dot that follows the finger. */
function Presenter({ send }: { send: (e: RemoteEvent) => void }) {
  const at = (e: RPointerEvent<HTMLDivElement>, on: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    send({ t: 'laser', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, on });
  };
  const [held, setHeld] = useState(false);
  return (
    <div>
      <div className="row presenter">
        <button className="big" onClick={() => send({ t: 'key', k: 'Left' })}>
          {t('‹ Previous')}
        </button>
        <button className="big primary" onClick={() => send({ t: 'key', k: 'Right' })}>
          {t('Next ›')}
        </button>
      </div>
      <div className="row">
        <button onClick={() => send({ t: 'key', k: 'F5' })}>{t('Start show')}</button>
        <button onClick={() => send({ t: 'key', k: 'Escape' })}>{t('End show')}</button>
      </div>
      <div
        className="laserpad"
        aria-label={t('Laser pointer')}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setHeld(true);
          at(e, true);
        }}
        onPointerMove={(e) => held && at(e, true)}
        onPointerUp={(e) => {
          setHeld(false);
          at(e, false);
        }}
      >
        <span className="muted">{t('Hold here: a red dot follows your finger on the PC screen')}</span>
      </div>
    </div>
  );
}

function PcActions({ target, run }: { target: string; run: Run }) {
  const [apps, setApps] = useState<{ id: string; name: string }[] | null>(null);
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const act = (a: string, app?: string) =>
    run(async () => {
      const err = problem(await window.meshdrop.appSend(target, { kind: 'action', a, ...(app ? { app } : {}) }));
      if (err) throw new Error(err);
    }, t('Done'));
  const LABEL: Record<string, string> = { lock: mark('Lock'), sleep: mark('Sleep'), shutdown: mark('Shut down'), restart: mark('Restart') };
  return (
    <div>
      <div className="row wrap">
        {Object.entries(LABEL).map(([a, l]) => (
          <button key={a} onClick={() => (a === 'shutdown' || a === 'restart' ? setConfirm(a) : void act(a))}>
            {t(l)}
          </button>
        ))}
      </div>
      {confirm && (
        <div className="row">
          <span>{t('{action} the PC now?', { action: t(LABEL[confirm]!) })}</span>
          <button className="danger" onClick={() => (setConfirm(null), void act(confirm))}>
            {t(LABEL[confirm]!)}
          </button>
          <button onClick={() => setConfirm(null)}>{t('Cancel')}</button>
        </div>
      )}
      {apps === null ? (
        <button
          onClick={() =>
            void run(async () => {
              const r = await window.meshdrop.appSend(target, { kind: 'apps' });
              const err = problem(r);
              if (err) throw new Error(err);
              setApps((r.body as { apps: { id: string; name: string }[] }).apps);
            })
          }
        >
          {t('Open an app…')}
        </button>
      ) : (
        <div>
          <input aria-label={t('Find an app')} placeholder={t('Find an app')} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="list apps">
            {apps
              .filter((a) => a.name.toLowerCase().includes(q.toLowerCase()))
              .slice(0, 30)
              .map((a) => (
                <li key={a.id}>
                  <button className="link" onClick={() => void act('open', a.id)}>
                    {a.name}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Sends this device's sound to another one, where it plays (a toggle). */
function SoundTo({ state, run, to, label }: { state: AppState; run: Run; to: string; label: string }) {
  // a phone asked to play it takes this PC's sound itself ("audio")
  const out = (state.streams ?? []).find((s) => (s.kind === 'sound-out' || s.kind === 'audio') && s.peer === to);
  const on = state.platform === 'android' ? state.casting?.soundTo === to : !!out;
  return (
    <button
      aria-pressed={on}
      onClick={() => void run(() => (on ? window.meshdrop.streamStop(out?.id ?? 'sound') : window.meshdrop.streamStart!(to, 'sound')), on ? t('Sound stopped') : t('Sound playing there'))}
    >
      {on ? t('Stop sound there') : label}
    </button>
  );
}

const CAMERA_NEEDS_WIFI = mark('Camera needs Wi-Fi or a hotspot - this device is connected over Bluetooth.');

const PANELS = ['Touchpad', 'Keyboard', 'Media', 'Presenter', 'PC'] as const;
const PANEL_NAME: Record<(typeof PANELS)[number], string> = {
  Touchpad: mark('Touchpad'),
  Keyboard: mark('Keyboard'),
  Media: mark('Media'),
  Presenter: mark('Presenter'),
  PC: mark('PC'),
};

/** Control another device (a PC) from this one: touchpad, keyboard, media keys, slides, PC actions. */
function Control({ state, run, targets }: { state: AppState; run: Run; targets: DeviceView[] }) {
  // Every paired PC stays listed (a device that is away for a moment keeps its place): picking
  // only reachable ones dropped the chosen PC whenever it blinked offline, and input went nowhere.
  const pick = () => (targets.find((d) => d.reach !== 'offline') ?? targets[0])?.deviceId ?? null;
  const [target, setTarget] = useState<string | null>(pick);
  const [panel, setPanel] = useState<(typeof PANELS)[number]>('Touchpad');
  const [speed, setSpeed] = useState(savedSpeed);
  const changeSpeed = (v: number) => {
    setSpeed(v);
    try {
      localStorage.setItem(SPEED_KEY, String(v));
    } catch {
      // no storage: the speed lasts until the page closes
    }
  };
  const lastErr = useRef(0);
  const send = useSender(target, (e) => {
    if (Date.now() - lastErr.current < 4000) return; // one toast for a burst of failed moves
    lastErr.current = Date.now();
    void run(() => Promise.reject(new Error(e)));
  });
  useEffect(() => {
    if (!target || !targets.some((d) => d.deviceId === target)) {
      const next = pick();
      if (next !== target) setTarget(next);
    }
  });
  if (targets.length === 0) return <p className="muted">{t('No paired PC yet.')}</p>;
  const away = targets.find((d) => d.deviceId === target)?.reach === 'offline';
  return (
    <div className="remote">
      <div className="row">
        <select aria-label={t('Device to control')} value={target ?? ''} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.alias}
              {d.reach === 'offline' ? t(' (away)') : ''}
            </option>
          ))}
        </select>
        {target && state.platform !== 'android' && <SoundTo state={state} run={run} to={target} label={t("Play this PC's sound there")} />}
      </div>
      {away && <p className="muted">{t('This PC is away right now: clicks and keys reach it again once it is back.')}</p>}
      <div className="segmented" role="tablist">
        {PANELS.map((p) => (
          <button key={p} role="tab" aria-selected={panel === p} className={panel === p ? 'active' : ''} onClick={() => setPanel(p)}>
            {t(PANEL_NAME[p])}
          </button>
        ))}
      </div>
      {target && panel === 'Touchpad' && (
        <>
          <Touchpad send={send} speed={speed} />
          <label className="row">
            {t('Pointer speed')}
            <input type="range" aria-label={t('Pointer speed')} min={0.5} max={5} step={0.1} value={speed} onChange={(e) => changeSpeed(Number(e.target.value))} />
            <span className="muted">{speed.toFixed(1)}×</span>
          </label>
          <div className="row">
            <button onClick={() => send({ t: 'click', b: 'left' })}>{t('Left click')}</button>
            <button onClick={() => send({ t: 'click', b: 'right' })}>{t('Right click')}</button>
          </div>
        </>
      )}
      {target && panel === 'Keyboard' && <Keyboard send={send} />}
      {target && panel === 'Media' && <Media send={send} />}
      {target && panel === 'Presenter' && <Presenter send={send} />}
      {target && panel === 'PC' && <PcActions key={target} target={target} run={run} />}
      {state.platform !== 'android' && <p className="muted">{t('Tip: the phone app has the same page, made for fingers.')}</p>}
    </div>
  );
}

function Status({ s }: { s: NonNullable<AppState['deviceStatus']>[string] | undefined }) {
  if (!s) return null;
  return (
    <span className="muted">
      {s.battery && ` · 🔋 ${s.battery.level}%${s.battery.charging ? ' ⚡' : ''}`}
      {s.storage && t(' · {size} free', { size: fmtBytes(s.storage.free) })}
      {s.signal && ` · 📶 ${s.signal.level}/4${s.signal.type ? ` ${s.signal.type}` : ''}`}
    </span>
  );
}

export function Remote({ state, run }: { state: AppState; run: Run }) {
  const android = state.platform === 'android';
  const trusted = state.devices.filter((d) => d.trusted && d.role !== 'localsend');
  const [replying, setReplying] = useState<{ from: string; key: string; text: string } | null>(null);
  const s = state.settings;
  const allow = (id: string, on: boolean) =>
    run(() => window.meshdrop.setSettings({ remoteFrom: on ? [...s.remoteFrom.filter((x) => x !== id), id] : s.remoteFrom.filter((x) => x !== id) }));

  return (
    <section>
      {state.ringing && (
        <div className="banner warn row space" role="alert">
          <span>{t('Ringing: another device is looking for this one.')}</span>
          <button className="primary" onClick={() => void run(() => window.meshdrop.ringStop())}>
            {t('Stop')}
          </button>
        </div>
      )}

      {!android && (state.streams ?? []).length > 0 && (
        <>
          <h2>{t('Live now')}</h2>
          {state.btScanning && (
            <div className="banner warn" role="alert">
              {t('This PC is searching for Bluetooth devices, so sound over Bluetooth breaks up. Close the Bluetooth settings window on this PC (the search stops with it).')}
            </div>
          )}
          <ul className="list">
            {(state.streams ?? []).map((st) => (
              <li key={st.id} className="row space">
                <span>
                  {st.kind === 'audio' || st.kind === 'sound-out' ? t("This PC's sound plays on ") : st.kind === 'sound' || st.kind === 'bt-audio' ? t('Playing the sound of ') : st.kind === 'camera' ? t('Camera of ') : t('Microphone of ')}
                  <Peer text={st.alias ?? t('a device')} />
                  {st.kind === 'bt-audio' && <span className="muted"> {t('· Bluetooth audio, like earbuds')}</span>}
                  {st.kind === 'camera' && <span className="muted"> {t('· pick "{name} camera (MeshDrop)" in your video app', { name: st.alias ?? '' })}</span>}
                  {st.kind === 'mic' && <span className="muted"> {t('· pick "{name} microphone (MeshDrop)" as input', { name: st.alias ?? '' })}</span>}
                </span>
                <button onClick={() => void run(() => window.meshdrop.streamStop(st.id))}>{t('Stop')}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {android && <QuickMedia state={state} run={run} pcs={trusted.filter((d) => d.deviceType !== 'mobile')} />}

      <h2>{t('Control a device')}</h2>
      <Control state={state} run={run} targets={trusted.filter((d) => d.deviceType !== 'mobile')} />

      <h2>{t('Find my device')}</h2>
      <ul className="list">
        {trusted.map((d) => (
          <li key={d.deviceId} className="row space">
            <span>
              <Peer text={d.alias} />
              <Status s={state.deviceStatus?.[d.deviceId]} />
            </span>
            <span className="row">
              <button disabled={d.reach === 'offline'} onClick={() => void run(async () => {
                const err = problem(await window.meshdrop.appSend(d.deviceId, { kind: 'ring' }));
                if (err) throw new Error(err);
              }, t('Ringing {name}', { name: d.alias }))}>
                {t('Ring')}
              </button>
              <button disabled={d.reach === 'offline'} onClick={() => void run(() => window.meshdrop.appSend(d.deviceId, { kind: 'ring', on: false }))}>
                {t('Stop')}
              </button>
            </span>
          </li>
        ))}
      </ul>

      {!android && (state.phoneNotes ?? []).length > 0 && (
        <>
          <div className="row space">
            <h2>{t('Phone notifications')}</h2>
            <button className="link" onClick={() => void run(() => window.meshdrop.noteDismiss())}>
              {t('Clear all')}
            </button>
          </div>
          <ul className="list notes">
            {(state.phoneNotes ?? []).map((n) => (
              <li key={`${n.from}:${n.key}`}>
                <div className="row space">
                  <span>
                    <strong>{n.title}</strong> <span className="muted">· {n.app} · {n.fromAlias ?? t('phone')}</span>
                  </span>
                  <span className="row">
                    {n.replyable && <button onClick={() => setReplying({ from: n.from, key: n.key, text: '' })}>{t('Reply')}</button>}
                    <button className="link" aria-label={t('Dismiss')} onClick={() => void run(() => window.meshdrop.noteDismiss(n.key))}>
                      ×
                    </button>
                  </span>
                </div>
                <div>{n.text}</div>
                {replying?.key === n.key && replying.from === n.from && (
                  <div className="row">
                    <input aria-label={t('Reply')} className="grow" autoFocus value={replying.text} onChange={(e) => setReplying({ ...replying, text: e.target.value })} />
                    <button
                      className="primary"
                      disabled={replying.text.trim() === ''}
                      onClick={() =>
                        void run(async () => {
                          const err = problem(await window.meshdrop.appSend(n.from, { kind: 'reply', key: n.key, text: replying.text }));
                          if (err) throw new Error(err === t('The device said no ({code}).', { code: 'gone' }) ? t('That notification is gone on the phone.') : err);
                          setReplying(null);
                        }, t('Sent'))
                      }
                    >
                      {t('Send')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {!android && (
        <>
          <h2>{t('Devices that may control this PC')}</h2>
          <p className="muted">{t('They can move the pointer, type, press media keys, lock, sleep or shut down this PC, and open apps.')}{WINDOWS ? t(' Windows does not ask first; windows of apps run as administrator ignore it.') : t(' The first time, GNOME asks you to allow remote interaction.')}</p>
          {state.inputError && <p className="error-text">{state.inputError}</p>}
          <ul className="list">
            {trusted.map((d) => (
              <li key={d.deviceId}>
                <label className="toggle">
                  <input type="checkbox" checked={s.remoteFrom.includes(d.deviceId)} onChange={(e) => void allow(d.deviceId, e.target.checked)} /> <Peer text={d.alias} />
                </label>
              </li>
            ))}
          </ul>
          <label className="toggle">
            <input type="checkbox" checked={s.phoneNotifications} onChange={(e) => void run(() => window.meshdrop.setSettings({ phoneNotifications: e.target.checked }))} /> {t('Show notifications from my phones')}
          </label>
          <label className="toggle">
            <input type="checkbox" checked={s.openLinks} onChange={(e) => void run(() => window.meshdrop.setSettings({ openLinks: e.target.checked }))} /> {t('Open links my devices send with "Open on device"')}
          </label>
        </>
      )}
      {android && <AndroidExtras state={state} run={run} trusted={trusted} />}
    </section>
  );
}

const MEDIA_ICON = {
  audio: 'M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  camera: 'M23 7l-7 5 7 5V7zM1 5h15v14H1z',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  sound: 'M2 4h20v12H2zM8 20h8M12 16v4M9 10l2 2 4-4',
} as const;

function MediaTile({ icon, title, hint, on, disabled, why, onClick }: { icon: keyof typeof MEDIA_ICON; title: string; hint: string; on: boolean; disabled?: boolean; why?: string; onClick: () => void }) {
  return (
    <button className={`media-tile${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled} title={why} onClick={onClick}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={MEDIA_ICON[icon]} />
      </svg>
      <span className="media-tile-title">{title}</span>
      <span className="media-tile-hint">{on ? t('On · tap to stop') : hint}</span>
    </button>
  );
}

/**
 * Phone only, first on the Remote page: one-tap tiles per nearby PC for PC sound here, webcam,
 * microphone and phone sound on the PC. Rarer options (back camera, Bluetooth audio) sit under them.
 */
function QuickMedia({ state, run, pcs }: { state: AppState; run: Run; pcs: DeviceView[] }) {
  const near = pcs.filter((d) => d.reach === 'lan' || d.reach === 'bt');
  return (
    <div className="quick-media">
      <h2>{t('Sound, camera and microphone')}</h2>
      {near.length === 0 && <p className="muted">{t("No PC nearby. Join the same Wi-Fi, a hotspot or a Bluetooth link to use the phone's camera, microphone or sound.")}</p>}
      {near.map((d) => {
        const c = state.casting ?? {};
        // M14: Bluetooth carries sound (Opus) but not video
        const bt = d.reach === 'bt';
        const on = (k: 'audio' | 'camera' | 'mic') => (k === 'audio' ? c.audioFrom : k === 'camera' ? c.cameraTo : c.micTo) === d.deviceId;
        const toggle = (k: 'audio' | 'camera' | 'mic') => void run(() => (on(k) ? window.meshdrop.streamStop(k) : window.meshdrop.streamStart!(d.deviceId, k)));
        const soundOn = c.soundTo === d.deviceId;
        const a2dp = c.a2dpTo === d.deviceId;
        return (
          <div key={d.deviceId} className="quick-pc">
            <div className="quick-pc-name">
              <Peer text={bt ? t('{name} (Bluetooth)', { name: d.alias }) : d.alias} />
            </div>
            <div className="media-tiles">
              <MediaTile icon="audio" title={t('PC sound')} hint={t('Play it here')} on={on('audio')} onClick={() => toggle('audio')} />
              <MediaTile icon="camera" title={t('Webcam')} hint={t('Phone camera on the PC')} on={on('camera')} disabled={bt && !on('camera')} why={bt ? t(CAMERA_NEEDS_WIFI) : undefined} onClick={() => toggle('camera')} />
              <MediaTile icon="mic" title={t('Microphone')} hint={t('Phone mic on the PC')} on={on('mic')} onClick={() => toggle('mic')} />
              {(!a2dp || soundOn) && (
                <MediaTile
                  icon="sound"
                  title={t('Phone sound')}
                  hint={t('Play it on the PC')}
                  on={soundOn}
                  onClick={() => void run(() => (soundOn ? window.meshdrop.streamStop('sound') : window.meshdrop.streamStart!(d.deviceId, 'sound')), soundOn ? t('Sound stopped') : t('Sound playing there'))}
                />
              )}
            </div>
            <div className="row wrap quick-more">
              {on('camera') ? (
                <button onClick={() => void run(() => window.meshdrop.streamStart!(d.deviceId, 'camera', c.cameraBack ? 'front' : 'back'))}>
                  {c.cameraBack ? t('Switch to front camera') : t('Switch to back camera')}
                </button>
              ) : (
                !bt && <button onClick={() => void run(() => window.meshdrop.streamStart!(d.deviceId, 'camera', 'back'))}>{t('Webcam with the back camera')}</button>
              )}
              {a2dp ? (
                <>
                  <button className="primary" onClick={() => void run(async () => {
                    const err = problem(await window.meshdrop.appSend(d.deviceId, { kind: 'bt-audio-stop' }));
                    if (err) throw new Error(err);
                  }, t('Bluetooth audio stopped'))}>{t('Stop Bluetooth audio')}</button>
                  <button onClick={() => void run(() => window.meshdrop.keepAliveAction!('audio-output'))}>{t('Change audio output')}</button>
                </>
              ) : (
                bt && (
                  <>
                    <button onClick={() => void run(async () => {
                      // the PC connects the audio link (a phone app cannot); the phone then plays on it by itself
                      const r = await window.meshdrop.appSend(d.deviceId, { kind: 'bt-audio-start' }).catch(() => undefined);
                      if (!r || problem(r)) await window.meshdrop.keepAliveAction!('audio-output');
                    })}>{t('Phone sound as Bluetooth audio')}</button>
                    <button onClick={() => void run(() => window.meshdrop.keepAliveAction!('bluetooth-settings'))}>{t('Bluetooth settings')}</button>
                  </>
                )
              )}
            </div>
            {a2dp && <p className="muted">{t("This phone's sound plays on the PC as Bluetooth audio, like earbuds.")}</p>}
            {bt && !a2dp && <p className="muted">{t('Bluetooth: sound works, the camera needs Wi-Fi or a hotspot. Still on the phone speaker? Pick {name} as the audio output.', { name: d.alias })}</p>}
          </div>
        );
      })}
      <p className="muted hint">{t('Sound goes either way only with devices ticked on that PC ("Devices that may control this PC"). The camera and microphone show up on the PC as a webcam and a microphone for video calls.')}</p>
    </div>
  );
}

/** Phone only: forward notifications to PCs; launch Extendo for a second screen. */
function AndroidExtras({ state, run, trusted }: { state: AppState; run: Run; trusted: DeviceView[] }) {
  const to = state.settings.notifyTo ?? [];
  const pcs = trusted.filter((d) => d.deviceType !== 'mobile');
  return (
    <>
      <h2>{t("Show this phone's notifications on")}</h2>
      <p className="muted">{t('Your PCs show them and can reply to messages (SMS, chats). Android asks once for notification access.')}</p>
      <ul className="list">
        {pcs.map((d) => (
          <li key={d.deviceId}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={to.includes(d.deviceId)}
                onChange={(e) => void run(() => window.meshdrop.setSettings({ notifyTo: e.target.checked ? [...to.filter((x) => x !== d.deviceId), d.deviceId] : to.filter((x) => x !== d.deviceId) }))}
              />{' '}
              <Peer text={d.alias} />
            </label>
          </li>
        ))}
      </ul>
      {state.notifyAccess === false && to.length > 0 && (
        <button className="primary" onClick={() => void run(() => window.meshdrop.keepAliveAction!('notification-access'))}>
          {t('Allow notification access')}
        </button>
      )}
      <h2>{t('Second screen')}</h2>
      <p className="muted">{t('Use this phone or tablet as a second monitor for the PC with Extendo.')}</p>
      <button onClick={() => void run(() => window.meshdrop.keepAliveAction!('extendo'))}>{t('Open Extendo')}</button>
    </>
  );
}
