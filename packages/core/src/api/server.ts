// Receiver HTTP API (protocol v1) over node:https: a thin adapter around the transport-independent
// handler (handler.ts). The TLS layer accepts any client certificate; the peer passed to the
// handler is peerDeviceId(socket), and the handler enforces trust and session ownership.
import { createServer, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { peerDeviceId, serverTlsOptions } from '../tls.ts';
import { createMeshHandler, type MeshServerOptions } from './handler.ts';

export {
  MAX_CHUNK_BODY,
  MAX_OFFER_BODY,
  type MeshServerOptions,
  type ReceiverEvent,
  type TrustSource,
} from './handler.ts';

export function createMeshServer(opts: MeshServerOptions): Server {
  const handler = createMeshHandler(opts);
  // Strangers can reach this port: a slow or silent peer must not hold a connection for long.
  const server = createServer({ ...serverTlsOptions(opts.id), handshakeTimeout: 10_000, connectionsCheckingInterval: 2_000 }, (req, res) => {
    // Live streams (M10b) bypass the request/answer handler: they last as long as they play.
    if (opts.stream && (req.url ?? '').startsWith('/mesh/v1/stream/')) {
      const peer = peerDeviceId(req.socket as TLSSocket);
      const u = new URL(req.url ?? '/', 'https://meshdrop');
      const fail = (status: number, error: string) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error }));
      };
      if (peer === null || !opts.trust.isTrusted(peer)) return fail(403, 'untrusted');
      req.socket.setTimeout(0);
      if (!opts.stream({ peer, method: req.method ?? 'GET', path: u.pathname.slice('/mesh/v1/stream/'.length), query: u.searchParams, req, res })) fail(404, 'not-found');
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    void handler
      .handle({
        peer: peerDeviceId(req.socket as TLSSocket),
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers,
        body: req,
      })
      .then((r) => {
        if (r.noReply || res.headersSent || res.writableEnded) return;
        const out: Record<string, string | number> = { ...r.headers };
        if (r.body.length > 0) out['content-length'] = r.body.length;
        if (r.close) {
          out['connection'] = 'close';
          // Stop the upload: close once the response is flushed.
          res.once('finish', () => req.socket.destroy());
        }
        res.writeHead(r.status, out);
        res.end(r.body);
      });
  });
  // A client that disconnects or botches the handshake must never surface as an uncaught error.
  server.on('tlsClientError', () => {});
  server.headersTimeout = 10_000;
  // No cap on a whole request (live streams last long); a connection silent for 2 minutes is closed instead.
  server.requestTimeout = 0;
  server.timeout = 120_000;
  server.maxConnections = 256;
  return server;
}
