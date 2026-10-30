// LAN guest sessions (M5a): the owner shows a QR code with a one-time token. The first browser that
// opens it claims the session (it gets a cookie); any other browser with the same link is turned away.
// One live session per engine; it ends after its TTL, when the owner ends it, or when a new one opens.
import { randomBytes, timingSafeEqual } from 'node:crypto';

const GUEST_TTL_MS = 3_600_000;
const KEEP_OLD = 16;

export type GuestCheck = 'ok' | 'unknown' | 'used' | 'expired';
export type GuestClaim = { ok: true; cookie: string; fresh: boolean } | { ok: false; error: 'unknown' | 'used' | 'expired' };

interface Session { token: string; expiresAt: number; cookie: string | null }

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class GuestBook {
  readonly #now: () => number;
  #live: Session | null = null;
  /** Tokens that ended (replaced, ended, timed out), so a stale QR says "expired", not "unknown". */
  readonly #old: string[] = [];

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  open(ttlMs: number = GUEST_TTL_MS): { token: string; expiresAt: number } {
    this.end();
    const s: Session = { token: randomBytes(16).toString('base64url'), expiresAt: this.#now() + ttlMs, cookie: null };
    this.#live = s;
    return { token: s.token, expiresAt: s.expiresAt };
  }

  end(): void {
    if (!this.#live) return;
    this.#old.push(this.#live.token);
    if (this.#old.length > KEEP_OLD) this.#old.shift();
    this.#live = null;
  }

  current(): { token: string; expiresAt: number; claimed: boolean } | null {
    const s = this.#session();
    return s ? { token: s.token, expiresAt: s.expiresAt, claimed: s.cookie !== null } : null;
  }

  /** The live session, ended first if its time is up. */
  #session(): Session | null {
    if (this.#live && this.#now() > this.#live.expiresAt) this.end();
    return this.#live;
  }

  #state(token: string): 'live' | 'unknown' | 'expired' {
    const s = this.#session();
    if (typeof token === 'string' && s && same(token, s.token)) return 'live';
    return this.#old.some((t) => same(token, t)) ? 'expired' : 'unknown';
  }

  claim(token: string, cookie?: string): GuestClaim {
    const st = this.#state(token);
    if (st !== 'live') return { ok: false, error: st };
    const s = this.#live!;
    if (s.cookie === null) {
      s.cookie = randomBytes(32).toString('base64url');
      return { ok: true, cookie: s.cookie, fresh: true };
    }
    if (typeof cookie === 'string' && same(cookie, s.cookie)) return { ok: true, cookie: s.cookie, fresh: false };
    return { ok: false, error: 'used' };
  }

  check(token: string, cookie: string | undefined): GuestCheck {
    const st = this.#state(token);
    if (st !== 'live') return st;
    const s = this.#live!;
    return s.cookie !== null && typeof cookie === 'string' && same(cookie, s.cookie) ? 'ok' : 'used';
  }
}
