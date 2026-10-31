import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.ts';
import { SYNC_STEP_JS, WATCH_PAGE } from '../src/watch/page.ts';
import { CODE_RE, newCode, parseSource, positionAt } from '../src/watch/rooms.ts';

const tmps: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('watch party links', () => {
  it('reads YouTube, Dropbox, Google Drive and direct links', () => {
    expect(parseSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', 'ABCDEF')).toEqual({ source: { kind: 'youtube', id: 'dQw4w9WgXcQ', title: 'YouTube video' }, start: 90 });
    expect(parseSource('https://youtu.be/dQw4w9WgXcQ?t=42', 'ABCDEF')?.start).toBe(42);
    expect(parseSource('https://m.youtube.com/shorts/dQw4w9WgXcQ', 'ABCDEF')?.source).toMatchObject({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseSource('https://www.youtube.com/watch?v=short', 'ABCDEF')).toBeNull();
    expect(parseSource('https://www.dropbox.com/scl/fi/abc/movie.mp4?rlkey=x&dl=0', 'ABCDEF')?.source).toEqual({ kind: 'video', url: 'https://www.dropbox.com/scl/fi/abc/movie.mp4?rlkey=x&raw=1', title: 'movie.mp4' });
    expect(parseSource('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing', 'ABCDEF')?.source).toEqual({ kind: 'video', url: '/w/media/ABCDEF/drive-1AbCdEfGhIjKlMnOp', title: 'Google Drive video' });
    expect(parseSource('https://example.com/films/a%20b.mp4', 'ABCDEF')?.source).toEqual({ kind: 'video', url: 'https://example.com/films/a%20b.mp4', title: 'a b.mp4' });
    expect(parseSource('javascript:alert(1)', 'ABCDEF')).toBeNull();
    expect(parseSource('file:///etc/passwd', 'ABCDEF')).toBeNull();
  });

  it('codes are 6 unambiguous characters; position runs with the clock and the rate', () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(CODE_RE);
    expect(positionAt({ playing: true, position: 10, rate: 2, updatedAt: 1000 }, 4000)).toBe(16);
    expect(positionAt({ playing: false, position: 10, rate: 2, updatedAt: 1000 }, 4000)).toBe(10);
  });
});

/** Reads Server-Sent Events from a fetch body. */
function events(body: ReadableStream<Uint8Array>) {
  const got: { event: string; data: any }[] = [];
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    for await (const c of body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(c, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) got.push({ event: ev, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return got;
}
const until = async (c: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!c()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('watch party drift', () => {
  type Step = { seek: boolean; rate: number };
  const step = new Function(`${SYNC_STEP_JS}; return syncStep;`)() as (drift: number, playing: boolean, kind: string) => Step;

  it('a video a little out of step speeds up or slows down (10% at most) instead of jumping', () => {
    expect(step(0.02, true, 'video')).toEqual({ seek: false, rate: 1 });
    const behind = step(0.3, true, 'video');
    expect(behind.seek).toBe(false);
    expect(behind.rate).toBeGreaterThan(1);
    expect(step(1.8, true, 'video')).toEqual({ seek: false, rate: 1.1 });
    const ahead = step(-0.3, true, 'video');
    expect(ahead.seek).toBe(false);
    expect(ahead.rate).toBeLessThan(1);
    expect(step(-1.8, true, 'video').rate).toBeCloseTo(0.9);
  });

  it('far out of step, or YouTube (whose speeds come in big steps) past half a second: a jump', () => {
    expect(step(2.5, true, 'video')).toEqual({ seek: true, rate: 1 });
    expect(step(0.3, true, 'youtube')).toEqual({ seek: false, rate: 1 });
    expect(step(0.7, true, 'youtube')).toEqual({ seek: true, rate: 1 });
    expect(step(-0.7, true, 'youtube')).toEqual({ seek: true, rate: 1 });
    // paused: only the place matters
    expect(step(0.3, false, 'video')).toEqual({ seek: false, rate: 1 });
    expect(step(0.6, false, 'youtube')).toEqual({ seek: true, rate: 1 });
  });

  it('the page runs the same step', () => {
    expect(WATCH_PAGE.js).toContain(SYNC_STEP_JS);
  });
});

describe('watch party rooms', () => {
  it('everyone gets the same state; the host can lock control; the host shares a video', async () => {
    const home = mkdtempSync(join(tmpdir(), 'md-watch-'));
    tmps.push(home);
    const e = await Engine.create({ home, inbox: join(home, 'inbox'), port: 0, discovery: false, alias: 'pc', hub: { ingressPort: 0 }, guest: { port: 0 }, localsend: false, lanAddrs: () => [{ host: '127.0.0.1', port: 0 }] });
    engines.push(e);
    await e.start();
    const { code, hostToken, links } = e.watchCreate('Movie night');
    expect(code).toMatch(CODE_RE);
    const base = links[0]!.replace(/\/w\/.*$/, '');
    expect(links).toEqual([`${base}/w/${code}`]);
    expect((await fetch(`${base}/w/${code}`)).headers.get('content-security-policy')).toContain('https://www.youtube.com');
    const info = await fetch(`${base}/w/api/${code.toLowerCase()}`);
    expect([info.status, info.headers.get('access-control-allow-origin'), await info.json()]).toEqual([200, '*', { code, name: 'Movie night' }]);

    const host = await fetch(`${base}/w/api/${code}/events?m=host-member-1&n=Ann&h=${hostToken}`);
    const guest = await fetch(`${base}/w/api/${code}/events?m=guest-member-1&n=Bob`);
    const H = events(host.body!);
    const G = events(guest.body!);
    await until(() => G.some((x) => x.event === 'hello') && H.some((x) => x.event === 'hello'));
    expect(H.find((x) => x.event === 'hello')!.data.host).toBe(true);
    expect(G.find((x) => x.event === 'hello')!.data.host).toBe(false);

    const cmd = (m: string, c: Record<string, unknown>, h?: string) =>
      fetch(`${base}/w/api/${code}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-watch': '1' }, body: JSON.stringify({ m, ...(h ? { h } : {}), ...c }) });
    expect((await fetch(`${base}/w/api/${code}/cmd`, { method: 'POST', body: '{}' })).status).toBe(403); // no X-Watch
    expect((await cmd('guest-member-1', { type: 'source', url: 'https://youtu.be/dQw4w9WgXcQ?t=5' })).status).toBe(200);
    expect((await cmd('guest-member-1', { type: 'play', position: 5 })).status).toBe(200);
    await until(() => H.filter((x) => x.event === 'state').length >= 2);
    const st = H.filter((x) => x.event === 'state').pop()!.data;
    expect(st).toMatchObject({ playing: true, position: 5, source: { kind: 'youtube', id: 'dQw4w9WgXcQ' }, by: 'guest-member-1' });

    expect((await cmd('host-member-1', { type: 'hostOnly', on: true })).status).toBe(200);
    expect((await cmd('guest-member-1', { type: 'pause' })).status).toBe(403);
    expect((await cmd('guest-member-1', { type: 'chat', text: 'hi all' })).status).toBe(200); // chat stays open
    await until(() => H.some((x) => x.event === 'chat' && x.data.text === 'hi all' && x.data.name === 'Bob'));

    // the host's own video (a file on this PC) streams to everyone, seekable
    const f = join(home, 'clip.mp4');
    writeFileSync(f, Buffer.alloc(1000, 7));
    await e.watchPlayLocal(code, f);
    await until(() => G.filter((x) => x.event === 'state').some((x) => x.data.source?.title === 'clip.mp4'));
    const src = G.filter((x) => x.event === 'state').pop()!.data.source.url as string;
    const part = await fetch(base + src, { headers: { range: 'bytes=100-199' } });
    expect([part.status, part.headers.get('content-range'), (await part.arrayBuffer()).byteLength]).toEqual([206, 'bytes 100-199/1000', 100]);
    // uploads: host only
    expect((await fetch(`${base}/w/api/${code}/upload?m=guest-member-1&name=x.mp4`, { method: 'POST', headers: { 'x-watch': '1' }, body: 'x' })).status).toBe(403);
    const up = await fetch(`${base}/w/api/${code}/upload?m=host-member-1&h=${hostToken}&name=phone.mp4`, { method: 'POST', headers: { 'x-watch': '1' }, body: 'video bytes' });
    expect(up.status).toBe(201);

    expect(e.watchList()).toEqual([expect.objectContaining({ code, name: 'Movie night', people: 2, playing: 'phone.mp4' })]);
    await e.watchEnd(code);
    await until(() => G.some((x) => x.event === 'ended'));
    expect((await fetch(`${base}/w/api/${code}`)).status).toBe(404);
  }, 30_000);
  it('the same-Wi-Fi link comes before the internet one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'md-watch-'));
    tmps.push(home);
    const e = await Engine.create({ home, inbox: join(home, 'inbox'), port: 0, discovery: false, alias: 'pc', hub: { ingressPort: 0 }, guest: { port: 0 }, localsend: false, lanAddrs: () => [{ host: '192.168.1.5', port: 0 }] });
    engines.push(e);
    await e.hubInit(['wss://hub.example.ts.net/mesh/v1/hub']);
    await e.start();
    const { code, links } = e.watchCreate('Wi-Fi first');
    expect(links).toEqual([expect.stringMatching(new RegExp(`^http://192\\.168\\.1\\.5:\\d+/w/${code}$`)), `https://hub.example.ts.net/w/${code}`]);
  });
});
