import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { connect, createServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';
import { TrustStore, type TrustedDevice } from '../src/trust.ts';
import {
  PinMismatchError,
  connectPinned,
  peerDeviceId,
  pinnedRequest,
  serverTlsOptions,
} from '../src/tls.ts';

const tmps: string[] = [];
const closers: (() => void)[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'meshdrop-tls-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

let A: Identity;
let B: Identity;
let C: Identity;
beforeAll(async () => {
  [A, B, C] = await Promise.all([
    loadOrCreateIdentity(tmpDir()),
    loadOrCreateIdentity(tmpDir()),
    loadOrCreateIdentity(tmpDir()),
  ]);
});

function listen(server: TlsServer | HttpsServer | NetServer, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  closers.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

/** TLS server on A's identity; records each peer id and any application bytes received. */
async function startTlsServer(id: Identity) {
  const peers: (string | null)[] = [];
  const received: Buffer[] = [];
  const server = createServer(serverTlsOptions(id), (sock) => {
    peers.push(peerDeviceId(sock));
    sock.on('data', (d: Buffer) => received.push(d));
    sock.on('error', () => {});
  });
  const port = await listen(server, new Set());
  return { port, peers, received };
}

describe('serverTlsOptions', () => {
  it('requests a client cert without CA validation and forces TLS 1.3', () => {
    const o = serverTlsOptions(A);
    expect(o.requestCert).toBe(true);
    expect(o.rejectUnauthorized).toBe(false);
    expect(o.minVersion).toBe('TLSv1.3');
  });
});

describe('pinned mutual TLS', () => {
  it('mutual pin ok: server sees the client device id', async () => {
    const s = await startTlsServer(A);
    const sock = await connectPinned('127.0.0.1', s.port, B, A.deviceId);
    closers.push(() => sock.destroy());
    expect(sock.getProtocol()).toBe('TLSv1.3');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.peers).toEqual([B.deviceId]);
  });

  it('wrong pin rejected with PinMismatchError and no application byte is sent', async () => {
    const s = await startTlsServer(A);
    const err = await connectPinned('127.0.0.1', s.port, B, C.deviceId).catch((e) => e);
    expect(err).toBeInstanceOf(PinMismatchError);
    expect(err).toBeInstanceOf(Error);
    expect(err.expected).toBe(C.deviceId);
    expect(err.actual).toBe(A.deviceId);
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(s.received).length).toBe(0);
  });

  it('closes the socket when the pin does not match', async () => {
    const server = createServer(serverTlsOptions(A), (sock) => sock.on('error', () => {}));
    server.on('tlsClientError', () => {});
    const port = await listen(server, new Set());
    // the underlying TCP connection must be closed by the client side.
    const closed = new Promise<void>((resolve) =>
      server.on('connection', (s) => s.on('close', () => resolve())),
    );
    await expect(connectPinned('127.0.0.1', port, B, C.deviceId)).rejects.toBeInstanceOf(PinMismatchError);
    await closed;
  });

  it('peerDeviceId is null when the client sent no certificate', async () => {
    const s = await startTlsServer(A);
    const sock = connect({
      host: '127.0.0.1',
      port: s.port,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    });
    closers.push(() => sock.destroy());
    await new Promise<void>((resolve, reject) => {
      sock.once('secureConnect', () => resolve());
      sock.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.peers).toEqual([null]);
  });

  it('refuses a server that only speaks TLS 1.2', async () => {
    const server = createServer({ key: A.keyPem, cert: A.certPem, maxVersion: 'TLSv1.2' }, (sock) =>
      sock.on('error', () => {}),
    );
    const port = await listen(server, new Set());
    await expect(connectPinned('127.0.0.1', port, B, A.deviceId)).rejects.toThrow();
  });

  it('rejects on connection refused', async () => {
    const probe = createNetServer();
    const port = await listen(probe, new Set());
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(connectPinned('127.0.0.1', port, B, A.deviceId)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('times out against a host that accepts TCP but never answers the handshake', async () => {
    const blackhole = createNetServer((s) => s.on('error', () => {}));
    const port = await listen(blackhole, new Set());
    const t0 = Date.now();
    await expect(
      connectPinned('127.0.0.1', port, B, A.deviceId, { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200 ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('pinnedRequest', () => {
  async function startHttps(
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  ) {
    const server = createHttpsServer(serverTlsOptions(A), handler);
    server.on('tlsClientError', () => {});
    return listen(server, new Set());
  }

  it('POSTs JSON and parses a JSON response; server sees the pinned peer', async () => {
    let seenPeer: string | null = null;
    let seenBody = '';
    const port = await startHttps((req, res) => {
      seenPeer = peerDeviceId(req.socket as TLSSocket);
      req.on('data', (d) => (seenBody += d));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
      });
    });
    const sock = await connectPinned('127.0.0.1', port, B, A.deviceId);
    const r = await pinnedRequest(sock, 'POST', '/v1/offer', Buffer.from('{"a":1}'), {
      'content-type': 'application/json',
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, path: '/v1/offer', method: 'POST' });
    expect(seenBody).toBe('{"a":1}');
    expect(seenPeer).toBe(B.deviceId);
  });

  it('PUTs a Buffer body of ~4 MiB intact and returns raw bytes for non-JSON', async () => {
    const payload = Buffer.alloc(4 * 1024 * 1024 + 16, 0xab);
    payload[12345] = 1;
    let got = Buffer.alloc(0);
    const port = await startHttps((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', () => {
        got = Buffer.concat(parts);
        res.statusCode = 201;
        res.setHeader('content-type', 'application/octet-stream');
        res.end(Buffer.from([1, 2, 3]));
      });
    });
    const sock = await connectPinned('127.0.0.1', port, B, A.deviceId);
    const r = await pinnedRequest(sock, 'PUT', '/v1/chunk/0', payload);
    expect(r.status).toBe(201);
    expect(r.json).toBeUndefined();
    expect(r.body).toEqual(Buffer.from([1, 2, 3]));
    expect(got.equals(payload)).toBe(true);
  });

  it('streams a Readable body', async () => {
    let got = '';
    const port = await startHttps((req, res) => {
      req.on('data', (d) => (got += d));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"n":3}');
      });
    });
    const sock = await connectPinned('127.0.0.1', port, B, A.deviceId);
    const r = await pinnedRequest(sock, 'PUT', '/s', Readable.from([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')]));
    expect(got).toBe('abcdef');
    expect(r.json).toEqual({ n: 3 });
  });

  it('GET without body works and closes the connection afterwards', async () => {
    const port = await startHttps((_req, res) => res.end('hi'));
    const sock = await connectPinned('127.0.0.1', port, B, A.deviceId);
    const r = await pinnedRequest(sock, 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('hi');
    expect(sock.destroyed).toBe(true);
  });

  it('rejects on malformed JSON with an application/json content type', async () => {
    const port = await startHttps((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{nope');
    });
    const sock = await connectPinned('127.0.0.1', port, B, A.deviceId);
    await expect(pinnedRequest(sock, 'GET', '/')).rejects.toThrow(/invalid JSON/);
  });

  it('rejects when the body stream errors', async () => {
    const port = await startHttps((req, res) => {
      req.resume();
      req.on('end', () => res.end());
    });
    const sock = await connectPinned('127.0.0.1', port, B, A.deviceId);
    const body = new Readable({
      read() {
        this.destroy(new Error('disk gone'));
      },
    });
    await expect(pinnedRequest(sock, 'PUT', '/x', body)).rejects.toThrow(/disk gone/);
  });
});

describe('TrustStore', () => {
  const dev = (deviceId: string, alias = 'phone'): TrustedDevice => ({
    deviceId,
    alias,
    publicKeyPem: B.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    addedAt: 1700000000000,
  });

  it('trust store atomic: add persists, reload lists it, tmp file is gone, mode 0600', () => {
    const dir = tmpDir();
    const file = join(dir, 'trust.json');
    const t = new TrustStore(file);
    expect(t.list()).toEqual([]);
    t.add(dev(A.deviceId));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['trust.json']);
    const t2 = new TrustStore(file);
    expect(t2.list()).toEqual([dev(A.deviceId)]);
    expect(t2.get(A.deviceId)).toEqual(dev(A.deviceId));
    expect(t2.isTrusted(A.deviceId)).toBe(true);
    expect(t2.isTrusted(B.deviceId)).toBe(false);
    expect(t2.get(B.deviceId)).toBeUndefined();
  });

  it('remove persists; add of an existing id replaces it', () => {
    const file = join(tmpDir(), 'trust.json');
    const t = new TrustStore(file);
    t.add(dev(A.deviceId, 'one'));
    t.add(dev(A.deviceId, 'two'));
    t.add(dev(B.deviceId));
    expect(new TrustStore(file).list().map((d) => d.alias).sort()).toEqual(['phone', 'two']);
    t.remove(A.deviceId);
    expect(new TrustStore(file).list().map((d) => d.deviceId)).toEqual([B.deviceId]);
    t.remove(A.deviceId); // removing an unknown id is a no-op
  });

  it('rejects malformed device ids and bad public keys', () => {
    const t = new TrustStore(join(tmpDir(), 'trust.json'));
    for (const bad of ['', 'abc', A.deviceId.toUpperCase(), A.deviceId + '0', 'g'.repeat(64), `${A.deviceId}\n`]) {
      expect(() => t.add(dev(bad))).toThrow(/device id/i);
    }
    expect(() => t.add({ ...dev(A.deviceId), publicKeyPem: 'nope' })).toThrow(/public key/i);
    expect(t.list()).toEqual([]);
  });

  it('list/get return copies, not live references', () => {
    const t = new TrustStore(join(tmpDir(), 'trust.json'));
    t.add(dev(A.deviceId));
    t.list()[0]!.alias = 'evil';
    t.get(A.deviceId)!.alias = 'evil';
    expect(t.get(A.deviceId)!.alias).toBe('phone');
  });

  it('refuses to silently reset a corrupt trust file', () => {
    const file = join(tmpDir(), 'trust.json');
    writeFileSync(file, '{not json');
    expect(() => new TrustStore(file)).toThrow(/trust/i);
    writeFileSync(file, JSON.stringify({ devices: [{ deviceId: 'x' }] }));
    expect(() => new TrustStore(file)).toThrow(/trust/i);
    expect(readFileSync(file, 'utf8')).toContain('"x"'); // untouched
  });

  it('uses a unique tmp name per write and leaves no tmp files behind', () => {
    const dir = tmpDir();
    const t = new TrustStore(join(dir, 'sub', 'trust.json'));
    for (let i = 0; i < 20; i++) t.add(dev(A.deviceId, `a${i}`));
    expect(readdirSync(join(dir, 'sub'))).toEqual(['trust.json']);
    expect(existsSync(join(dir, 'sub', `trust.json.tmp`))).toBe(false);
  });
});
