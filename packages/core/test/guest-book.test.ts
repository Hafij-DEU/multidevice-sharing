import { describe, expect, it } from 'vitest';
import { GuestBook } from '../src/guest/book.ts';

describe('GuestBook', () => {
  it('lets the first browser claim a token and keeps it out for anyone else', () => {
    const b = new GuestBook(() => 1000);
    const { token, expiresAt } = b.open();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBe(1000 + 3_600_000);
    const first = b.claim(token);
    expect(first).toMatchObject({ ok: true, fresh: true });
    const cookie = (first as { cookie: string }).cookie;
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.claim(token, cookie)).toEqual({ ok: true, cookie, fresh: false });
    expect(b.claim(token)).toEqual({ ok: false, error: 'used' });
    expect(b.claim(token, 'x'.repeat(43))).toEqual({ ok: false, error: 'used' });
    expect(b.check(token, cookie)).toBe('ok');
    expect(b.check(token, undefined)).toBe('used');
    expect(b.claim('A'.repeat(22))).toEqual({ ok: false, error: 'unknown' });
    expect(b.check('A'.repeat(22), cookie)).toBe('unknown');
    expect(b.current()).toEqual({ token, expiresAt, claimed: true });
  });

  it('expires on the clock, on end(), and when a new session opens', () => {
    let now = 0;
    const b = new GuestBook(() => now);
    const a = b.open(1000);
    const c = b.claim(a.token) as { cookie: string };
    now = 1001;
    expect(b.check(a.token, c.cookie)).toBe('expired');
    expect(b.claim(a.token, c.cookie)).toEqual({ ok: false, error: 'expired' });
    now = 0;
    const x = b.open();
    const y = b.open();
    expect(b.check(x.token, undefined)).toBe('expired');
    expect(b.claim(y.token)).toMatchObject({ ok: true });
    b.end();
    expect(b.check(y.token, undefined)).toBe('expired');
    expect(b.current()).toBeNull();
  });
});
