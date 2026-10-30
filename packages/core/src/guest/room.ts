// Room mode (M11): at a party or in a classroom, everyone scans one QR and gets a shared drop board on
// this device's LAN guest server (plain HTTP, like guest links). Anyone with the link may post files
// and download what others posted, until the room ends (then everything in it is deleted).
//   GET  /r/<token>                          the board page
//   GET  /r/app.js, /r/app.css               its assets
//   GET  /r/api/<token>/posts                {title, expiresAt, posts:[{id, name, size, by, at, image}]}
//   POST /r/api/<token>/posts?name=&by=      the file's bytes (X-Room: 1)  -> 201 {id}
//   GET  /r/api/<token>/posts/<id>           the file (?inline=1 for images shown in the page)
// A custom header on posts keeps other sites' pages from posting (it needs a CORS preflight, never granted).
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_ROOM_FILE = 200 * 1024 * 1024;
const MAX_ROOM_BYTES = 4 * 1024 ** 3;
const MAX_ROOM_POSTS = 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_RE = /^[A-Za-z0-9_-]{12}$/;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

export interface RoomPost { id: string; name: string; size: number; by: string; at: number; image: boolean }

const HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  const b = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...HEADERS, 'content-type': type, 'content-length': b.length });
  res.end(b);
}
const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), 'application/json; charset=utf-8');

/** A clean display name: no path, no control characters, at most 120 characters. */
function roomName(s: string, fallback: string): string {
  const n = s.replace(/[\u0000-\u001f\u007f/\\]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120);
  return n || fallback;
}

/** One room at a time: its files live in <dir>/<token>/ and go when it ends. */
export class Room {
  readonly token: string;
  readonly expiresAt: number;
  readonly title: string;
  readonly #dir: string;
  #posts: RoomPost[] = [];
  #bytes = 0;
  #onChange: () => void;

  private constructor(dir: string, token: string, title: string, expiresAt: number, onChange: () => void) {
    this.#dir = dir;
    this.token = token;
    this.title = title;
    this.expiresAt = expiresAt;
    this.#onChange = onChange;
  }

  static async open(root: string, title: string, ttlMs: number, onChange: () => void): Promise<Room> {
    await fsp.rm(root, { recursive: true, force: true }); // a room never outlives its process
    const token = randomBytes(16).toString('base64url');
    const dir = join(root, token);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return new Room(dir, token, title, Date.now() + ttlMs, onChange);
  }

  get live(): boolean {
    return Date.now() < this.expiresAt;
  }

  posts(): RoomPost[] {
    return this.#posts.map((p) => ({ ...p }));
  }

  pathOf(id: string): string | null {
    return ID_RE.test(id) && this.#posts.some((p) => p.id === id) ? join(this.#dir, id) : null;
  }

  /** Adds a post from a stream (a browser's upload, or the host's own file). */
  async add(name: string, by: string, body: NodeJS.ReadableStream, sizeHint?: number): Promise<RoomPost> {
    if (this.#posts.length >= MAX_ROOM_POSTS) throw Object.assign(new Error('full'), { status: 507 });
    if (sizeHint !== undefined && (sizeHint > MAX_ROOM_FILE || this.#bytes + sizeHint > MAX_ROOM_BYTES)) throw Object.assign(new Error('too-large'), { status: 413 });
    const id = randomBytes(9).toString('base64url');
    const p = join(this.#dir, id);
    let size = 0;
    try {
      await pipeline(
        body,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const c of src) {
            size += c.length;
            if (size > MAX_ROOM_FILE) throw Object.assign(new Error('too-large'), { status: 413 });
            yield c;
          }
        },
        createWriteStream(p, { mode: 0o600 }),
      );
    } catch (e) {
      await fsp.rm(p, { force: true });
      throw e;
    }
    if (this.#bytes + size > MAX_ROOM_BYTES) {
      await fsp.rm(p, { force: true });
      throw Object.assign(new Error('full'), { status: 507 });
    }
    this.#bytes += size;
    const post: RoomPost = { id, name: roomName(name, 'file'), size, by: roomName(by, 'Someone').slice(0, 40), at: Date.now(), image: IMAGE_RE.test(name) };
    this.#posts.unshift(post);
    this.#onChange();
    return post;
  }

  async close(): Promise<void> {
    this.#posts = [];
    await fsp.rm(this.#dir, { recursive: true, force: true });
  }

  /** The /r/ routes; false when the request is not for the room. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, page: { html: string; js: string; css: string }): Promise<boolean> {
    const seg = url.pathname.split('/').slice(1);
    if (seg[0] !== 'r') return false;
    const method = req.method ?? 'GET';
    if (method === 'GET' && seg.length === 2 && seg[1] === 'app.js') return send(res, 200, page.js, 'text/javascript; charset=utf-8'), true;
    if (method === 'GET' && seg.length === 2 && seg[1] === 'app.css') return send(res, 200, page.css, 'text/css; charset=utf-8'), true;
    const token = seg[1] === 'api' ? seg[2] : seg[1];
    if (!token || !TOKEN_RE.test(token) || token !== this.token) return json(res, 404, { error: 'not-found' }), true;
    if (!this.live) return json(res, 410, { error: 'expired' }), true;
    if (method === 'GET' && seg.length === 2) return send(res, 200, page.html.split('{{TOKEN}}').join(token), 'text/html; charset=utf-8'), true;
    const api = seg.slice(3);
    if (seg[1] !== 'api' || api[0] !== 'posts') return json(res, 404, { error: 'not-found' }), true;
    if (method === 'GET' && api.length === 1) return json(res, 200, { title: this.title, expiresAt: this.expiresAt, posts: this.posts() }), true;
    if (method === 'POST' && api.length === 1) {
      if (req.headers['x-room'] !== '1') return json(res, 403, { error: 'forbidden' }), true;
      const len = Number(req.headers['content-length']);
      try {
        const p = await this.add(url.searchParams.get('name') ?? 'file', url.searchParams.get('by') ?? 'Someone', req, Number.isFinite(len) ? len : undefined);
        json(res, 201, { id: p.id });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        res.setHeader('connection', 'close');
        json(res, status, { error: status === 413 ? 'too-large' : status === 507 ? 'full' : 'failed' });
      }
      return true;
    }
    if (method === 'GET' && api.length === 2) {
      const post = this.#posts.find((p) => p.id === api[1]);
      const path = post && this.pathOf(post.id);
      if (!post || !path) return json(res, 404, { error: 'not-found' }), true;
      const inline = url.searchParams.get('inline') === '1' && post.image;
      res.writeHead(200, {
        ...HEADERS,
        'content-type': inline ? `image/${/\.png$/i.test(post.name) ? 'png' : /\.gif$/i.test(post.name) ? 'gif' : /\.webp$/i.test(post.name) ? 'webp' : 'jpeg'}` : 'application/octet-stream',
        'content-length': post.size,
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(post.name)}`,
      });
      createReadStream(path).on('error', () => res.destroy()).pipe(res);
      return true;
    }
    return json(res, 404, { error: 'not-found' }), true;
  }
}
