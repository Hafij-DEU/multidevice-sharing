// Watch party HTTP routes (M12), on the LAN guest server and the hub's internet ingress:
//   GET  /w/, /w/<CODE>                  the page (join box, or the room)
//   GET  /w/app.js, /w/app.css           its assets
//   GET  /w/api/time                     {now}: clients measure their offset from the server clock
//   GET  /w/api/<CODE>                   {name} or 404 (the app checks a code before opening it)
//   GET  /w/api/<CODE>/events?m=&n=&h=   Server-Sent Events: hello, state, members, chat, room, ended
//   POST /w/api/<CODE>/cmd               {m, h?, type, ...} (X-Watch: 1)  -> {state}
//   POST /w/api/<CODE>/upload?m=&h=&name=  a video from the host's device (host only, X-Watch: 1)
//   GET  /w/media/<CODE>/<id>            a room video (Range); drive-<ID>: a public Google Drive file, relayed
// A custom header on writes keeps other sites' pages from posting (it needs a CORS preflight, never granted).
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CODE_RE, WatchError, type WatchRooms } from './rooms.ts';

export const MAX_UPLOAD = 8 * 1024 ** 3;
const MEMBER_RE = /^[A-Za-z0-9_-]{8,40}$/;
const MISS_WINDOW_MS = 60_000;
const MAX_MISSES = 20;

const HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin', // YouTube embeds need to know the page they play on
};

/** The page's own rules: our scripts, plus YouTube's player (script and frame). */
const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; " +
  "img-src 'self' data: https://i.ytimg.com; media-src 'self' https: http: blob:; style-src 'self'; connect-src 'self'; frame-ancestors 'self'";

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  const b = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...HEADERS, 'content-type': type, 'content-length': String(b.length), ...extra });
  res.end(b);
}
const json = (res: ServerResponse, status: number, v: unknown, extra: Record<string, string> = {}) => send(res, status, JSON.stringify(v), 'application/json; charset=utf-8', extra);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let n = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 16 * 1024) throw new WatchError(413, 'too-large');
    parts.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* below */
  }
  throw new WatchError(400, 'bad-json');
}

/** Serves a file with single-range support (players seek with Range). */
async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, size: number, name: string): Promise<void> {
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else start = Math.max(0, size - Number(m[2]));
    if (start >= size || start > end) {
      res.writeHead(416, { ...HEADERS, 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const type = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4' }[ext ?? ''] ?? 'application/octet-stream';
  const head: Record<string, string> = { ...HEADERS, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size === 0 ? 0 : end - start + 1) };
  if (status === 206) head['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, head);
  if (size === 0 || req.method === 'HEAD') return void res.end();
  createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
}

/**
 * Relays a public Google Drive file: Drive's share links open a web page, not the video, so the room
 * server asks Drive for the file itself and passes it on, Range and all.
 */
async function serveDrive(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (req.headers.range) headers.range = req.headers.range;
  const r = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, { headers, redirect: 'follow' });
  const type = r.headers.get('content-type') ?? '';
  if (!r.ok || type.startsWith('text/html')) {
    await r.body?.cancel();
    return json(res, 403, { error: 'drive-not-public' });
  }
  const out: Record<string, string> = { ...HEADERS, 'content-type': type || 'video/mp4', 'accept-ranges': 'bytes' };
  for (const h of ['content-length', 'content-range']) {
    const v = r.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(r.status, out);
  if (!r.body) return void res.end();
  await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), res).catch(() => res.destroy());
}

export interface WatchHandlerOptions {
  rooms: WatchRooms;
  page: { html: string; js: string; css: string };
}

/** The /w/ routes; false when the request is not for them. */
export function createWatchHandler(o: WatchHandlerOptions): (req: IncomingMessage, res: ServerResponse) => boolean {
  const misses = new Map<string, number[]>();
  /** A guessed code costs: a few wrong codes a minute per address, no more. */
  const miss = (req: IncomingMessage): boolean => {
    const ip = req.socket.remoteAddress ?? '';
    const now = Date.now();
    const list = (misses.get(ip) ?? []).filter((t) => now - t < MISS_WINDOW_MS);
    list.push(now);
    misses.set(ip, list);
    if (misses.size > 10_000) misses.clear();
    return list.length > MAX_MISSES;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const seg = url.pathname.split('/').slice(2); // after /w
    const method = req.method ?? 'GET';
    if (method === 'GET' && seg.length === 1 && seg[0] === 'app.js') return send(res, 200, o.page.js, 'text/javascript; charset=utf-8');
    if (method === 'GET' && seg.length === 1 && seg[0] === 'app.css') return send(res, 200, o.page.css, 'text/css; charset=utf-8');
    if (method === 'GET' && seg.length === 1 && (seg[0] === '' || CODE_RE.test(seg[0]!.toUpperCase()))) {
      return send(res, 200, o.page.html, 'text/html; charset=utf-8', { 'content-security-policy': PAGE_CSP });
    }
    if (seg[0] === 'media' && seg.length === 3 && (method === 'GET' || method === 'HEAD')) {
      const room = o.rooms.get(seg[1]!);
      if (!room) return json(res, 404, { error: 'not-found' });
      const id = seg[2]!;
      const drive = /^drive-([A-Za-z0-9_-]{10,})$/.exec(id);
      if (drive) {
        // only the Drive file the room is playing: the server is not an open relay
        if (room.state.source?.kind !== 'video' || room.state.source.url !== `/w/media/${room.code}/${id}`) return json(res, 404, { error: 'not-found' });
        return serveDrive(req, res, drive[1]!);
      }
      const f = room.media.get(id);
      if (!f) return json(res, 404, { error: 'not-found' });
      return serveFile(req, res, f.path, f.size, f.name);
    }
    if (seg[0] !== 'api') return json(res, 404, { error: 'not-found' });
    if (method === 'GET' && seg.length === 2 && seg[1] === 'time') return json(res, 200, { now: Date.now() });
    const room = seg[1] && CODE_RE.test(seg[1].toUpperCase()) ? o.rooms.get(seg[1]) : undefined;
    if (!room) {
      if (miss(req)) return json(res, 429, { error: 'slow-down' });
      return json(res, 404, { error: 'no-such-room' }, { 'access-control-allow-origin': '*' });
    }
    if (method === 'GET' && seg.length === 2) return json(res, 200, { code: room.code, name: room.name }, { 'access-control-allow-origin': '*' });
    const q = url.searchParams;
    if (method === 'GET' && seg.length === 3 && seg[2] === 'events') {
      const m = q.get('m') ?? '';
      if (!MEMBER_RE.test(m)) return json(res, 400, { error: 'bad-member' });
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      req.socket.setTimeout(0);
      room.attach(m, (q.get('n') ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'Guest', room.isHost(q.get('h')), res);
      return;
    }
    if (req.headers['x-watch'] !== '1') return json(res, 403, { error: 'forbidden' });
    if (method === 'POST' && seg.length === 3 && seg[2] === 'cmd') {
      const c = await readJson(req);
      return json(res, 200, { state: room.command(String(c.m ?? ''), c.h, c) });
    }
    if (method === 'POST' && seg.length === 3 && seg[2] === 'upload') {
      if (!room.isHost(q.get('h'))) return json(res, 403, { error: 'host-only' });
      const len = Number(req.headers['content-length']);
      if (Number.isFinite(len) && len > MAX_UPLOAD) return json(res, 413, { error: 'too-large' });
      const name = (q.get('name') ?? 'video').replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 120) || 'video';
      const dir = o.rooms.mediaDir(room.code);
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomBytes(9).toString('base64url');
      const path = join(dir, id);
      let size = 0;
      try {
        await pipeline(
          req,
          async function* (src: AsyncIterable<Buffer>) {
            for await (const c of src) {
              size += c.length;
              if (size > MAX_UPLOAD) throw new WatchError(413, 'too-large');
              yield c;
            }
          },
          createWriteStream(path, { mode: 0o600 }),
        );
      } catch (e) {
        await fsp.rm(path, { force: true });
        throw e;
      }
      room.media.set(id, { path, name, size, owned: true });
      return json(res, 201, { id, state: room.playMedia(id, q.get('m') ?? '') });
    }
    return json(res, 404, { error: 'not-found' });
  };

  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://room');
    } catch {
      return false;
    }
    if (url.pathname !== '/w' && !url.pathname.startsWith('/w/')) return false;
    if (url.pathname === '/w') {
      res.writeHead(301, { location: '/w/' });
      res.end();
      return true;
    }
    handle(req, res, url).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof WatchError) json(res, e.status, { error: e.code });
      else json(res, 500, { error: 'internal' });
    });
    return true;
  };
}
