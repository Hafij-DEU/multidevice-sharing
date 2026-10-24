import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/api.ts';
import { Toasts, type ToastItem } from './components/Toast.tsx';
import { errorText } from './format.ts';
import { Devices } from './pages/Devices.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Mesh } from './pages/Mesh.tsx';
import { Settings } from './pages/Settings.tsx';
import { Transfers } from './pages/Transfers.tsx';

const PAGES = ['Devices', 'Transfers', 'Inbox', 'Mesh', 'Settings'] as const;
type Page = (typeof PAGES)[number];

/** Runs an action; shows its error (or `ok`, or a string it returns) as a toast. Resolves undefined on error. */
export type Run = <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;

export function App() {
  const [page, setPage] = useState<Page>('Devices');
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
    setPage('Settings');
  }, [state?.platform, state?.keepAlive]);

  useEffect(() => {
    const off = window.meshdrop.onState(setState);
    const poll = () =>
      void window.meshdrop.getState().then(setState, () => {
        setTimeout(poll, 300); // the controller is still starting
      });
    poll();
    return off;
  }, []);

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Pages">
        <div className="brand">MeshDrop</div>
        {PAGES.filter((p) => !(p === 'Mesh' && state?.platform === 'android')).map((p) => (
          <button key={p} className={p === page ? 'nav active' : 'nav'} onClick={() => setPage(p)} aria-current={p === page ? 'page' : undefined}>
            {p}
          </button>
        ))}
        {state && (
          <div className="self muted">
            {state.self.alias}
            <br />
            {state.mode === 'client-only'
              ? 'Receiving is handled by the MeshDrop background service'
              : state.error
                ? 'Not receiving'
                : state.receiving
                  ? `Port ${state.self.port}`
                  : 'Receiving paused'}
          </div>
        )}
      </nav>
      <main className="content">
        {state?.error && (
          <div className="banner error" role="alert">
            {state.error}
          </div>
        )}
        <h1>{page}</h1>
        {!state ? (
          <p className="muted">Starting…</p>
        ) : page === 'Devices' ? (
          <Devices state={state} run={run} />
        ) : page === 'Transfers' ? (
          <Transfers state={state} run={run} />
        ) : page === 'Inbox' ? (
          <Inbox state={state} run={run} />
        ) : page === 'Mesh' ? (
          <Mesh state={state} run={run} />
        ) : (
          <Settings key={JSON.stringify(state.settings)} state={state} run={run} />
        )}
      </main>
      <Toasts items={toasts} onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
