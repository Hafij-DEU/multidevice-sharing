import { X509Certificate, createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSelfSignedCert } from '../src/x509.ts';
import { deviceIdOf, loadOrCreateIdentity } from '../src/identity.ts';
import { configDir } from '../src/paths.ts';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'meshdrop-id-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Minimal DER reader for the frozen-vector test: returns [header+content] slices of the
// children of a SEQUENCE.
function derChildren(buf: Buffer): { tag: number; content: Buffer; full: Buffer }[] {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const tag = buf[off]!;
    let len = buf[off + 1]!;
    let hdr = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 2 + i]!;
      hdr = 2 + n;
    }
    out.push({ tag, content: buf.subarray(off + hdr, off + hdr + len), full: buf.subarray(off, off + hdr + len) });
    off += hdr + len;
  }
  return out;
}

describe('device identity', () => {
  it('cert parses and self-verifies', async () => {
    const id = await loadOrCreateIdentity(tmpDir());
    const cert = new X509Certificate(id.certDer);
    expect(cert.verify(id.publicKey)).toBe(true);
    expect(cert.subject).toContain('CN=meshdrop-');
    expect(cert.ca).toBe(false);
  });

  it('deviceId is sha256 of DER', async () => {
    const id = await loadOrCreateIdentity(tmpDir());
    expect(deviceIdOf(id.certDer)).toBe(createHash('sha256').update(id.certDer).digest('hex'));
    expect(id.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(id.deviceId).toBe(deviceIdOf(id.certDer));
  });

  it('identity persists', async () => {
    const dir = tmpDir();
    const a = await loadOrCreateIdentity(dir);
    const b = await loadOrCreateIdentity(dir);
    expect(b.deviceId).toBe(a.deviceId);
    expect(statSync(join(dir, 'identity', 'key.pem')).mode & 0o777).toBe(0o600);
    expect(a.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(a.certPem).toContain('BEGIN CERTIFICATE');
  });

  it('a key without a cert, or a cert without a key, is an error (never a silent new device id)', async () => {
    for (const keep of ['key.pem', 'cert.der'] as const) {
      const dir = tmpDir();
      await loadOrCreateIdentity(dir);
      const lose = keep === 'key.pem' ? 'cert.der' : 'key.pem';
      const keptBefore = readFileSync(join(dir, 'identity', keep));
      rmSync(join(dir, 'identity', lose));
      await expect(loadOrCreateIdentity(dir), keep).rejects.toThrow(new RegExp(`identity.*${lose.replace('.', '\\.')}.*missing`));
      // nothing was regenerated or overwritten
      expect(existsSync(join(dir, 'identity', lose)), keep).toBe(false);
      expect(readFileSync(join(dir, 'identity', keep)).equals(keptBefore), keep).toBe(true);
    }
  });

  it('leftover *.tmp files from a crashed first run are cleared, not looped on', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'identity'), { recursive: true });
    writeFileSync(join(dir, 'identity', 'key.pem.1234.tmp'), 'partial');
    writeFileSync(join(dir, 'identity', 'cert.der.1234.tmp'), 'partial');
    const id = await loadOrCreateIdentity(dir);
    expect(id.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(dir, 'identity')).sort()).toEqual(['cert.der', 'key.pem']);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect((await loadOrCreateIdentity(dir)).deviceId).toBe(id.deviceId);
  });

  it('an identity dir holding unknown files is an error, not an endless retry', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'identity'), { recursive: true });
    writeFileSync(join(dir, 'identity', 'key.pem.bak'), 'user backup');
    await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/identity.*unexpected.*key\.pem\.bak/);
    expect(readdirSync(join(dir, 'identity'))).toEqual(['key.pem.bak']);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('frozen vector: TBSCertificate bytes are stable', () => {
    const vec = JSON.parse(readFileSync(new URL('../../../protocol/vectors/x509-v1.json', import.meta.url), 'utf8')) as {
      privateKeyPem: string;
      serialHex: string;
      commonName: string;
      tbsHex: string;
    };
    const privateKey = createPrivateKey(vec.privateKeyPem);
    const publicKey = createPublicKey(privateKey);
    const der = buildSelfSignedCert({
      publicKey,
      privateKey,
      commonName: vec.commonName,
      serial: Buffer.from(vec.serialHex, 'hex'),
    });
    const [tbs, sigAlg, sigBits] = derChildren(derChildren(der)[0]!.content);
    // RFC 5280 4.1.2.5: dates before 2050 MUST be UTCTime; 9999-12-31 is GeneralizedTime.
    const validity = derChildren(tbs!.content)[4]!;
    const [notBefore, notAfter] = derChildren(validity.content);
    expect(notBefore!.tag).toBe(0x17);
    expect(notBefore!.content.toString('ascii')).toBe('200101000000Z');
    expect(notAfter!.tag).toBe(0x18);
    expect(notAfter!.content.toString('ascii')).toBe('99991231235959Z');
    expect(new X509Certificate(der).validFromDate.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(tbs!.full.toString('hex')).toBe(vec.tbsHex);
    // outer signatureAlgorithm repeats ecdsa-with-SHA256 (1.2.840.10045.4.3.2), no parameters
    expect(sigAlg!.full.toString('hex')).toBe('300a06082a8648ce3d040302');
    expect(sigBits!.tag).toBe(0x03);
    expect(sigBits!.content[0]).toBe(0);
    expect(verify('sha256', tbs!.full, publicKey, sigBits!.content.subarray(1))).toBe(true);
    expect(new X509Certificate(der).verify(publicKey)).toBe(true);
  });

  it('node TLS accepts it', async () => {
    const id = await loadOrCreateIdentity(tmpDir());
    const server = createServer({ key: id.keyPem, cert: id.certPem, minVersion: 'TLSv1.3' }, (s) => s.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const proto = await new Promise<string | null>((resolve, reject) => {
        const c = connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => {
          resolve(c.getProtocol());
          c.destroy();
        });
        c.on('error', reject);
      });
      expect(proto).toBe('TLSv1.3');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('configDir', () => {
  it('honours MESHDROP_HOME, then XDG_CONFIG_HOME, then ~/.config', () => {
    const saved = { m: process.env.MESHDROP_HOME, x: process.env.XDG_CONFIG_HOME };
    try {
      process.env.MESHDROP_HOME = '/tmp/md-home';
      expect(configDir()).toBe('/tmp/md-home');
      delete process.env.MESHDROP_HOME;
      process.env.XDG_CONFIG_HOME = '/tmp/xdg';
      expect(configDir()).toBe(join('/tmp/xdg', 'meshdrop'));
      delete process.env.XDG_CONFIG_HOME;
      expect(configDir()).toMatch(/\.config[\\/]meshdrop$/);
    } finally {
      if (saved.m === undefined) delete process.env.MESHDROP_HOME;
      else process.env.MESHDROP_HOME = saved.m;
      if (saved.x === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.x;
    }
  });
});
