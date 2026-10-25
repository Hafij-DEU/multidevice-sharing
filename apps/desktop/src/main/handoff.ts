// The browser extension's door into the app (M13): HTTP on 127.0.0.1 only, and only for requests
// from a browser extension (Origin chrome-extension:// or moz-extension://): a web page cannot use it.
//   POST /state   the active tab's place {url, title, scroll, text, time, playing}
//   POST /poll    waits (25 s) for a command: {type:'snapshot'} | {type:'open', url, scroll, time} | {}
//   GET  /status  {devices:[{deviceId, alias}]}: phones the popup can send to
//   POST /send    {to, state}: "continue on this phone"
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const HANDOFF_PORT = 53321;
const POLL_MS = 25_000;

export interface HandoffHooks {
  state(s: unknown): void;
  /** The extension waits for a command; resolve one, or {} after the poll time. */
  nextCommand(timeoutMs: number): Promise<Record<string, unknown>>;
  devices(): { deviceId: string; alias: string }[];
  send(to: string, state: unknown): Promise<boolean>;
}

const fromExtension = (req: IncomingMessage) => /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(req.headers.origin ?? '');

async function body(req: IncomingMessage): Promise<unknown> {
  let n = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 64 * 1024) throw new Error('too large');
    parts.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

export function startHandoffServer(h: HandoffHooks, port = HANDOFF_PORT): Promise<Server | null> {
  const server = createServer((req, res) => {
    const reply = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(v));
    };
    if (!fromExtension(req)) return reply(403, { error: 'extensions only' });
    void (async () => {
      try {
        if (req.method === 'POST' && req.url === '/state') {
          h.state(await body(req));
          return reply(200, { ok: true });
        }
        if (req.method === 'POST' && req.url === '/poll') {
          await body(req);
          return reply(200, await h.nextCommand(POLL_MS));
        }
        if (req.method === 'GET' && req.url === '/status') return reply(200, { devices: h.devices() });
        if (req.method === 'POST' && req.url === '/send') {
          const b = (await body(req)) as { to?: unknown; state?: unknown };
          if (typeof b.to !== 'string') return reply(400, { error: 'bad request' });
          return reply((await h.send(b.to, b.state)) ? 200 : 502, {});
        }
        reply(404, { error: 'not found' });
      } catch {
        if (!res.headersSent) reply(400, { error: 'bad request' });
      }
    })();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  return new Promise((resolve) => {
    server.once('error', () => resolve(null)); // the port is taken (another MeshDrop): no handoff here
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
