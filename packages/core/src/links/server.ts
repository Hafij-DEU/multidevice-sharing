// Internet guest link routes (M5b), served on the hub's loopback ingress (what a tunnel points at):
//   GET  /l/<id>                         the page (the key stays in the URL fragment, never sent here)
//   GET  /l/app.js, /l/app.css
//   GET  /l/<id>/api/info                {needsPassword}
//   POST /l/<id>/api/open                {password?} (+ X-Link-Key to send files back) -> {session, allowUploads}
//   POST /l/<id>/api/key                 X-Link-Key: only to send files back (uploads)
//   GET  /l/<id>/api/manifest            sealed manifest          (X-Link-Session)
//   GET  /l/<id>/api/chunk/<f>/<n>       sealed chunk             (X-Link-Session)
//   POST /l/<id>/api/offers              sealed offer JSON        (X-Link-Session; uploads only)
//   GET  /l/<id>/api/offers/<oid>        {status, files}
//   PUT  /l/<id>/api/offers/<oid>/<i>?offset=N   one sealed 4 MiB slice (offset a multiple of 4 MiB)
// Downloads never need the key here; uploads do (the hub is the owner's device and decrypts them).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { GuestError, type GuestUploads } from '../guest/uploads.ts';
import { keyHash, LINK_CHUNK, LinkCryptoError, OFFER_FILE, openChunk, UPLOAD_BASE, UPLOAD_SALT_BYTES, uploadKey } from './crypto.ts';
import { LinkError, type LinkStore } from './store.ts';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_OPEN_JSON = 4096;
const MAX_SEALED_OFFER = 2 * 1024 * 1024 + 16;

export interface LinkHandlerOptions {
  store: LinkStore;
  /** The upload store for a link (null: uploads unavailable). */
  uploads: (linkId: string) => GuestUploads | null;
  page: { html: string; js: string; css: string };
}

function headers(req: IncomingMessage): Record<string, string> {
  const h: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  };
  if (req.headers['x-forwarded-proto'] === 'https') h['strict-transport-security'] = 'max-age=31536000';
  return h;
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new LinkError(413, 'too-large');
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts);
}

/** Returns a request handler; it answers false for paths outside /l/ (the caller 404s them). */
/** Upload offer keys kept (oldest dropped first); far above what pending offers can be. */
const MAX_OFFER_KEYS = 1000;

export function createLinkHandler(o: LinkHandlerOptions): (req: IncomingMessage, res: ServerResponse) => boolean {
  /** Upload keys presented by open sessions (memory only: never on disk). */
  const keys = new Map<string, Buffer>();
  /** Each upload offer's own key (derived from the link key and the offer's salt), by offer id. */
  const offerKeys = new Map<string, Buffer>();

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const send = (status: number, body: Buffer | string, type: string) => {
      const b = typeof body === 'string' ? Buffer.from(body) : body;
      res.writeHead(status, { ...headers(req), 'content-type': type, 'content-length': b.length });
      res.end(b);
    };
    const json = (status: number, v: unknown) => send(status, JSON.stringify(v), 'application/json; charset=utf-8');
    const seg = url.pathname.split('/').slice(2); // after "/l"
    const method = req.method ?? 'GET';
    if (method === 'GET' && seg.length === 1 && seg[0] === 'app.js') return send(200, o.page.js, 'text/javascript; charset=utf-8');
    if (method === 'GET' && seg.length === 1 && seg[0] === 'app.css') return send(200, o.page.css, 'text/css; charset=utf-8');
    const id = seg[0] ?? '';
    if (!ID_RE.test(id)) return json(404, { error: 'not-found' });
    if (method === 'GET' && seg.length === 1) return send(200, o.page.html, 'text/html; charset=utf-8');
    if (seg[1] !== 'api') return json(404, { error: 'not-found' });
    const api = seg.slice(2);
    if (method === 'GET' && api.length === 1 && api[0] === 'info') return json(200, await o.store.info(id));
    if (method === 'POST' && api.length === 1 && api[0] === 'open') {
      let body: { password?: unknown } = {};
      const raw = await readBody(req, MAX_OPEN_JSON);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8')) as { password?: unknown };
        } catch {
          return json(400, { error: 'bad-request' });
        }
      }
      const r = await o.store.open(id, typeof body.password === 'string' ? body.password : undefined);
      const k = req.headers['x-link-key'];
      if (typeof k === 'string' && r.allowUploads) {
        const key = Buffer.from(k, 'base64url');
        if (key.length === 32 && keyHash(key) === r.keyHash) keys.set(r.session, key);
      }
      return json(200, { session: r.session, allowUploads: r.allowUploads && keys.has(r.session) });
    }
    const session = req.headers['x-link-session'];
    if (typeof session !== 'string') return json(401, { error: 'session' });
    if (method === 'POST' && api.length === 1 && api[0] === 'key') {
      // Only to send files back: downloads never hand the key to the hub.
      const kh = await o.store.uploadKeyHash(id, session);
      const k = req.headers['x-link-key'];
      const key = typeof k === 'string' ? Buffer.from(k, 'base64url') : Buffer.alloc(0);
      if (key.length !== 32 || keyHash(key) !== kh) return json(403, { error: 'bad-key' });
      keys.set(session, key);
      return json(200, { ok: true });
    }
    if (method === 'GET' && api.length === 1 && api[0] === 'manifest') return send(200, await o.store.manifest(id, session), 'application/octet-stream');
    if (method === 'GET' && api.length === 3 && api[0] === 'chunk' && /^\d+$/.test(api[1]!) && /^\d+$/.test(api[2]!)) {
      return send(200, await o.store.chunk(id, session, Number(api[1]), Number(api[2])), 'application/octet-stream');
    }
    if (api[0] !== 'offers') return json(404, { error: 'not-found' });
    // Uploads: the session must have presented the right key, and the link must still allow them.
    await o.store.uploadKeyHash(id, session);
    const key = keys.get(session);
    const uploads = o.uploads(id);
    if (!key) return json(403, { error: 'no-key' });
    if (!uploads) return json(503, { error: 'unavailable' });
    if (method === 'POST' && api.length === 1) {
      // Each offer brings its own salt: its offer and slices are sealed with a key of their own.
      const s = req.headers['x-upload-salt'];
      const salt = typeof s === 'string' ? Buffer.from(s, 'base64url') : Buffer.alloc(0);
      if (salt.length !== UPLOAD_SALT_BYTES) return json(400, { error: 'no-salt' });
      const upKey = uploadKey(key, id, salt);
      const plain = openChunk(upKey, id, OFFER_FILE, 0, true, await readBody(req, MAX_SEALED_OFFER));
      let offer: unknown;
      try {
        offer = JSON.parse(plain.toString('utf8'));
      } catch {
        return json(400, { error: 'bad-offer' });
      }
      const made = uploads.offer(offer);
      offerKeys.set(made.id, upKey);
      while (offerKeys.size > MAX_OFFER_KEYS) offerKeys.delete(offerKeys.keys().next().value as string);
      return json(201, made);
    }
    if (method === 'GET' && api.length === 2) return json(200, uploads.status(api[1]!));
    if (method === 'PUT' && api.length === 3 && /^\d+$/.test(api[2]!)) {
      const i = Number(api[2]);
      const offset = Number(url.searchParams.get('offset'));
      if (!Number.isSafeInteger(offset) || offset < 0 || offset % LINK_CHUNK !== 0) return json(400, { error: 'bad-request' });
      const st = uploads.status(api[1]!);
      const f = st.files[i];
      if (!f) return json(404, { error: 'not-found' });
      const sealed = await readBody(req, LINK_CHUNK + 16);
      const last = offset + Math.max(0, sealed.length - 16) >= f.size;
      const upKey = offerKeys.get(api[1]!);
      if (!upKey) return json(403, { error: 'no-key' });
      const plain = openChunk(upKey, id, UPLOAD_BASE + i, offset / LINK_CHUNK, last, sealed);
      return json(200, { received: await uploads.write(api[1]!, i, offset, Readable.from([plain])) });
    }
    return json(404, { error: 'not-found' });
  };

  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://hub');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith('/l/')) return false;
    handle(req, res, url).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      const [status, body]: [number, Record<string, unknown>] =
        e instanceof LinkError ? [e.status, { error: e.code }]
        : e instanceof GuestError ? [e.status, { error: e.code, ...e.extra }]
        : e instanceof LinkCryptoError ? [400, { error: 'bad-chunk' }]
        : [500, { error: 'internal' }];
      const b = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { ...headers(req), 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, ...(status === 413 ? { connection: 'close' } : {}) });
      res.end(b);
    });
    return true;
  };
}
