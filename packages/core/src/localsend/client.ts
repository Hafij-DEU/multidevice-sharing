// LocalSend v2 (M6), sending side: prepare-upload with our info, then one upload per file. The peer's
// TLS certificate must match the fingerprint it announced (LocalSend: SHA-256 of the certificate).
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename } from 'node:path';
import type { TLSSocket } from 'node:tls';
import type { LsPeerInfo } from './discovery.ts';
import type { LsInfo } from './server.ts';

export class LocalSendError extends Error {
  readonly code: 'declined' | 'busy' | 'fingerprint' | 'failed';
  constructor(code: LocalSendError['code'], message: string) {
    super(message);
    this.name = 'LocalSendError';
    this.code = code;
  }
}

interface Res { status: number; body: string }

function call(peer: LsPeerInfo, method: string, path: string, body: Buffer | NodeJS.ReadableStream | string | undefined, contentType: string, timeoutMs: number): Promise<Res> {
  return new Promise((resolve, reject) => {
    const opts = { host: peer.host, port: peer.port, method, path, headers: { 'content-type': contentType }, timeout: timeoutMs };
    const onRes = (res: IncomingMessage) => {
      if (peer.protocol === 'https') {
        const cert = (res.socket as TLSSocket).getPeerCertificate?.();
        const fp = cert?.raw ? createHash('sha256').update(cert.raw).digest('hex') : '';
        if (fp.toLowerCase() !== peer.fingerprint.toLowerCase()) {
          res.destroy();
          return reject(new LocalSendError('fingerprint', 'the device presented another certificate than it announced'));
        }
      }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (b += c.length + b.length < 1_000_000 ? c : ''));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    };
    const req = peer.protocol === 'https' ? httpsRequest({ ...opts, rejectUnauthorized: false }, onRes) : httpRequest(opts, onRes);
    req.on('timeout', () => req.destroy(new LocalSendError('failed', 'timed out')));
    req.on('error', reject);
    if (body === undefined || typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
    else (body as NodeJS.ReadableStream).pipe(req);
  });
}

/** Registers with a peer that announced itself (so it sees us); true on success. */
export async function lsRegister(peer: LsPeerInfo, self: LsInfo): Promise<boolean> {
  try {
    return (await call(peer, 'POST', '/api/localsend/v2/register', JSON.stringify(self), 'application/json', 5000)).status === 200;
  } catch {
    return false;
  }
}

/** Sends files and/or a message; resolves when everything is delivered. */
export async function lsSend(peer: LsPeerInfo, self: LsInfo, items: { paths: string[]; text?: string }, opts: { answerTimeoutMs?: number; onProgress?: (sent: number, total: number) => void } = {}): Promise<void> {
  const files: Record<string, { id: string; fileName: string; size: number; fileType: string; preview?: string }> = {};
  const paths = new Map<string, string>();
  items.paths.forEach((p, i) => {
    const id = `f${i}`;
    files[id] = { id, fileName: basename(p), size: statSync(p).size, fileType: 'application/octet-stream' };
    paths.set(id, p);
  });
  if (items.text) files.text = { id: 'text', fileName: 'message.txt', size: Buffer.byteLength(items.text), fileType: 'text/plain', preview: items.text };
  const r = await call(peer, 'POST', '/api/localsend/v2/prepare-upload', JSON.stringify({ info: self, files }), 'application/json', opts.answerTimeoutMs ?? 180_000);
  if (r.status === 204) return;
  if (r.status === 403) throw new LocalSendError('declined', 'the device declined');
  if (r.status === 409) throw new LocalSendError('busy', 'the device is busy with another transfer');
  if (r.status !== 200) throw new LocalSendError('failed', `prepare-upload: HTTP ${r.status}`);
  const { sessionId, files: tokens } = JSON.parse(r.body) as { sessionId: string; files: Record<string, string> };
  const total = [...paths.keys()].reduce((n, id) => n + (tokens[id] ? files[id]!.size : 0), 0);
  let sent = 0;
  try {
    for (const [id, token] of Object.entries(tokens)) {
      const p = paths.get(id);
      if (!p) continue;
      const q = new URLSearchParams({ sessionId, fileId: id, token });
      const u = await call(peer, 'POST', `/api/localsend/v2/upload?${q}`, createReadStream(p), 'application/octet-stream', 600_000);
      if (u.status !== 200) throw new LocalSendError('failed', `upload ${basename(p)}: HTTP ${u.status}`);
      sent += files[id]!.size;
      opts.onProgress?.(sent, total);
    }
  } catch (e) {
    await call(peer, 'POST', `/api/localsend/v2/cancel?${new URLSearchParams({ sessionId })}`, undefined, 'application/json', 5000).catch(() => {});
    throw e;
  }
}
