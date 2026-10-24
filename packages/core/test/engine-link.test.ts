import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, type EngineEvent } from '../src/engine.ts';
import { OFFER_FILE, UPLOAD_BASE, openChunk, sealChunk } from '../src/links/crypto.ts';

const tmps: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('engine internet links', () => {
  it('the hub makes a link; a visitor downloads and sends back after the owner accepts; revoke ends it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-elink-'));
    tmps.push(d);
    const e = await Engine.create({ home: join(d, 'home'), inbox: join(d, 'inbox'), port: 0, discovery: false, guest: false, hub: { ingressPort: 0 } });
    engines.push(e);
    await e.hubInit([]);
    const events: EngineEvent[] = [];
    e.on('event', (ev: EngineEvent) => events.push(ev));
    await e.start();
    writeFileSync(join(d, 'gift.txt'), 'for the world');
    const l = await e.linkCreate({ files: [join(d, 'gift.txt')], hours: 2, allowUploads: true });
    expect(l.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${e.hubIngressPort}/l/${l.id}#k=[A-Za-z0-9_-]{43}$`));
    const key = Buffer.from(l.url.split('#k=')[1]!, 'base64url');
    const base = l.url.slice(0, l.url.indexOf('/l/'));
    const api = `${base}/l/${l.id}/api`;
    const { session } = (await (await fetch(`${api}/open`, { method: 'POST', headers: { 'x-link-key': key.toString('base64url') } })).json()) as { session: string };
    const h = { 'x-link-session': session };
    const sealed = Buffer.from(await (await fetch(`${api}/chunk/0/0`, { headers: h })).arrayBuffer());
    expect(openChunk(key, l.id, 0, 0, true, sealed).toString()).toBe('for the world');
    expect((await e.linkList())[0]).toMatchObject({ id: l.id, url: l.url, downloads: 1, allowUploads: true });

    const offer = sealChunk(key, l.id, OFFER_FILE, 0, true, Buffer.from(JSON.stringify({ files: [{ name: 'back.txt', size: 4 }] })));
    const { id: oid } = (await (await fetch(`${api}/offers`, { method: 'POST', headers: h, body: offer })).json()) as { id: string };
    expect(events.find((x) => x.source === 'guest' && x.type === 'offer')).toMatchObject({ id: oid, via: 'link', link: l.id });
    expect(e.guestState().offers).toEqual([expect.objectContaining({ id: oid, via: 'link' })]);
    await e.guestAccept(oid);
    await fetch(`${api}/offers/${oid}/0?offset=0`, { method: 'PUT', headers: h, body: sealChunk(key, l.id, UPLOAD_BASE, 0, true, Buffer.from('back')) });
    expect(readFileSync(join(d, 'inbox', 'back.txt'), 'utf8')).toBe('back');

    await e.linkRevoke(l.id);
    expect((await fetch(`${api}/info`)).status).toBe(404);
    expect(await e.linkList()).toEqual([]);
  });

  it('only the hub makes links', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-elink-'));
    tmps.push(d);
    const e = await Engine.create({ home: join(d, 'home'), port: 0, discovery: false, guest: false });
    engines.push(e);
    await expect(e.linkCreate({ files: [] })).rejects.toThrow(/hub/);
  });
});
