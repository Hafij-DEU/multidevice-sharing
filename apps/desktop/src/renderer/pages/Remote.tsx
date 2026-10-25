import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { AppState, DeviceView, RemoteEvent } from '../../shared/api.ts';
import type { Run } from '../App.tsx';
import { Peer } from '../components/Peer.tsx';
import { fmtBytes } from '../format.ts';

const SPEED = 1.6;
const TAP_MS = 220;
const TAP_SLOP = 8;

const ERRORS: Record<string, string> = {
  'remote-off': 'That PC does not allow this device yet: on the PC, open More → Remote and tick this device under "Devices that may control this PC".',
  'input-unavailable': 'The PC cannot take input right now.',
};

/** What an app message answered, as an error to show (undefined: it worked). */
function problem(r: { status: number; body: unknown } | undefined): string | undefined {
  if (!r) return undefined;
  if (r.status === 200) return undefined;
  const b = (r.body ?? {}) as { error?: string; reason?: string };
  if (b.reason) return b.reason;
  return (b.error && ERRORS[b.error]) || `The device said no (${b.error ?? r.status}).`;
}

/**
 * Sends input events to one device, one request at a time: while a request is out, moves and scrolls
 * add up, so a slow link never builds a queue.
 */
function useSender(target: string | null, onError: (e: string) => void) {
  const queue = useRef<RemoteEvent[]>([]);
  const busy = useRef(false);
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

/** One finger moves and taps (left click); two fingers scroll, a two-finger tap is a right click. */
function Touchpad({ send }: { send: (e: RemoteEvent) => void }) {
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
    else send({ t: 'move', dx: dx * SPEED, dy: dy * SPEED });
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size > 0) return;
    const s = start.current;
    if (Date.now() - s.t < TAP_MS && s.moved < TAP_SLOP) send({ t: 'click', b: s.max >= 2 ? 'right' : 'left' });
  };
  return (
    <div className="touchpad" aria-label="Touchpad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <span className="muted">Move with one finger · tap to click · two fingers to scroll, tap for right click</span>
    </div>
  );
}

/** Typing goes to the device as it is typed; deleting sends Backspace. */
function Keyboard({ send }: { send: (e: RemoteEvent) => void }) {
  const [v, setV] = useState('');
  const key = (k: string, mods?: string[]) => send(mods ? { t: 'key', k, mods } : { t: 'key', k });
  const KEYS: [string, string, string[]?][] = [['Esc', 'Escape'], ['Tab', 'Tab'], ['⌫', 'BackSpace'], ['↵', 'Return'], ['←', 'Left'], ['↑', 'Up'], ['↓', 'Down'], ['→', 'Right'], ['Super', 'Super'], ['Copy', 'c', ['Control']], ['Paste', 'v', ['Control']]];
  return (
    <div>
      <input
        aria-label="Type on the device"
        placeholder="Type here: it appears on the device"
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
          <button key={label} onClick={() => key(k, mods)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Media({ send }: { send: (e: RemoteEvent) => void }) {
  const B: [string, string][] = [['⏮', 'AudioPrev'], ['⏯', 'AudioPlay'], ['⏭', 'AudioNext'], ['🔉', 'AudioLowerVolume'], ['🔇', 'AudioMute'], ['🔊', 'AudioRaiseVolume']];
  return (
    <div className="row wrap media-keys">
      {B.map(([l, k]) => (
        <button key={k} aria-label={k.replace('Audio', '')} onClick={() => send({ t: 'key', k })}>
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
          ‹ Previous
        </button>
        <button className="big primary" onClick={() => send({ t: 'key', k: 'Right' })}>
          Next ›
        </button>
      </div>
      <div className="row">
        <button onClick={() => send({ t: 'key', k: 'F5' })}>Start show</button>
        <button onClick={() => send({ t: 'key', k: 'Escape' })}>End show</button>
      </div>
      <div
        className="laserpad"
        aria-label="Laser pointer"
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
        <span className="muted">Hold here: a red dot follows your finger on the PC screen</span>
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
    }, 'Done');
  const LABEL: Record<string, string> = { lock: 'Lock', sleep: 'Sleep', shutdown: 'Shut down', restart: 'Restart' };
  return (
    <div>
      <div className="row wrap">
        {Object.entries(LABEL).map(([a, l]) => (
          <button key={a} onClick={() => (a === 'shutdown' || a === 'restart' ? setConfirm(a) : void act(a))}>
            {l}
          </button>
        ))}
      </div>
      {confirm && (
        <div className="row">
          <span>{LABEL[confirm]} the PC now?</span>
          <button className="danger" onClick={() => (setConfirm(null), void act(confirm))}>
            {LABEL[confirm]}
          </button>
          <button onClick={() => setConfirm(null)}>Cancel</button>
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
          Open an app…
        </button>
      ) : (
        <div>
          <input aria-label="Find an app" placeholder="Find an app" value={q} onChange={(e) => setQ(e.target.value)} />
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

const PANELS = ['Touchpad', 'Keyboard', 'Media', 'Presenter', 'PC'] as const;

/** Control another device (a PC) from this one: touchpad, keyboard, media keys, slides, PC actions. */
function Control({ state, run, targets }: { state: AppState; run: Run; targets: DeviceView[] }) {
  const [target, setTarget] = useState<string | null>(targets[0]?.deviceId ?? null);
  const [panel, setPanel] = useState<(typeof PANELS)[number]>('Touchpad');
  const lastErr = useRef(0);
  const send = useSender(target, (e) => {
    if (Date.now() - lastErr.current < 4000) return; // one toast for a burst of failed moves
    lastErr.current = Date.now();
    void run(() => Promise.reject(new Error(e)));
  });
  useEffect(() => {
    if (target && !targets.some((t) => t.deviceId === target)) setTarget(targets[0]?.deviceId ?? null);
  }, [targets, target]);
  if (targets.length === 0) return <p className="muted">No paired device is reachable now.</p>;
  return (
    <div className="remote">
      <div className="row">
        <select aria-label="Device to control" value={target ?? ''} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.alias}
            </option>
          ))}
        </select>
      </div>
      <div className="segmented" role="tablist">
        {PANELS.map((p) => (
          <button key={p} role="tab" aria-selected={panel === p} className={panel === p ? 'active' : ''} onClick={() => setPanel(p)}>
            {p}
          </button>
        ))}
      </div>
      {target && panel === 'Touchpad' && (
        <>
          <Touchpad send={send} />
          <div className="row">
            <button onClick={() => send({ t: 'click', b: 'left' })}>Left click</button>
            <button onClick={() => send({ t: 'click', b: 'right' })}>Right click</button>
          </div>
        </>
      )}
      {target && panel === 'Keyboard' && <Keyboard send={send} />}
      {target && panel === 'Media' && <Media send={send} />}
      {target && panel === 'Presenter' && <Presenter send={send} />}
      {target && panel === 'PC' && <PcActions key={target} target={target} run={run} />}
      {state.platform !== 'android' && <p className="muted">Tip: the phone app has the same page, made for fingers.</p>}
    </div>
  );
}

function Status({ s }: { s: NonNullable<AppState['deviceStatus']>[string] | undefined }) {
  if (!s) return null;
  return (
    <span className="muted">
      {s.battery && ` · 🔋 ${s.battery.level}%${s.battery.charging ? ' ⚡' : ''}`}
      {s.storage && ` · ${fmtBytes(s.storage.free)} free`}
      {s.signal && ` · 📶 ${s.signal.level}/4${s.signal.type ? ` ${s.signal.type}` : ''}`}
    </span>
  );
}

export function Remote({ state, run }: { state: AppState; run: Run }) {
  const android = state.platform === 'android';
  const trusted = state.devices.filter((d) => d.trusted && d.role !== 'localsend');
  const reachable = trusted.filter((d) => d.reach !== 'offline');
  const [replying, setReplying] = useState<{ from: string; key: string; text: string } | null>(null);
  const s = state.settings;
  const allow = (id: string, on: boolean) =>
    run(() => window.meshdrop.setSettings({ remoteFrom: on ? [...s.remoteFrom.filter((x) => x !== id), id] : s.remoteFrom.filter((x) => x !== id) }));

  return (
    <section>
      {state.ringing && (
        <div className="banner warn row space" role="alert">
          <span>Ringing: another device is looking for this one.</span>
          <button className="primary" onClick={() => void run(() => window.meshdrop.ringStop())}>
            Stop
          </button>
        </div>
      )}

      <h2>Control a device</h2>
      <Control state={state} run={run} targets={reachable.filter((d) => d.deviceType !== 'mobile')} />

      <h2>Find my device</h2>
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
              }, `Ringing ${d.alias}`)}>
                Ring
              </button>
              <button disabled={d.reach === 'offline'} onClick={() => void run(() => window.meshdrop.appSend(d.deviceId, { kind: 'ring', on: false }))}>
                Stop
              </button>
            </span>
          </li>
        ))}
      </ul>

      {!android && (state.phoneNotes ?? []).length > 0 && (
        <>
          <div className="row space">
            <h2>Phone notifications</h2>
            <button className="link" onClick={() => void run(() => window.meshdrop.noteDismiss())}>
              Clear all
            </button>
          </div>
          <ul className="list notes">
            {(state.phoneNotes ?? []).map((n) => (
              <li key={`${n.from}:${n.key}`}>
                <div className="row space">
                  <span>
                    <strong>{n.title}</strong> <span className="muted">· {n.app} · {n.fromAlias ?? 'phone'}</span>
                  </span>
                  <span className="row">
                    {n.replyable && <button onClick={() => setReplying({ from: n.from, key: n.key, text: '' })}>Reply</button>}
                    <button className="link" aria-label="Dismiss" onClick={() => void run(() => window.meshdrop.noteDismiss(n.key))}>
                      ×
                    </button>
                  </span>
                </div>
                <div>{n.text}</div>
                {replying?.key === n.key && replying.from === n.from && (
                  <div className="row">
                    <input aria-label="Reply" className="grow" autoFocus value={replying.text} onChange={(e) => setReplying({ ...replying, text: e.target.value })} />
                    <button
                      className="primary"
                      disabled={replying.text.trim() === ''}
                      onClick={() =>
                        void run(async () => {
                          const err = problem(await window.meshdrop.appSend(n.from, { kind: 'reply', key: n.key, text: replying.text }));
                          if (err) throw new Error(err === 'The device said no (gone).' ? 'That notification is gone on the phone.' : err);
                          setReplying(null);
                        }, 'Sent')
                      }
                    >
                      Send
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
          <h2>Devices that may control this PC</h2>
          <p className="muted">They can move the pointer, type, press media keys, lock, sleep or shut down this PC, and open apps. The first time, GNOME asks you to allow remote interaction.</p>
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
            <input type="checkbox" checked={s.phoneNotifications} onChange={(e) => void run(() => window.meshdrop.setSettings({ phoneNotifications: e.target.checked }))} /> Show notifications from my phones
          </label>
          <label className="toggle">
            <input type="checkbox" checked={s.openLinks} onChange={(e) => void run(() => window.meshdrop.setSettings({ openLinks: e.target.checked }))} /> Open links my devices send with "Open on device"
          </label>
        </>
      )}
      {android && <AndroidExtras state={state} run={run} trusted={trusted} />}
    </section>
  );
}

/** Phone only: forward notifications to PCs; launch Extendo for a second screen. */
function AndroidExtras({ state, run, trusted }: { state: AppState; run: Run; trusted: DeviceView[] }) {
  const to = state.settings.notifyTo ?? [];
  const pcs = trusted.filter((d) => d.deviceType !== 'mobile');
  return (
    <>
      <h2>Show this phone's notifications on</h2>
      <p className="muted">Your PCs show them and can reply to messages (SMS, chats). Android asks once for notification access.</p>
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
          Allow notification access
        </button>
      )}
      <h2>Second screen</h2>
      <p className="muted">Use this phone or tablet as a second monitor for the PC with Extendo.</p>
      <button onClick={() => void run(() => window.meshdrop.keepAliveAction!('extendo'))}>Open Extendo</button>
    </>
  );
}
