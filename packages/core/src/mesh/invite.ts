// QR invites (protocol v1). An owner device creates a short-lived, single-use invite and shows it
// as a URI (QR code):
//   meshdrop://join?v=1&s=<secret b64url>&i=<inviter id>&r=<mesh id>&l=<host:port>...&h=<hub url>...&e=<expiry, epoch s>
// The joining device proves knowledge of the secret, bound to its own id and the inviter:
//   proof = base64(HMAC-SHA256(secret, "meshdrop-join-v1\0" + newDeviceId + "\0" + inviter))
// Only the device that enforces the invite (the inviter, or the hub for a registered invite)
// judges its expiry, by its own clock; the joining device never does (clocks disagree).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const INVITE_TTL_MS = 300_000;
export const INVITE_MAX_ATTEMPTS = 5;
export const JOIN_DOMAIN = 'meshdrop-join-v1';
const SECRET_BYTES = 16;

export interface Invite {
  secret: Buffer;
  inviter: string;
  mesh: string;
  lan: { host: string; port: number }[];
  hubUrls: string[];
  expiresAt: number;
}

export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;
const HOST_RE = /^[A-Za-z0-9.:_-]{1,253}$/;
const MAX_LIST = 8;

const bad = (why: string): never => {
  throw new InviteError(`invalid invite: ${why}`);
};

function parseAddr(s: string): { host: string; port: number } {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(s);
  if (!m) return bad('lan address');
  const host = m[1] ?? m[2]!;
  const port = Number(m[3]);
  if (!HOST_RE.test(host) || port < 1 || port > 65535) return bad('lan address');
  return { host, port };
}

const fmtAddr = (a: { host: string; port: number }) => (a.host.includes(':') ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`);

function checkUrl(u: string): string {
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return bad('hub url');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname);
  if (u.length > 512 || !(p.protocol === 'wss:' || (p.protocol === 'ws:' && loopback))) return bad('hub url');
  return u;
}

export function inviteUri(i: Invite): string {
  const parts = [
    'v=1',
    `s=${i.secret.toString('base64url')}`,
    `i=${i.inviter}`,
    `r=${i.mesh}`,
    ...i.lan.map((a) => `l=${encodeURIComponent(fmtAddr(a))}`),
    ...i.hubUrls.map((u) => `h=${encodeURIComponent(u)}`),
    `e=${Math.floor(i.expiresAt / 1000)}`,
  ];
  return `meshdrop://join?${parts.join('&')}`;
}

export function parseInviteUri(s: string): Invite {
  if (typeof s !== 'string' || s.length > 4096 || !s.startsWith('meshdrop://join?')) return bad('scheme');
  const pairs = s.slice('meshdrop://join?'.length).split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq <= 0) return bad('parameter');
    let v: string;
    try {
      v = decodeURIComponent(kv.slice(eq + 1));
    } catch {
      return bad('encoding');
    }
    return [kv.slice(0, eq), v] as const;
  });
  // Fixed order: v, s, i, r, l*, h*, e.
  const order = ['v', 's', 'i', 'r', 'l', 'h', 'e'];
  let last = -1;
  const one = new Map<string, string>();
  const lan: Invite['lan'] = [];
  const hubUrls: string[] = [];
  for (const [k, v] of pairs) {
    const idx = order.indexOf(k);
    const repeats = k === 'l' || k === 'h';
    // Strictly increasing order; only l and h may repeat (consecutively).
    if (idx < 0 || idx < last || (idx === last && !repeats)) return bad(`parameter ${k}`);
    last = idx;
    if (k === 'l') lan.push(parseAddr(v));
    else if (k === 'h') hubUrls.push(checkUrl(v));
    else one.set(k, v);
  }
  for (const k of ['v', 's', 'i', 'r', 'e']) if (!one.has(k)) bad(`missing ${k}`);
  if (one.get('v') !== '1') bad('version');
  const sec = one.get('s')!;
  if (!SECRET_RE.test(sec)) bad('secret');
  const inviter = one.get('i')!;
  const mesh = one.get('r')!;
  if (!HEX64.test(inviter)) bad('inviter');
  if (!HEX64.test(mesh)) bad('mesh');
  const e = one.get('e')!;
  if (!/^[0-9]{1,12}$/.test(e)) bad('expiry');
  if (lan.length > MAX_LIST || hubUrls.length > MAX_LIST) bad('too many addresses');
  if (lan.length === 0 && hubUrls.length === 0) bad('no address');
  return { secret: Buffer.from(sec, 'base64url'), inviter, mesh, lan, hubUrls, expiresAt: Number(e) * 1000 };
}

export function joinProof(secret: Buffer, newId: string, inviter: string): string {
  return createHmac('sha256', secret).update(`${JOIN_DOMAIN}\0${newId}\0${inviter}`).digest('base64');
}

export type ConsumeResult = 'ok' | 'expired' | 'used' | 'bad-proof' | 'unknown' | 'burned';

interface Entry { invite: Invite; attempts: number; used: boolean }

/**
 * Invites this device enforces. One live invite per inviter: creating or registering a new one
 * replaces the previous, so failed attempts always count against an unambiguous invite.
 */
export class InviteBook {
  readonly #now: () => number;
  readonly #byInviter = new Map<string, Entry>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  create(inviter: string, mesh: string, lan: Invite['lan'], hubUrls: string[]): Invite {
    const invite: Invite = { secret: randomBytes(SECRET_BYTES), inviter, mesh, lan: [...lan], hubUrls: [...hubUrls], expiresAt: this.#now() + INVITE_TTL_MS };
    this.#byInviter.set(inviter, { invite, attempts: 0, used: false });
    return invite;
  }

  /**
   * Adopts an invite created on another device (or re-loaded): it expires `ttlMs` from now on this
   * book's clock, at most INVITE_TTL_MS. Registering a secret this book already holds for the inviter
   * changes nothing, so a used, burned or expired invite can never be brought back to life.
   */
  register(i: Invite, ttlMs: number = INVITE_TTL_MS): void {
    if (i.secret.length !== SECRET_BYTES) throw new InviteError('invalid invite: secret');
    const cur = this.#byInviter.get(i.inviter);
    if (cur && cur.invite.secret.equals(i.secret)) return;
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, Math.min(ttlMs, INVITE_TTL_MS)) : 0;
    this.#byInviter.set(i.inviter, { invite: { ...i, expiresAt: this.#now() + ttl }, attempts: 0, used: false });
  }

  /** Burns the inviter's live invite (it was redeemed elsewhere). False if there is none. */
  markUsed(inviter: string): boolean {
    const e = this.#byInviter.get(inviter);
    if (!e) return false;
    e.used = true;
    return true;
  }

  consume(newId: string, inviter: string, proof: string): ConsumeResult {
    const e = this.#byInviter.get(inviter);
    if (!e) return 'unknown';
    if (e.used) return 'used';
    if (e.attempts >= INVITE_MAX_ATTEMPTS) return 'burned';
    if (this.#now() > e.invite.expiresAt) return 'expired';
    e.attempts++;
    const want = Buffer.from(joinProof(e.invite.secret, newId, inviter), 'base64');
    const got = typeof proof === 'string' ? Buffer.from(proof, 'base64') : Buffer.alloc(0);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return 'bad-proof';
    e.used = true;
    return 'ok';
  }
}
