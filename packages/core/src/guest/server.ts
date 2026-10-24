// The LAN guest server (M5a): plain HTTP (browsers reject the devices' self-signed certificates),
// gated by the one-time token in the QR and the cookie its first browser gets. Only /g/ exists.
//   GET  /g/<token>                    the page (claims the token)
//   GET  /g/app.js, /g/app.css         page assets
//   GET  /g/api/session                {expiresAt, owner}
//   GET  /g/api/shared                 [{id, name, size}]   files the owner offers
//   GET  /g/api/shared/<id>            one of them (single-range Range supported; ?t=<token> allowed)
//   POST /g/api/offers                 {files:[{name,size,type?,thumb?}], text?} -> 201 {id, status}
//   GET  /g/api/offers/<id>            {status, files:[{name,size,received}]}
//   PUT  /g/api/offers/<id>/<i>?offset=N   one slice (at most 4 MiB) -> {received}
// API calls carry the token in X-Guest-Token plus the cookie; a custom header also keeps other sites'
// pages from calling the API (it needs a CORS preflight, which is never granted).
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GuestBook } from './book.ts';
import { GuestError, type GuestUploads } from './uploads.ts';

export interface SharedFile { id: string; name: string; size: number; path: string }

export interface GuestServerOptions {
  book: GuestBook;
  /** The live session's uploads (null: no session). */
  uploads: () => GuestUploads | null;
  shared: () => SharedFile[];
  alias: () => string;
  /** The page; `{{TOKEN}}` in the HTML is replaced with the session token. */
  page: { html: string; js: string; css: string };
}

const MAX_OFFER_JSON = 8 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const COOKIE = 'mdg';

const HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string | number> = {}): void {
  const b = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...HEADERS, 'content-type': type, 'content-length': b.length, ...extra });
  res.end(b);
}

const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), 'application/json; charset=utf-8');

function cookieOf(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_OFFER_JSON) throw new GuestError(413, 'too-large');
    parts.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new GuestError(400, 'bad-offer');
  }
}

const GONE: Record<string, string> = {
  used: 'This link was already opened in another browser. Ask for a new QR code.',
  expired: 'This link has expired. Ask for a new QR code.',
  unknown: 'This link is not valid. Ask for a new QR code.',
};

function serveFile(req: IncomingMessage, res: ServerResponse, f: SharedFile): void {
  const disp = `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  const type = 'application/octet-stream';
  let start = 0;
  let end = f.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range !== undefined) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    const a = m?.[1] ? Number(m[1]) : NaN;
    const b = m?.[2] ? Number(m[2]) : NaN;
    if (m && !Number.isNaN(a)) {
      start = a;
      end = Number.isNaN(b) ? f.size - 1 : Math.min(b, f.size - 1);
    } else if (m && !Number.isNaN(b)) {
      start = Math.max(0, f.size - b);
    } else {
      start = f.size; // malformed: not satisfiable
    }
    if (start >= f.size || start > end) {
      res.writeHead(416, { ...HEADERS, 'content-range': `bytes */${f.size}` });
      res.end();
      return;
    }
    status = 206;
  }
  const len = f.size === 0 ? 0 : end - start + 1;
  const head: Record<string, string | number> = { ...HEADERS, 'content-type': type, 'content-length': len, 'content-disposition': disp, 'accept-ranges': 'bytes' };
  if (status === 206) head['content-range'] = `bytes ${start}-${end}/${f.size}`;
  if (len === 0) {
    res.writeHead(status, head);
    res.end();
    return;
  }
  const s = createReadStream(f.path, { start, end });
  s.on('error', () => {
    if (!res.headersSent) json(res, 404, { error: 'not-found' });
    else res.destroy();
  });
  s.once('open', () => res.writeHead(status, head));
  s.pipe(res);
}

export function createGuestServer(o: GuestServerOptions): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://guest');
    const seg = url.pathname.split('/').slice(1);
    const method = req.method ?? 'GET';
    if (seg[0] !== 'g') return json(res, 404, { error: 'not-found' });
    if (method === 'GET' && seg.length === 2 && seg[1] === 'app.js') return send(res, 200, o.page.js, 'text/javascript; charset=utf-8');
    if (method === 'GET' && seg.length === 2 && seg[1] === 'app.css') return send(res, 200, o.page.css, 'text/css; charset=utf-8');
    if (method === 'GET' && seg.length === 2 && TOKEN_RE.test(seg[1]!)) {
      const c = o.book.claim(seg[1]!, cookieOf(req));
      if (!c.ok) return send(res, c.error === 'unknown' ? 404 : 410, GONE[c.error]!, 'text/plain; charset=utf-8');
      return send(res, 200, o.page.html.split('{{TOKEN}}').join(seg[1]!), 'text/html; charset=utf-8', {
        'set-cookie': `${COOKIE}=${c.cookie}; Path=/g; HttpOnly; SameSite=Strict`,
      });
    }
    if (seg[1] !== 'api') return json(res, 404, { error: 'not-found' });
    // A plain download link cannot send a header: downloads also take the token as ?t= (cookie still required).
    const isDownload = method === 'GET' && seg.length === 4 && seg[2] === 'shared';
    const token = req.headers['x-guest-token'] ?? (isDownload ? (url.searchParams.get('t') ?? undefined) : undefined);
    const st = typeof token === 'string' ? o.book.check(token, cookieOf(req)) : 'unknown';
    if (st !== 'ok') return json(res, st === 'unknown' ? 404 : 410, { error: st === 'unknown' ? 'not-found' : st });
    const uploads = o.uploads();
    const api = seg.slice(2);
    if (method === 'GET' && api.length === 1 && api[0] === 'session') return json(res, 200, { expiresAt: o.book.current()?.expiresAt ?? 0, owner: o.alias() });
    if (method === 'GET' && api[0] === 'shared' && api.length === 1) return json(res, 200, o.shared().map(({ id, name, size }) => ({ id, name, size })));
    if (method === 'GET' && api[0] === 'shared' && api.length === 2) {
      const f = o.shared().find((x) => x.id === api[1]);
      if (!f) return json(res, 404, { error: 'not-found' });
      return serveFile(req, res, f);
    }
    if (!uploads) return json(res, 410, { error: 'expired' });
    if (method === 'POST' && api.length === 1 && api[0] === 'offers') return json(res, 201, uploads.offer(await readJson(req)));
    if (method === 'GET' && api.length === 2 && api[0] === 'offers') return json(res, 200, uploads.status(api[1]!));
    if (method === 'PUT' && api.length === 3 && api[0] === 'offers') {
      const offset = Number(url.searchParams.get('offset'));
      if (!/^\d+$/.test(api[2]!) || !Number.isSafeInteger(offset)) return json(res, 400, { error: 'bad-request' });
      return json(res, 200, { received: await uploads.write(api[1]!, Number(api[2]), offset, req) });
    }
    return json(res, 404, { error: 'not-found' });
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof GuestError) {
        if (e.status === 413) res.setHeader('connection', 'close');
        json(res, e.status, { error: e.code, ...e.extra });
      } else json(res, 500, { error: 'internal' });
    });
  });
  server.on('clientError', (_e, sock) => sock.destroy());
  return server;
}
