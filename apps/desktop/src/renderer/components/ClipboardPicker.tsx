import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/api.ts';
import { errorText } from '../format.ts';
import { Peer } from './Peer.tsx';

const LAST = 'meshdrop.picker.last';

function lastChoice(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LAST) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The small window behind the "send clipboard" shortcut: pick devices, Enter sends, Esc closes. */
export function ClipboardPicker() {
  const [state, setState] = useState<AppState | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(lastChoice()));
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    document.title = 'Send clipboard';
    const off = window.meshdrop.onState(setState);
    const poll = () => void window.meshdrop.getState().then(setState, () => setTimeout(poll, 300));
    poll();
    return off;
  }, []);

  const online = state?.devices.filter((d) => d.trusted && d.reach !== 'offline') ?? [];
  const targets = online.filter((d) => chosen.has(d.deviceId)).map((d) => d.deviceId);

  const send = async () => {
    if (targets.length === 0 || sending) return;
    setSending(true);
    try {
      await window.meshdrop.sendClipboard(targets);
      try {
        localStorage.setItem(LAST, JSON.stringify(targets));
      } catch {
        /* storage unavailable: no memory of the choice */
      }
      window.close();
    } catch (x) {
      setError(errorText(x));
      setSending(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
      else if (e.key === 'Enter') void send();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="picker">
      <h1>Send clipboard</h1>
      {!state ? (
        <p className="muted">Starting…</p>
      ) : online.length === 0 ? (
        <p className="muted">No device is online.</p>
      ) : (
        <ul className="list">
          {online.map((d) => (
            <li key={d.deviceId}>
              <label className="row">
                <input
                  type="checkbox"
                  checked={chosen.has(d.deviceId)}
                  onChange={() =>
                    setChosen((s) => {
                      const n = new Set(s);
                      if (n.has(d.deviceId)) n.delete(d.deviceId);
                      else n.add(d.deviceId);
                      return n;
                    })
                  }
                />
                <Peer text={d.alias} />
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="row space">
        <span className="muted">Enter sends · Esc closes</span>
        <button className="primary" disabled={targets.length === 0 || sending} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  );
}
