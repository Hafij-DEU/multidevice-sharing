// Handoff (M13): continue a page on another device at the same spot.

/** Where a page was: the browser extension's snapshot, or a phone's shared link (+ its video time). */
export interface HandoffState {
  url: string;
  title?: string;
  /** 0..1 of the page height. */
  scroll?: number;
  /** A few words at the top of the screen: the phone's browser scrolls to them (scroll-to-text). */
  text?: string;
  /** Seconds into the page's video. */
  time?: number;
  playing?: boolean;
  at?: number;
}

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

/**
 * The link that opens `s` at the same spot in a plain browser or app: YouTube gets &t= (its app and
 * site start there); other pages get a scroll-to-text fragment (#:~:text=, Chrome and Firefox) when
 * there is text to aim at. Null for anything that is not an http(s) page.
 */
export function handoffUrl(s: HandoffState): string | null {
  let u: URL;
  try {
    u = new URL(s.url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const t = typeof s.time === 'number' && Number.isFinite(s.time) && s.time > 2 ? Math.floor(s.time) : 0;
  if (YT_HOSTS.has(u.hostname)) {
    if (t) u.searchParams.set('t', `${t}s`);
    return u.href;
  }
  const text = typeof s.text === 'string' ? s.text.replace(/\s+/g, ' ').trim() : '';
  if (text && (s.scroll ?? 0) > 0.02) {
    const frag = `:~:text=${encodeURIComponent(text).replace(/-/g, '%2D')}`;
    return u.hash ? `${u.href}${frag}` : `${u.href}#${frag}`;
  }
  return u.href;
}

/** A snapshot from the extension, cleaned (it comes from web pages: never trusted as more than data). */
export function cleanHandoff(x: unknown): HandoffState | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.url !== 'string' || o.url.length > 4096 || !/^https?:\/\//i.test(o.url)) return null;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : undefined);
  const s: HandoffState = { url: o.url, at: Date.now() };
  const title = str(o.title, 200);
  if (title) s.title = title;
  const scroll = num(o.scroll, 0, 1);
  if (scroll !== undefined) s.scroll = scroll;
  const text = str(o.text, 120);
  if (text) s.text = text;
  const time = num(o.time, 0, 1e7);
  if (time !== undefined) s.time = time;
  if (typeof o.playing === 'boolean') s.playing = o.playing;
  return s;
}
