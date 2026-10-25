import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.ts';

const tmps: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('room mode (M11)', () => {
  it('one link: anyone posts and downloads; the host saves a post; ending deletes everything', async () => {
    const home = mkdtempSync(join(tmpdir(), 'md-room-'));
    tmps.push(home);
    const e = await Engine.create({ home, inbox: join(home, 'inbox'), port: 0, discovery: false, alias: 'pc', hub: { ingressPort: 0 }, guest: { port: 0 }, localsend: false, lanAddrs: () => [{ host: '127.0.0.1', port: 0 }] });
    engines.push(e);
    await e.start();
    const { url } = await e.roomStart({ minutes: 10, title: 'Party' });
    const base = url.replace(/\/r\/.*$/, '');
    const token = url.split('/r/')[1]!;
    const api = `${base}/r/api/${token}/posts`;
    expect(await (await fetch(url)).text()).toContain(`data-token="${token}"`);
    expect((await fetch(`${base}/r/api/${'x'.repeat(22)}/posts`)).status).toBe(404);
    expect((await fetch(`${api}?name=a.txt`, { method: 'POST', body: 'no header' })).status).toBe(403);
    const r = await fetch(`${api}?name=${encodeURIComponent('../photo.jpg')}&by=Ann`, { method: 'POST', headers: { 'x-room': '1' }, body: 'jpeg bytes' });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const list = (await (await fetch(api)).json()) as { title: string; posts: { id: string; name: string; by: string; image: boolean }[] };
    expect(list.title).toBe('Party');
    expect(list.posts).toEqual([expect.objectContaining({ id, name: '__photo.jpg', by: 'Ann', image: true })]);
    expect(await (await fetch(`${api}/${id}`)).text()).toBe('jpeg bytes');
    const saved = await e.roomSave(id);
    expect(readFileSync(saved, 'utf8')).toBe('jpeg bytes');
    expect(e.roomState()).toMatchObject({ active: true, posts: [expect.objectContaining({ id })] });
    await e.roomEnd();
    expect((await fetch(api)).status).toBe(404);
    expect(readFileSync(saved, 'utf8')).toBe('jpeg bytes'); // saved copies stay
  });
});
