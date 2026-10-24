import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, type EngineEvent } from '../src/engine.ts';

const tmps: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start() {
  const d = mkdtempSync(join(tmpdir(), 'md-eguest-'));
  tmps.push(d);
  const e = await Engine.create({ home: join(d, 'home'), inbox: join(d, 'inbox'), port: 0, discovery: false, alias: 'My PC', guest: { port: 0 }, lanAddrs: () => [{ host: '127.0.0.1', port: 0 }] });
  engines.push(e);
  const events: EngineEvent[] = [];
  e.on('event', (ev: EngineEvent) => events.push(ev));
  await e.start();
  return { d, e, events };
}

describe('engine guest sessions', () => {
  it('a guest uploads after the owner accepts, downloads what is shared, and is cut off when it ends', async () => {
    const { d, e, events } = await start();
    const g = await e.guestStart();
    expect(g.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\/[A-Za-z0-9_-]{22}$/);
    expect(g.qrSvg).toContain('<svg');
    const token = g.url.split('/').pop()!;
    const base = g.url.slice(0, g.url.indexOf('/g/'));
    expect(events.some((x) => x.source === 'guest' && x.type === 'opened')).toBe(false);
    const page = await fetch(g.url);
    expect(events.filter((x) => x.source === 'guest' && x.type === 'opened')).toHaveLength(1);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
    await fetch(g.url, { headers: { cookie } }); // the same browser reloading
    expect(events.filter((x) => x.source === 'guest' && x.type === 'opened')).toHaveLength(1);
    const api = (p: string, init: RequestInit = {}) => fetch(`${base}/g/api/${p}`, { ...init, headers: { 'x-guest-token': token, cookie, ...(init.headers as Record<string, string>) } });
    expect(((await (await api('session')).json()) as { owner: string }).owner).toBe('My PC');

    const { id } = (await (await api('offers', { method: 'POST', body: JSON.stringify({ files: [{ name: 'hi.txt', size: 5 }], text: 'note' }) })).json()) as { id: string };
    expect(events.find((x) => x.source === 'guest' && x.type === 'offer')).toMatchObject({ id, text: 'note', files: [{ name: 'hi.txt', size: 5 }] });
    expect(e.guestState()).toMatchObject({ active: true, claimed: true, offers: [{ id }] });
    await e.guestAccept(id);
    await api(`offers/${id}/0?offset=0`, { method: 'PUT', body: 'hello' });
    expect(readFileSync(join(d, 'inbox', 'hi.txt'), 'utf8')).toBe('hello');
    expect(events.find((x) => x.source === 'guest' && x.type === 'received')).toMatchObject({ id, text: 'note', files: [join(d, 'inbox', 'hi.txt')] });

    writeFileSync(join(d, 'gift.txt'), 'for you');
    const [s] = await e.guestShare([join(d, 'gift.txt')]);
    expect(e.guestState().shared).toEqual([{ id: s!.id, name: 'gift.txt', size: 7 }]);
    expect(await (await api(`shared/${s!.id}`)).text()).toBe('for you');
    e.guestUnshare(s!.id);
    expect(e.guestState().shared).toEqual([]);

    await e.guestEnd();
    expect((await api('session')).status).toBe(410);
    expect(e.guestState().active).toBe(false);
    expect(events.some((x) => x.source === 'guest' && x.type === 'ended')).toBe(true);
  });

  it('lasts as long as the owner chooses, from 5 minutes to 24 hours (default 60)', async () => {
    const { e } = await start();
    const near = (got: number, min: number) => expect(Math.abs(got - (Date.now() + min * 60_000))).toBeLessThan(5_000);
    near((await e.guestStart()).expiresAt, 60);
    near((await e.guestStart({ minutes: 15 })).expiresAt, 15);
    near((await e.guestStart({ minutes: 1 })).expiresAt, 5);
    near((await e.guestStart({ minutes: 100_000 })).expiresAt, 24 * 60);
  });

  it('ends by itself at expiry (deleting partial uploads) and clears leftovers at startup', async () => {
    const { d, e, events } = await start();
    const g = await e.guestStart({ ttlMs: 300 });
    const token = g.url.split('/').pop()!;
    const base = g.url.slice(0, g.url.indexOf('/g/'));
    const cookie = ((await fetch(g.url)).headers.get('set-cookie') ?? '').split(';')[0]!;
    const h = { 'x-guest-token': token, cookie };
    const { id } = (await (await fetch(`${base}/g/api/offers`, { method: 'POST', headers: h, body: JSON.stringify({ files: [{ name: 'p.bin', size: 10 }] }) })).json()) as { id: string };
    await e.guestAccept(id);
    await fetch(`${base}/g/api/offers/${id}/0?offset=0`, { method: 'PUT', headers: h, body: 'abc' });
    await new Promise((r) => setTimeout(r, 600));
    expect(events.some((x) => x.source === 'guest' && x.type === 'ended')).toBe(true);
    expect(e.guestState().active).toBe(false);
    expect(existsSync(join(d, 'home', 'guest-partial', id))).toBe(false);
    await e.stop();
    mkdirSync(join(d, 'home', 'guest-partial', 'junk'), { recursive: true });
    await e.start();
    expect(existsSync(join(d, 'home', 'guest-partial'))).toBe(false);
  });

  it('a rejected offer stores nothing', async () => {
    const { d, e } = await start();
    const g = await e.guestStart();
    const token = g.url.split('/').pop()!;
    const base = g.url.slice(0, g.url.indexOf('/g/'));
    const cookie = ((await fetch(g.url)).headers.get('set-cookie') ?? '').split(';')[0]!;
    const h = { 'x-guest-token': token, cookie };
    const { id } = (await (await fetch(`${base}/g/api/offers`, { method: 'POST', headers: h, body: JSON.stringify({ files: [{ name: 'x.bin', size: 3 }] }) })).json()) as { id: string };
    await e.guestReject(id);
    expect((await fetch(`${base}/g/api/offers/${id}/0?offset=0`, { method: 'PUT', headers: h, body: 'abc' })).status).toBe(410);
    expect(e.guestState().offers).toEqual([]);
    expect(() => readFileSync(join(d, 'inbox', 'x.bin'))).toThrow();
  });
});
