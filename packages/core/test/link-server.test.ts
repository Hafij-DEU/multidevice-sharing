import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GuestUploads } from '../src/guest/uploads.ts';
import { OFFER_FILE, UPLOAD_BASE, openChunk, openManifest, sealChunk, uploadKey } from '../src/links/crypto.ts';
import { randomBytes } from 'node:crypto';
import { createLinkHandler } from '../src/links/server.ts';
import { LinkStore } from '../src/links/store.ts';

const tmps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const d = mkdtempSync(join(tmpdir(), 'md-lsrv-'));
  tmps.push(d);
  const store = new LinkStore(join(d, 'links'));
  const uploads = new GuestUploads(join(d, 'partial'), join(d, 'inbox'), () => {});
  const handler = createLinkHandler({ store, uploads: () => uploads, page: { html: '<p>page</p>', js: '', css: '' } });
  const server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { d, store, uploads, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const buf = async (r: Response) => Buffer.from(await r.arrayBuffer());

describe('link routes', () => {
  it('a visitor downloads with the key from the fragment; a revoke stops it', async () => {
    const { d, store, base } = await setup();
    writeFileSync(join(d, 'f.txt'), 'top secret');
    const { id, key } = await store.create({ files: [join(d, 'f.txt')] });
    expect(await (await fetch(`${base}/l/${id}`)).text()).toBe('<p>page</p>');
    expect(await (await fetch(`${base}/l/${id}/api/info`)).json()).toEqual({ needsPassword: false, allowUploads: false });
    const { session } = (await (await fetch(`${base}/l/${id}/api/open`, { method: 'POST' })).json()) as { session: string };
    const h = { 'x-link-session': session };
    expect(openManifest(key, id, await buf(await fetch(`${base}/l/${id}/api/manifest`, { headers: h }))).files[0]!.name).toBe('f.txt');
    expect(openChunk(key, id, 0, 0, true, await buf(await fetch(`${base}/l/${id}/api/chunk/0/0`, { headers: h }))).toString()).toBe('top secret');
    expect((await fetch(`${base}/l/${id}/api/chunk/0/0`)).status).toBe(401);
    await store.revoke(id);
    expect((await fetch(`${base}/l/${id}/api/chunk/0/0`, { headers: h })).status).toBe(401);
    expect((await fetch(`${base}/l/${id}/api/info`)).status).toBe(404);
    expect((await fetch(`${base}/x`)).status).toBe(404);
  });

  it('uploads need the key, decrypt on the hub, and wait for the owner', async () => {
    const { d, store, uploads, base } = await setup();
    writeFileSync(join(d, 'f.txt'), 'x');
    const { id, key } = await store.create({ files: [join(d, 'f.txt')], allowUploads: true });
    const noKey = (await (await fetch(`${base}/l/${id}/api/open`, { method: 'POST' })).json()) as { session: string; allowUploads: boolean };
    expect(noKey.allowUploads).toBe(false);
    expect((await fetch(`${base}/l/${id}/api/offers`, { method: 'POST', headers: { 'x-link-session': noKey.session }, body: 'x' })).status).toBe(403);
    const o = (await (await fetch(`${base}/l/${id}/api/open`, { method: 'POST', headers: { 'x-link-key': key.toString('base64url') } })).json()) as { session: string; allowUploads: boolean };
    expect(o.allowUploads).toBe(true);
    const h = { 'x-link-session': o.session };
    const plainOffer = Buffer.from(JSON.stringify({ files: [{ name: 'back.txt', size: 5 }] }));
    // Without a salt (an old page) the hub refuses: every offer needs its own key.
    expect((await fetch(`${base}/l/${id}/api/offers`, { method: 'POST', headers: h, body: sealChunk(key, id, OFFER_FILE, 0, true, plainOffer) })).status).toBe(400);
    const salt = randomBytes(16);
    const upKey = uploadKey(key, id, salt);
    const r = await fetch(`${base}/l/${id}/api/offers`, { method: 'POST', headers: { ...h, 'x-upload-salt': salt.toString('base64url') }, body: sealChunk(upKey, id, OFFER_FILE, 0, true, plainOffer) });
    expect(r.status).toBe(201);
    const { id: oid } = (await r.json()) as { id: string };
    // Two offers never share key and nonce: a second salt gives other ciphertext for the same bytes.
    expect(sealChunk(uploadKey(key, id, randomBytes(16)), id, UPLOAD_BASE, 0, true, Buffer.from('hello'))).not.toEqual(sealChunk(upKey, id, UPLOAD_BASE, 0, true, Buffer.from('hello')));
    await uploads.accept(oid);
    expect((await fetch(`${base}/l/${id}/api/offers/${oid}/0?offset=0`, { method: 'PUT', headers: h, body: sealChunk(key, id, UPLOAD_BASE, 0, true, Buffer.from('hello')) })).status).toBe(400); // sealed with the link key itself
    const bad = Buffer.from(sealChunk(upKey, id, UPLOAD_BASE, 0, true, Buffer.from('hello')));
    bad[0]! ^= 1;
    expect((await fetch(`${base}/l/${id}/api/offers/${oid}/0?offset=0`, { method: 'PUT', headers: h, body: bad })).status).toBe(400);
    const good = sealChunk(upKey, id, UPLOAD_BASE, 0, true, Buffer.from('hello'));
    expect(await (await fetch(`${base}/l/${id}/api/offers/${oid}/0?offset=0`, { method: 'PUT', headers: h, body: good })).json()).toEqual({ received: 5 });
    expect(readFileSync(join(d, 'inbox', 'back.txt'), 'utf8')).toBe('hello');
  });

  it('a link without uploads refuses offers even with the key', async () => {
    const { d, store, base } = await setup();
    writeFileSync(join(d, 'f.txt'), 'x');
    const { id, key } = await store.create({ files: [join(d, 'f.txt')] });
    const o = (await (await fetch(`${base}/l/${id}/api/open`, { method: 'POST', headers: { 'x-link-key': key.toString('base64url') } })).json()) as { session: string };
    expect((await fetch(`${base}/l/${id}/api/offers`, { method: 'POST', headers: { 'x-link-session': o.session }, body: 'x' })).status).toBe(403);
  });
});
