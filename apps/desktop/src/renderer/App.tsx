import { useCallback, useEffect, useRef, useState } from 'react';
import { BgArt } from './components/BgArt.tsx';
import type { AppState } from '../shared/api.ts';
import { Toasts, type ToastItem } from './components/Toast.tsx';
import { errorText } from './format.ts';
import { mark, t } from './i18n.ts';
import { GuestOffer } from './components/GuestOffer.tsx';
import { QuickPrefs } from './components/QuickPrefs.tsx';
import { Devices } from './pages/Devices.tsx';
import { Guests } from './pages/Guests.tsx';
import { Home } from './pages/Home.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Mesh } from './pages/Mesh.tsx';
import { PairedDevices } from './pages/PairedDevices.tsx';
import { Remote } from './pages/Remote.tsx';
import { WatchParty } from './pages/WatchParty.tsx';
import { Handoff } from './pages/Handoff.tsx';
import { About, Settings } from './pages/Settings.tsx';
import { Sync } from './pages/Sync.tsx';
import { Transfers } from './pages/Transfers.tsx';
import { Wifi } from './pages/Wifi.tsx';
import { QrShare } from './pages/QrShare.tsx';

/** Home (every feature one tap away), Send, Received; the rarer pages live under More. */
type Tab = 'Home' | 'Send' | 'Received' | 'More';
const MORE = ['Remote', 'Continue', 'Watch party', 'Wi-Fi', 'Share to Xiaomi', 'Devices', 'Sync', 'Guests', 'Mesh', 'Transfers', 'Settings', 'About'] as const;
type Sub = (typeof MORE)[number];
const ICON: Record<Sub, string> = {
  Remote: 'M7 3h10v18H7zM12 17h.01M10 7h4M9 11h6',
  'Watch party': 'M3 5h18v12H3zM8 21h8M10 9l5 3-5 3z',
  Continue: 'M4 6h10v12H4zM17 9h3v9h-6M14 12h6M17 9l3 3-3 3',
  'Wi-Fi': 'M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01',
  'Share to Xiaomi': 'M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4',
  Sync: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4',
  Devices: 'M4 5h10v14H4zM16 9h4v10h-4M8 16h2',
  Guests: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  Mesh: 'M5 12a2 2 0 1 0 0 .01M19 5a2 2 0 1 0 0 .01M19 19a2 2 0 1 0 0 .01M7 11l10-5M7 13l10 5',
  Transfers: 'M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4',
  Settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  About: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
};
/** The names shown for the pages (the English names above are the logic values). */
const SUB_NAME: Record<Sub, string> = {
  Remote: mark('Remote'),
  Continue: mark('Continue'),
  'Watch party': mark('Watch party'),
  'Wi-Fi': mark('Wi-Fi'),
  'Share to Xiaomi': mark('Share to Xiaomi'),
  Devices: mark('Devices'),
  Sync: mark('Sync'),
  Guests: mark('Guests'),
  Mesh: mark('Mesh'),
  Transfers: mark('Transfers'),
  Settings: mark('Settings'),
  About: mark('About'),
};
const MORE_HINT: Record<Sub, string> = {
  Remote: mark('Touchpad, keyboard, slides and media for your PC; find a device; notifications'),
  'Watch party': mark('Watch YouTube or any video together, in step: share a 6-character code'),
  Continue: mark('Carry on with a page on another device, at the same spot'),
  'Wi-Fi': mark('Save your own networks, lock to a band, add eduroam / 802.1X'),
  'Share to Xiaomi': mark('Send to and receive from Xiaomi phones (ShareMe)'),
  Devices: mark('Paired devices: unpair, or pair again'),
  Sync: mark('Keep one folder the same on your devices; phone photo backup'),
  Guests: mark('Let someone without the app send or get files from a browser'),
  Mesh: mark('Link your devices so they reach each other from anywhere'),
  Transfers: mark('Unfinished sends and transfer history'),
  Settings: mark('Name, port, notifications'),
  About: mark('Version, licence, source code'),
};
/** On a wide window these sit in the sidebar, so the More page leaves them out. */
const IN_SIDEBAR: readonly Sub[] = ['Devices', 'Transfers', 'Settings', 'About'];

/** One sidebar / bottom-bar entry; `core` ones are the four a phone shows in its bottom bar. */
interface NavItem {
  label: string;
  icon: string;
  active: boolean;
  core?: boolean;
  onOpen: () => void;
}

const WIDE = matchMedia('(min-width: 860px)');
/** True while the window is wide enough for the sidebar layout (PC); false on phones. */
function useWide(): boolean {
  const [wide, setWide] = useState(WIDE.matches);
  useEffect(() => {
    const on = () => setWide(WIDE.matches);
    WIDE.addEventListener('change', on);
    return () => WIDE.removeEventListener('change', on);
  }, []);
  return wide;
}

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** How often each page was opened on this device (Home's "Most used" row); kept in this device's storage only. */
const USAGE_KEY = 'md.usage';
function readUsage(): Record<string, number> {
  try {
    const j = JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}') as unknown;
    return j && typeof j === 'object' ? (j as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function countUse(page: string): Record<string, number> {
  const u = readUsage();
  u[page] = (u[page] ?? 0) + 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(u));
  } catch {
    /* private mode: the row just stays empty */
  }
  return u;
}
const TAB_ICON = { Send: 'M4 12l16-8-6 16-2-7-8-1z', Received: 'M12 4v11M7 10l5 5 5-5M5 20h14' } as const;

/** Runs an action; shows its error (or `ok`, or a string it returns) as a toast. Resolves undefined on error. */
export type Run = <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;

export function App() {
  const wide = useWide();
  const [tab, setTab] = useState<Tab>('Home');
  const [sub, setSub] = useState<Sub | null>(null);
  // Where a page's back step goes: Home when it was opened from Home, else the More list.
  const [backTo, setBackTo] = useState<'Home' | 'More'>('More');
  const [usage, setUsage] = useState(readUsage);
  const open = (to: Tab, s: Sub | null = null, from: 'Home' | 'More' = 'More') => {
    setTab(to);
    setSub(s);
    setBackTo(from);
    if (s) setUsage(countUse(s));
    else if (to === 'Send' || to === 'Received') setUsage(countUse(to));
  };
  const [state, setState] = useState<AppState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((text: string, kind: ToastItem['kind']) => {
    const id = nextId.current++;
    setToasts((l) => [...l.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3000);
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

  // Android back button: the page steps back first (a page opened from Home → Home, a More page →
  // More, another tab → Home); only
  // on Home itself does the app go to the background (MainActivity asks window.__mdBack).
  const nav = useRef({ tab, sub, backTo });
  nav.current = { tab, sub, backTo };
  useEffect(() => {
    const w = window as unknown as { __mdBack?: () => boolean };
    w.__mdBack = () => {
      const { tab: cur, sub: s, backTo: b } = nav.current;
      // nav.current moves at once too: a second back before the next render must see this step.
      if (s !== null && b === 'More') {
        nav.current = { tab: cur, sub: null, backTo: b };
        setSub(null);
        return true;
      }
      if (cur !== 'Home' || s !== null) {
        nav.current = { tab: 'Home', sub: null, backTo: 'More' };
        open('Home');
        return true;
      }
      return false;
    };
    return () => {
      delete w.__mdBack;
    };
  }, []);

  // Android: its engine does not ask other devices for their battery, storage and signal (the
  // desktop's does), so the app asks: each online paired device, at most once a minute.
  const asked = useRef(new Map<string, number>());
  const devs = useRef(state?.devices);
  devs.current = state?.devices;
  useEffect(() => {
    if (state?.platform !== 'android') return;
    const tick = () => {
      const now = Date.now();
      for (const d of devs.current ?? []) {
        if (!d.trusted || d.reach === 'offline' || d.role === 'localsend' || d.role === 'addon') {
          asked.current.delete(d.deviceId); // asked again as soon as it is back
          continue;
        }
        if (now - (asked.current.get(d.deviceId) ?? 0) < 60_000) continue;
        asked.current.set(d.deviceId, now);
        window.meshdrop.appSend(d.deviceId, { kind: 'status' }).catch(() => {});
      }
    };
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, [state?.platform]);

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

  const subs = MORE.filter(
    (p) =>
      !(wide && IN_SIDEBAR.includes(p)) &&
      !(p === 'Guests' && !state?.guest) &&
      !(p === 'Sync' && !state?.sync) &&
      !(p === 'Watch party' && !window.meshdrop.watchCreate) &&
      // The desktop has no wifiSave (it is view-only) but still shows the synced networks.
      !(p === 'Wi-Fi' && !window.meshdrop.wifiList) &&
      !(p === 'Share to Xiaomi' && !window.meshdrop.qrShareStatus),
  );
  const status = !state
    ? ''
    : state.mode === 'client-only'
      ? t('Receiving is handled by the MeshDrop background service')
      : state.error
        ? t('Not receiving')
        : state.receiving
          ? t('Receiving as {name}', { name: state.self.alias })
          : t('Receiving paused');
  const trusted = state ? state.devices.filter((d) => d.trusted && d.role !== 'localsend' && d.role !== 'addon') : [];
  const online = trusted.filter((d) => d.reach !== 'offline').length;
  const notes = (state?.phoneNotes ?? []).length;
  const page = (s: Sub): NavItem => ({ label: SUB_NAME[s], icon: ICON[s], active: tab === 'More' && sub === s, onOpen: () => open('More', s) });
  const navItems: NavItem[] = [
    { label: mark('Home'), icon: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10', active: tab === 'Home', core: true, onOpen: () => open('Home') },
    { label: mark('Send'), icon: 'M4 12l16-8-6 16-2-7-8-1z', active: tab === 'Send', core: true, onOpen: () => open('Send') },
    { label: mark('Received'), icon: 'M12 4v11M7 10l5 5 5-5M5 20h14', active: tab === 'Received', core: true, onOpen: () => open('Received') },
    page('Devices'),
    ...(state?.guest ? [{ ...page('Guests'), label: mark('Room'), icon: 'M16 19a4 4 0 0 0-8 0M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 18a3 3 0 0 0-3-3M17 11a2.5 2.5 0 1 0 0-5M4 18a3 3 0 0 1 3-3M7 11a2.5 2.5 0 1 1 0-5' }] : []),
    page('Transfers'),
    { label: mark('More'), icon: 'M5 12h.01M12 12h.01M19 12h.01', active: tab === 'More' && (sub === null || !wide || !IN_SIDEBAR.includes(sub)), core: true, onOpen: () => open('More') },
  ];
  const navEnd: NavItem[] = [page('Settings'), page('About')];
  // Home's "Most used": the four pages opened most here (at least 3 times), only those this device shows.
  const shown = new Set<string>(['Send', 'Received', ...subs, ...(wide ? IN_SIDEBAR : [])]);
  const frequent = Object.entries(usage)
    .filter(([p, n]) => n >= 3 && shown.has(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p]) => ({
      label: p,
      icon: p === 'Send' || p === 'Received' ? TAB_ICON[p] : ICON[p as Sub],
      onOpen: () => (p === 'Send' || p === 'Received' ? open(p) : open('More', p as Sub, 'Home')),
    }));
  const navButton = (n: NavItem) => (
    <button key={n.label} className={`nav-item${n.active ? ' active' : ''}${n.core ? '' : ' side-only'}`} onClick={n.onOpen} aria-current={n.active ? 'page' : undefined}>
      <Icon d={n.icon} className={n.label === 'More' ? 'nav-icon dots' : 'nav-icon'} />
      <span>{t(n.label)}</span>
    </button>
  );

  return (
    <div className="app">
      <BgArt />
      <QuickPrefs className="qp-float" />
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          MeshDrop
        </div>
        <nav className="nav" aria-label={t('Pages')}>
          {navItems.map(navButton)}
          <hr className="nav-rule side-only" />
          {navEnd.map(navButton)}
        </nav>
        {state && (
          <div className="mesh-card">
            <Icon d="M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01" className="mesh-card-icon" />
            <div>
              <div className="mesh-card-title">{t('Mesh Network')}</div>
              <div className="muted">
                {online === 1 ? t('1 device online') : t('{n} devices online', { n: online })}
              </div>
              <div className="muted mesh-card-status">{status}</div>
            </div>
          </div>
        )}
      </aside>
      <header className="appbar">
        <span className="brand">
          <span className="logo" aria-hidden="true" />
          MeshDrop
        </span>
        <QuickPrefs />
        <button className="icon-btn" aria-label={notes ? t('{n} notifications from your phone', { n: notes }) : t('Notifications')} onClick={() => open('More', 'Remote')}>
          <Icon d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          {notes > 0 && <span className="icon-badge">{notes}</span>}
        </button>
        <button className="icon-btn" aria-label={t('Menu')} onClick={() => open('More')}>
          <Icon d="M12 5h.01M12 12h.01M12 19h.01" className="dots" />
        </button>
      </header>
      <main className="content">
        {state?.error && (
          <div className="banner error" role="alert">
            {state.error}
          </div>
        )}
        {!state ? (
          <p className="muted">{t('Starting…')}</p>
        ) : tab === 'Home' ? (
          <Home state={state} run={run} wide={wide} frequent={frequent} go={(to) => ('tab' in to ? open(to.tab) : open('More', to.sub as Sub, 'Home'))} />
        ) : tab === 'Send' ? (
          <Devices state={state} run={run} />
        ) : tab === 'Received' ? (
          <Inbox state={state} run={run} />
        ) : sub === null ? (
          <>
            <h1 className="page-title">{t('More')}</h1>
            <ul className="menu">
              {subs.map((p) => (
                <li key={p}>
                  <button className="menu-item" onClick={() => open('More', p)}>
                    <span className={`menu-icon icon-${p.replace(/ /g, '-')}`} aria-hidden="true">
                      <Icon d={ICON[p]} />
                    </span>
                    <span className="menu-text">
                      <span className="menu-title">{t(SUB_NAME[p])}</span>
                      <span className="muted">{t(MORE_HINT[p])}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="subhead">
              {!(wide && IN_SIDEBAR.includes(sub)) && (
                <button className="link" onClick={() => (backTo === 'Home' ? open('Home') : setSub(null))}>
                  ‹ {t(backTo)}
                </button>
              )}
              <h1>{t(SUB_NAME[sub])}</h1>
            </div>
            {sub === 'Remote' ? (
              <Remote state={state} run={run} />
            ) : sub === 'Continue' ? (
              <Handoff state={state} run={run} />
            ) : sub === 'Watch party' ? (
              <WatchParty state={state} run={run} />
            ) : sub === 'Wi-Fi' ? (
              <Wifi state={state} run={run} />
            ) : sub === 'Share to Xiaomi' ? (
              <QrShare state={state} run={run} />
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
            ) : sub === 'About' ? (
              <section className="about">
                <About />
              </section>
            ) : (
              <Settings key={JSON.stringify(state.settings)} state={state} run={run} />
            )}
          </>
        )}
      </main>
      {state?.guest?.offers[0] && <GuestOffer key={state.guest.offers[0].id} offer={state.guest.offers[0]} run={run} />}
      <Toasts items={toasts} onClose={(id) => setToasts((l) => l.filter((x) => x.id !== id))} />
    </div>
  );
}
