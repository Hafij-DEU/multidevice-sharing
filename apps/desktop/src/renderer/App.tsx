import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/api.ts';
import { Toasts, type ToastItem } from './components/Toast.tsx';
import { errorText } from './format.ts';
import { GuestOffer } from './components/GuestOffer.tsx';
import { Devices } from './pages/Devices.tsx';
import { Guests } from './pages/Guests.tsx';
import { Home } from './pages/Home.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Mesh } from './pages/Mesh.tsx';
import { PairedDevices } from './pages/PairedDevices.tsx';
import { Remote } from './pages/Remote.tsx';
import { Settings } from './pages/Settings.tsx';
import { Sync } from './pages/Sync.tsx';
import { Transfers } from './pages/Transfers.tsx';

/** Home (every feature one tap away), Send, Received; the rarer pages live under More. */
const TABS = ['Home', 'Send', 'Received', 'More'] as const;
type Tab = (typeof TABS)[number];
const TAB_ICON: Record<Tab, string> = {
  Home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  Send: 'M4 12l16-8-6 16-2-7-8-1z',
  Received: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  More: 'M5 12h.01M12 12h.01M19 12h.01',
};
const MORE = ['Remote', 'Devices', 'Sync', 'Guests', 'Mesh', 'Transfers', 'Settings'] as const;
type Sub = (typeof MORE)[number];
const ICON: Record<Sub, string> = {
  Remote: 'M7 3h10v18H7zM12 17h.01M10 7h4M9 11h6',
  Sync: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4',
  Devices: 'M4 5h10v14H4zM16 9h4v10h-4M8 16h2',
  Guests: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  Mesh: 'M5 12a2 2 0 1 0 0 .01M19 5a2 2 0 1 0 0 .01M19 19a2 2 0 1 0 0 .01M7 11l10-5M7 13l10 5',
  Transfers: 'M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4',
  Settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
};
const MORE_HINT: Record<Sub, string> = {
  Remote: 'Touchpad, keyboard, slides and media for your PC; find a device; notifications',
  Devices: 'Paired devices: unpair, or pair again',
  Sync: 'Keep one folder the same on your devices; phone photo backup',
  Guests: 'Let someone without the app send or get files from a browser',
  Mesh: 'Link your devices so they reach each other from anywhere',
  Transfers: 'Unfinished sends and transfer history',
  Settings: 'Name, port, notifications',
};

/** Runs an action; shows its error (or `ok`, or a string it returns) as a toast. Resolves undefined on error. */
export type Run = <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;

export function App() {
  const [tab, setTab] = useState<Tab>('Home');
  const [sub, setSub] = useState<Sub | null>(null);
  const open = (t: Tab, s: Sub | null = null) => {
    setTab(t);
    setSub(s);
  };
  const [state, setState] = useState<AppState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((text: string, kind: ToastItem['kind']) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3000);
  }, []);

  const run: Run = useCallback(
    async (fn, ok) => {
      try {
        const r = await fn();
        if (typeof r === 'string') toast(r, 'info');
        else if (ok) toast(ok, 'info');
        return r;
      } catch (x) {
        toast(errorText(x), 'error');
        return undefined;
      }
    },
    [toast],
  );

  // Android: show the keep-alive checklist once, on first run, while a step is still open.
  useEffect(() => {
    if (state?.platform !== 'android' || !state.keepAlive?.steps.some((s) => !s.done)) return;
    try {
      if (localStorage.getItem('md.keepAliveShown')) return;
      localStorage.setItem('md.keepAliveShown', '1');
    } catch {
      return;
    }
    open('More', 'Settings');
  }, [state?.platform, state?.keepAlive]);

  // Android back button: the page steps back first (a More page → More, another tab → Home); only
  // on Home itself does the app go to the background (MainActivity asks window.__mdBack).
  const nav = useRef({ tab, sub });
  nav.current = { tab, sub };
  useEffect(() => {
    const w = window as unknown as { __mdBack?: () => boolean };
    w.__mdBack = () => {
      const { tab: t, sub: s } = nav.current;
      if (s !== null) {
        setSub(null);
        return true;
      }
      if (t !== 'Home') {
        open('Home');
        return true;
      }
      return false;
    };
    return () => {
      delete w.__mdBack;
    };
  }, []);

  // Files shared into MeshDrop (Android share menu, Files → Send with MeshDrop): show the Send page.
  useEffect(() => {
    if ((state?.sharedPending ?? 0) > 0) open('Send');
  }, [state?.sharedPending]);

  // Android: an invite link opened the app: show the Mesh page with it in the join box.
  useEffect(() => {
    if (state?.joinLink) open('More', 'Mesh');
  }, [state?.joinLink]);

  useEffect(() => {
    const off = window.meshdrop.onState(setState);
    const poll = () =>
      void window.meshdrop.getState().then(setState, () => {
        setTimeout(poll, 300); // the controller is still starting
      });
    poll();
    return off;
  }, []);

  const subs = MORE.filter((p) => !(p === 'Guests' && !state?.guest) && !(p === 'Sync' && !state?.sync));
  const status = !state
    ? ''
    : state.mode === 'client-only'
      ? 'Receiving is handled by the MeshDrop background service'
      : state.error
        ? 'Not receiving'
        : state.receiving
          ? `Receiving as ${state.self.alias}`
          : 'Receiving paused';

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">MeshDrop</span>
        <nav className="tabs" aria-label="Pages">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => open(t)} aria-current={t === tab ? 'page' : undefined}>
              <svg className="tab-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={t === 'More' ? 3.5 : 2} strokeLinecap="round" strokeLinejoin="round">
                <path d={TAB_ICON[t]} />
              </svg>
              <span>{t}</span>
            </button>
          ))}
        </nav>
        <span className="self muted">{status}</span>
      </header>
      <main className="content">
        {state?.error && (
          <div className="banner error" role="alert">
            {state.error}
          </div>
        )}
        {!state ? (
          <p className="muted">Starting…</p>
        ) : tab === 'Home' ? (
          <Home state={state} run={run} go={(to) => ('tab' in to ? open(to.tab) : open('More', to.sub as Sub))} />
        ) : tab === 'Send' ? (
          <Devices state={state} run={run} />
        ) : tab === 'Received' ? (
          <Inbox state={state} run={run} />
        ) : sub === null ? (
          <ul className="menu">
            {subs.map((p) => (
              <li key={p}>
                <button className="menu-item" onClick={() => setSub(p)}>
                  <span className={`menu-icon icon-${p}`} aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d={ICON[p]} />
                    </svg>
                  </span>
                  <span className="menu-text">
                    <span className="menu-title">{p}</span>
                    <span className="muted">{MORE_HINT[p]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="subhead">
              <button className="link" onClick={() => setSub(null)}>
                ‹ More
              </button>
              <h1>{sub}</h1>
            </div>
            {sub === 'Remote' ? (
              <Remote state={state} run={run} />
            ) : sub === 'Devices' ? (
              <PairedDevices state={state} run={run} />
            ) : sub === 'Sync' ? (
              <Sync state={state} run={run} />
            ) : sub === 'Guests' ? (
              <Guests state={state} run={run} />
            ) : sub === 'Mesh' ? (
              <Mesh state={state} run={run} />
            ) : sub === 'Transfers' ? (
              <Transfers state={state} run={run} />
            ) : (
              <Settings key={JSON.stringify(state.settings)} state={state} run={run} />
            )}
          </>
        )}
      </main>
      {state?.guest?.offers[0] && <GuestOffer key={state.guest.offers[0].id} offer={state.guest.offers[0]} run={run} />}
      <Toasts items={toasts} onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
