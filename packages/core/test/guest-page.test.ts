import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GuestBook } from '../src/guest/book.ts';
import { GUEST_PAGE } from '../src/guest/page.ts';
import { createGuestServer, type SharedFile } from '../src/guest/server.ts';
import { GuestUploads } from '../src/guest/uploads.ts';

const tmps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('guest page', () => {
  it('is valid JavaScript that never builds HTML from strings', () => {
    const d = mkdtempSync(join(tmpdir(), 'md-gpage-'));
    tmps.push(d);
    writeFileSync(join(d, 'app.js'), GUEST_PAGE.js);
    execFileSync(process.execPath, ['--check', join(d, 'app.js')]);
    expect(GUEST_PAGE.js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(GUEST_PAGE.html).toContain('<script src="/g/app.js"');
    expect(GUEST_PAGE.html).toContain('<link rel="stylesheet" href="/g/app.css"');
    expect(GUEST_PAGE.html).not.toMatch(/<script>|style=/);
    expect(GUEST_PAGE.html).toContain('{{TOKEN}}');
  });

  it('lets a plain download link carry the token in the query (the cookie is still required)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-gpage-'));
    tmps.push(d);
    writeFileSync(join(d, 'f.txt'), 'hello');
    const book = new GuestBook();
    const uploads = new GuestUploads(join(d, 'p'), join(d, 'i'), () => {});
    const shared: SharedFile[] = [{ id: 'x', name: 'f.txt', size: 5, path: join(d, 'f.txt') }];
    const server = createGuestServer({ book, uploads: () => uploads, shared: () => shared, alias: () => 'PC', page: GUEST_PAGE });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { token } = book.open();
    const page = await fetch(`${base}/g/${token}`);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(await (await fetch(`${base}/g/api/shared/x?t=${token}`, { headers: { cookie } })).text()).toBe('hello');
    expect((await fetch(`${base}/g/api/shared/x?t=${token}`)).status).toBe(410);
    expect((await fetch(`${base}/g/api/shared?t=${token}`, { headers: { cookie } })).status).toBe(404); // only downloads take ?t=
  });
});
