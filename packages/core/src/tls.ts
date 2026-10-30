import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { pipeline, type Readable } from 'node:stream';
import { connect, type TLSSocket, type TlsOptions } from 'node:tls';
import { deviceIdOf, type Identity } from './identity.ts';

/** Default time allowed for TCP connect + TLS handshake + pin check. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Default idle timeout for a pinnedRequest (resets on any socket activity). */
const DEFAULT_REQUEST_IDLE_TIMEOUT_MS = 30_000;
/**
 * Errors that hit a pinned socket between connectPinned() and pinnedRequest(). Without a listener
 * a peer RST in that gap would be an unhandled 'error' event and crash the process.
 */
const socketErrors = new WeakMap<TLSSocket, Error>();
/** Responses on this channel are small JSON/status bodies; refuse anything larger. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The peer's certificate did not hash to the device id we expected (or it sent none). */
export class PinMismatchError extends Error {
  readonly expected: string;
  /** Device id the peer actually presented, or null if it presented no certificate. */
  readonly actual: string | null;
  constructor(expected: string, actual: string | null) {
    super(`TLS pin mismatch: expected device ${expected}, peer presented ${actual ?? 'no certificate'}`);
    this.name = 'PinMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * TLS options for the mesh HTTPS server. Peers authenticate with self-signed certificates, so
 * there is no CA to validate against: we request the client's certificate but accept any, and
 * the application decides trust from `peerDeviceId(sock)` against the TrustStore.
 */
export function serverTlsOptions(id: Identity): TlsOptions {
  return {
    key: id.keyPem,
    cert: id.certPem,
    requestCert: true,
    // Self-signed peers can never pass CA validation; trust is decided by device-id pinning.
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  };
}

/** Device id of the peer's certificate, or null if the peer sent none. */
export function peerDeviceId(sock: TLSSocket): string | null {
  const cert = sock.getPeerCertificate(true);
  // An absent certificate is reported as an empty object.
  if (!cert || !cert.raw || cert.raw.length === 0) return null;
  return deviceIdOf(cert.raw);
}

export interface ConnectPinnedOptions {
  /** Abort if connect + handshake + pin check take longer than this (default 10 000 ms). */
  timeoutMs?: number;
}

/**
 * Opens a mutual-TLS connection presenting `id`'s certificate and resolves only once the
 * server's certificate hashes to `expectedDeviceId`. On mismatch the socket is destroyed on
 * 'secureConnect', before this function hands the socket back, so no application byte is ever
 * written to an unverified peer.
 *
 * The returned socket keeps an 'error' listener that records the error, so a peer reset before
 * the first request cannot crash the process; `pinnedRequest` rejects with the recorded error.
 * The caller (normally `pinnedRequest`) owns the socket from then on.
 */
export function connectPinned(
  host: string,
  port: number,
  id: Identity,
  expectedDeviceId: string,
  opts: ConnectPinnedOptions = {},
): Promise<TLSSocket> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise<TLSSocket>((resolve, reject) => {
    const sock = connect({
      host,
      port,
      key: id.keyPem,
      cert: id.certPem,
      minVersion: 'TLSv1.3',
      // Peer certs are self-signed, so CA and hostname validation cannot succeed; pinning the
      // certificate's SHA-256 (checked in the 'secureConnect' handler below) replaces both.
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('error', onError);
      sock.removeListener('secureConnect', onSecure);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      sock.on('error', () => {}); // swallow late errors from the dying socket
      sock.destroy();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    const onSecure = () => {
      let actual: string | null;
      try {
        actual = peerDeviceId(sock);
      } catch (e) {
        return fail(e as Error);
      }
      if (actual !== expectedDeviceId) return fail(new PinMismatchError(expectedDeviceId, actual));
      settled = true;
      cleanup();
      sock.on('error', (e) => socketErrors.set(sock, e));
      // live sound and camera frames go out as written, not held back to fill a packet (set once the
      // pinned handshake is done, never on a socket still connecting)
      sock.setNoDelay(true);
      resolve(sock);
    };
    const timer = setTimeout(
      () => fail(new Error(`connection to ${host}:${port} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );

    sock.on('error', onError);
    sock.on('secureConnect', onSecure);
  });
}

export interface PinnedResponse {
  status: number;
  /** Parsed body when the response content-type is application/json. */
  json?: unknown;
  body: Buffer;
}

export interface PinnedRequestOptions {
  /** Idle timeout in ms, reset by any socket activity (default 30 000). */
  timeoutMs?: number;
  /** Aborts the request: the socket is destroyed and the promise rejects with an AbortError. */
  signal?: AbortSignal;
}

function abortError(): Error {
  const e = new Error('request aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Performs ONE HTTP/1.1 request over an already-pinned socket and resolves with the full
 * response. The socket is single-use: we pass no agent (Node then sends `Connection: close`) and
 * destroy the socket when the request settles, so callers open a fresh `connectPinned` per
 * request. That costs one handshake per ~4 MiB chunk, which is negligible, and removes any
 * keep-alive reuse/ordering hazards.
 *
 * `body` may be a Buffer (Content-Length set automatically) or a Readable (streamed; chunked
 * unless the caller passes a `content-length` header).
 *
 * `opts.timeoutMs` is an idle timeout (any socket read/write resets it); on timeout or abort the
 * socket is destroyed and the promise rejects.
 */
export function pinnedRequest(
  sock: TLSSocket,
  method: string,
  path: string,
  body?: Buffer | Readable,
  headers: Record<string, string | number> = {},
  opts: PinnedRequestOptions = {},
): Promise<PinnedResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_IDLE_TIMEOUT_MS;
  const { signal } = opts;
  const preError = socketErrors.get(sock) ?? (signal?.aborted ? abortError() : undefined);
  if (preError || sock.destroyed) {
    sock.destroy();
    if (body && !Buffer.isBuffer(body)) body.destroy();
    return Promise.reject(preError ?? new Error('socket closed before request'));
  }
  return new Promise<PinnedResponse>((resolve, reject) => {
    const hostHeader = sock.remoteAddress
      ? `${sock.remoteAddress.includes(':') ? `[${sock.remoteAddress}]` : sock.remoteAddress}:${sock.remotePort}`
      : 'meshdrop';
    const req = request({
      method,
      path,
      // No `agent`: with createConnection and no agent, Node uses the socket directly and sends
      // `Connection: close`. (`agent: false` would route through a fresh Agent and ignore createConnection.)
      createConnection: () => sock,
      headers: { host: hostHeader, ...headers },
    });

    let done = false;
    const finish = (err: Error | null, res?: PinnedResponse) => {
      if (done) return;
      done = true;
      sock.setTimeout(0);
      sock.removeListener('timeout', onTimeout);
      signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      if (err && body && !Buffer.isBuffer(body)) body.destroy();
      if (err) reject(err);
      else resolve(res!);
    };

    const onTimeout = () => finish(new Error(`request timed out after ${timeoutMs} ms of inactivity`));
    const onAbort = () => finish(abortError());
    sock.setTimeout(timeoutMs);
    sock.on('timeout', onTimeout);
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (e) => finish(e));
    req.on('response', (res: IncomingMessage) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish(new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        parts.push(d);
      });
      res.on('error', (e) => finish(e));
      res.on('aborted', () => finish(new Error('response aborted')));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        const out: PinnedResponse = { status: res.statusCode ?? 0, body: buf };
        const ct = String(res.headers['content-type'] ?? '');
        if (/^application\/json\b/i.test(ct) && buf.length > 0) {
          try {
            out.json = JSON.parse(buf.toString('utf8'));
          } catch {
            return finish(new Error('invalid JSON in application/json response'));
          }
        }
        finish(null, out);
      });
    });

    if (body === undefined) req.end();
    else if (Buffer.isBuffer(body)) req.end(body);
    else {
      // a live stream may have no bytes yet: send the headers now, so the peer can answer (or refuse) at once
      req.flushHeaders();
      pipeline(body, req, (err) => {
        if (err) finish(err);
      });
    }
  });
}
