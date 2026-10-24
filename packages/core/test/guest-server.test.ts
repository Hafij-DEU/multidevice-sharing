import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GuestBook } from '../src/guest/book.ts';
import { createGuestServer, type SharedFile } from '../src/guest/server.ts';
import { GuestUploads } from '../src/guest/uploads.ts';

const tmps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAGE = { html: '<!doctype html><meta name="guest-token" content="{{TOKEN}}"><script src="/g/app.js"></script>', js: 'console.log(1)', css: 'body{}' };

async function setup(now = () => Date.now()) {
  const d = mkdtempSync(join(tmpdir(), 'md-gsrv-'));
  tmps.push(d);
  const book = new GuestBook(now);
  const uploads = new GuestUploads(join(d, 'partial'), join(d, 'inbox'), () => {});
  const shared: SharedFile[] = [];
  const server = createGuestServer({ book, uploads: () => uploads, shared: () => shared, alias: () => 'My PC', page: PAGE });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { d, book, uploads, shared, base };
}

function cookieOf(r: Response): string {
  const c = r.headers.get('set-cookie') ?? '';
  return c.split(';')[0]!;
}

describe('guest server', () => {
  it('lets the claiming browser in, and nobody else', async () => {
    const { book, base } = await setup();
    const { token } = book.open();
    const page = await fetch(`${base}/g/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('set-cookie')).toMatch(/^mdg=[A-Za-z0-9_-]{43}; Path=\/g; HttpOnly; SameSite=Strict/);
    expect(await page.text()).toContain(`content="${token}"`);
    for (const h of ['cache-control', 'x-content-type-options', 'referrer-policy', 'content-security-policy']) expect(page.headers.get(h)).toBeTruthy();
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const cookie = cookieOf(page);
    const api = (path: string, init: RequestInit = {}, c = cookie) => fetch(`${base}${path}`, { ...init, headers: { 'x-guest-token': token, cookie: c, ...(init.headers as Record<string, string>) } });
    expect(await (await api('/g/api/session')).json()).toMatchObject({ owner: 'My PC' });
    const second = await fetch(`${base}/g/${token}`);
    expect(second.status).toBe(410);
    expect((await api('/g/api/session', {}, '')).status).toBe(410);
    expect((await fetch(`${base}/g/api/session`, { headers: { cookie } })).status).toBe(404); // no token at all
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/g/app.js`)).headers.get('content-type')).toMatch(/^text\/javascript/);
    expect((await fetch(`${base}/g/app.css`)).headers.get('content-type')).toMatch(/^text\/css/);
  });

  it('runs offer -> accept -> upload and serves shared files with ranges', async () => {
    const { d, book, uploads, shared, base } = await setup();
    const { token } = book.open();
    const cookie = cookieOf(await fetch(`${base}/g/${token}`));
    const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { 'x-guest-token': token, cookie, ...(init.headers as Record<string, string>) } });
    const o = await api('/g/api/offers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ name: 'a.txt', size: 6 }] }) });
    expect(o.status).toBe(201);
    const { id } = (await o.json()) as { id: string };
    expect(((await (await api(`/g/api/offers/${id}`)).json()) as { status: string }).status).toBe('pending');
    expect((await api(`/g/api/offers/${id}/0?offset=0`, { method: 'PUT', body: 'abc' })).status).toBe(409);
    await uploads.accept(id);
    expect(await (await api(`/g/api/offers/${id}/0?offset=0`, { method: 'PUT', body: 'abc' })).json()).toEqual({ received: 3 });
    const wrong = await api(`/g/api/offers/${id}/0?offset=0`, { method: 'PUT', body: 'abc' });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ error: 'offset', received: 3 });
    await api(`/g/api/offers/${id}/0?offset=3`, { method: 'PUT', body: 'def' });
    expect(readFileSync(join(d, 'inbox', 'a.txt'), 'utf8')).toBe('abcdef');
    expect((await api('/g/api/offers', { method: 'POST', body: '{bad' })).status).toBe(400);

    writeFileSync(join(d, 'share.bin'), '0123456789');
    shared.push({ id: 's1', name: 'share ü.bin', size: 10, path: join(d, 'share.bin') });
    expect(await (await api('/g/api/shared')).json()).toEqual([{ id: 's1', name: 'share ü.bin', size: 10 }]);
    const full = await api('/g/api/shared/s1');
    expect(await full.text()).toBe('0123456789');
    expect(full.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''share%20%C3%BC.bin");
    const part = await api('/g/api/shared/s1', { headers: { range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await part.text()).toBe('234');
    expect((await api('/g/api/shared/s1', { headers: { range: 'bytes=20-30' } })).status).toBe(416);
    expect((await api('/g/api/shared/nope')).status).toBe(404);
  });

  it('says expired once the session is over', async () => {
    let now = 0;
    const { book, base } = await setup(() => now);
    const { token } = book.open(1000);
    const cookie = cookieOf(await fetch(`${base}/g/${token}`));
    now = 2000;
    const r = await fetch(`${base}/g/api/session`, { headers: { 'x-guest-token': token, cookie } });
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: 'expired' });
    expect((await fetch(`${base}/g/${token}`)).status).toBe(410);
  });
});
