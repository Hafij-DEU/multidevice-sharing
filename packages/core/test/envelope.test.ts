import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/mesh/canonical.ts';
import {
  ENVELOPE_DOMAIN,
  EnvelopeError,
  MAX_HEADER_BYTES,
  ReplayGuard,
  decodeFrame,
  encodeFrame,
  openEnvelope,
  sealEnvelope,
  type Envelope,
  type EnvelopeHeader,
} from '../src/mesh/envelope.ts';

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const A = p256();
const B = p256();
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const keys: Record<string, KeyObject> = { [ID_A]: A.publicKey, [ID_B]: B.publicKey };
const pubOf = (id: string) => keys[id];

const reqHeader = (over: Partial<EnvelopeHeader> = {}) => ({
  v: 1 as const, kind: 'req' as const, id: 'AAAAAAAAAAAAAAAAAAAAAA', from: ID_A, to: ID_B,
  method: 'PUT', path: '/mesh/v1/chunk/AAAAAAAAAAAAAAAAAAAAAA/0/1', contentType: 'application/octet-stream', ...over,
});

/** Re-signs a tampered header with the right key, so only the field check (not the signature) can catch it. */
function tampered(e: Envelope, patch: Partial<EnvelopeHeader>, body = e.body): Envelope {
  return { header: { ...e.header, ...patch }, body };
}

describe('sealEnvelope / openEnvelope', () => {
  it('round-trips a req and a res', () => {
    const body = Buffer.from('ciphertext bytes');
    const req = sealEnvelope(reqHeader(), body, A.privateKey);
    expect(req.header.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(openEnvelope(req, pubOf).path).toBe('/mesh/v1/chunk/AAAAAAAAAAAAAAAAAAAAAA/0/1');
    const res = sealEnvelope({ v: 1, kind: 'res', id: req.header.id, from: ID_B, to: ID_A, status: 204 }, Buffer.alloc(0), B.privateKey);
    expect(openEnvelope(res, pubOf).status).toBe(204);
  });

  it('rejects a modified path, to, status or body', () => {
    const req = sealEnvelope(reqHeader(), Buffer.from('x'), A.privateKey);
    expect(() => openEnvelope(tampered(req, { path: '/mesh/v1/cancel/AAAAAAAAAAAAAAAAAAAAAA' }), pubOf)).toThrow(EnvelopeError);
    expect(() => openEnvelope(tampered(req, { to: ID_A }), pubOf)).toThrow(EnvelopeError);
    expect(() => openEnvelope(tampered(req, {}, Buffer.from('y')), pubOf)).toThrow(EnvelopeError);
    const res = sealEnvelope({ v: 1, kind: 'res', id: req.header.id, from: ID_B, to: ID_A, status: 200 }, Buffer.alloc(0), B.privateKey);
    expect(() => openEnvelope(tampered(res, { status: 403 }), pubOf)).toThrow(EnvelopeError);
  });

  it('rejects an unknown sender and a signature by the wrong key', () => {
    const e = sealEnvelope(reqHeader({ from: 'c'.repeat(64) }), Buffer.alloc(0), A.privateKey);
    expect(() => openEnvelope(e, pubOf)).toThrow(EnvelopeError);
    const forged = sealEnvelope(reqHeader({ from: ID_B }), Buffer.alloc(0), A.privateKey); // A signs as B
    expect(() => openEnvelope(forged, pubOf)).toThrow(EnvelopeError);
  });

  it('rejects paths outside /mesh/v1/, a req without method/path, a res without status', () => {
    for (const path of ['/etc/passwd', '/mesh/v1/../x', '/mesh/v10/info', 'mesh/v1/info', '/mesh/v1/info?x=1']) {
      expect(() => sealEnvelope(reqHeader({ path }), Buffer.alloc(0), A.privateKey), path).toThrow(EnvelopeError);
    }
    const { method: _m, ...noMethod } = reqHeader();
    expect(() => sealEnvelope(noMethod, Buffer.alloc(0), A.privateKey)).toThrow(EnvelopeError);
    expect(() => sealEnvelope({ v: 1, kind: 'res', id: 'AAAAAAAAAAAAAAAAAAAAAA', from: ID_B, to: ID_A }, Buffer.alloc(0), B.privateKey)).toThrow(EnvelopeError);
    // the same checks on open, against a validly signed but hand-built header
    const raw = sealEnvelope(reqHeader(), Buffer.alloc(0), A.privateKey);
    expect(() => openEnvelope(tampered(raw, { path: '/etc/passwd' }), pubOf)).toThrow(EnvelopeError);
  });
});

describe('frames', () => {
  it('encodeFrame / decodeFrame round-trip', () => {
    const e = sealEnvelope(reqHeader(), Buffer.from('body!'), A.privateKey);
    const back = decodeFrame(encodeFrame(e));
    expect(back.header).toEqual(e.header);
    expect(back.body.equals(e.body)).toBe(true);
    expect(openEnvelope(back, pubOf).id).toBe(e.header.id);
  });

  it('rejects a header longer than MAX_HEADER_BYTES and truncated frames', () => {
    expect(MAX_HEADER_BYTES).toBe(16384);
    const big = Buffer.alloc(4);
    big.writeUInt32BE(16385);
    expect(() => decodeFrame(Buffer.concat([big, Buffer.alloc(16385)]))).toThrow(EnvelopeError);
    const f = encodeFrame(sealEnvelope(reqHeader(), Buffer.from('x'), A.privateKey));
    expect(() => decodeFrame(f.subarray(0, 3))).toThrow(EnvelopeError);
    expect(() => decodeFrame(f.subarray(0, 4 + 10))).toThrow(EnvelopeError);
    const notJson = Buffer.alloc(4);
    notJson.writeUInt32BE(3);
    expect(() => decodeFrame(Buffer.concat([notJson, Buffer.from('{x}')]))).toThrow(EnvelopeError);
  });
});

describe('ReplayGuard', () => {
  it('reports a repeat within the TTL and forgets it after', () => {
    let t = 1000;
    const g = new ReplayGuard(10_000, 600_000, () => t);
    expect(g.seen('x')).toBe(false);
    expect(g.seen('x')).toBe(true);
    t += 600_001;
    expect(g.seen('x')).toBe(false);
  });

  it('stays bounded at max entries', () => {
    const g = new ReplayGuard(3, 600_000, () => 0);
    for (const id of ['a', 'b', 'c', 'd']) g.seen(id);
    expect(g.size).toBeLessThanOrEqual(3);
    expect(g.seen('d')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

const VECTOR_URL = new URL('../../../protocol/vectors/envelope-v1.json', import.meta.url);
const SCALAR = '8f1a8e5d9a2c3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5';
function privFromScalar(dHex: string): KeyObject {
  const der = Buffer.concat([Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'), Buffer.from(dHex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
interface EnvelopeVector {
  description: string;
  domain: string;
  senderScalarHex: string;
  senderSpkiDerHex: string;
  unsignedHeader: Omit<EnvelopeHeader, 'sig'>;
  unsignedHeaderCanonical: string;
  bodyHex: string;
  header: EnvelopeHeader;
  frameHex: string;
}

function compute(prev?: EnvelopeVector): EnvelopeVector {
  const sk = privFromScalar(SCALAR);
  const body = Buffer.from('sealed chunk bytes');
  const e = prev ? { header: prev.header, body } : sealEnvelope(reqHeader({ from: ID_A }), body, sk);
  const { sig: _sig, ...unsigned } = e.header;
  return {
    description:
      'Relay envelope v1. sig = ECDSA-P256-SHA256 (DER, base64) over utf8(domain) || 0x00 || utf8(canonicalJson(header without sig)). ' +
      'bodySha256 = hex SHA-256 of the body. frame = u32be(len(utf8(canonicalJson(header)))) || that header || body.',
    domain: ENVELOPE_DOMAIN,
    senderScalarHex: SCALAR,
    senderSpkiDerHex: (createPublicKey(sk).export({ type: 'spki', format: 'der' }) as Buffer).toString('hex'),
    unsignedHeader: unsigned,
    unsignedHeaderCanonical: canonicalJson(unsigned),
    bodyHex: body.toString('hex'),
    header: e.header,
    frameHex: encodeFrame(e).toString('hex'),
  };
}

describe('frozen vector (envelope-v1.json)', () => {
  if (process.env.UPDATE_VECTORS === '1') {
    it('regenerates envelope-v1.json', () => {
      writeFileSync(VECTOR_URL, JSON.stringify(compute(), null, 2) + '\n');
      expect(existsSync(VECTOR_URL)).toBe(true);
    });
  }

  it('canonical header, frame bytes and signature match', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as EnvelopeVector;
    expect(vec.domain).toBe('meshdrop-envelope-v1');
    expect(compute(vec)).toEqual(vec); // everything but the randomised sig is recomputed
    const pub = createPublicKey({ key: Buffer.from(vec.senderSpkiDerHex, 'hex'), format: 'der', type: 'spki' });
    const opened = openEnvelope(decodeFrame(Buffer.from(vec.frameHex, 'hex')), (id) => (id === vec.header.from ? pub : undefined));
    expect(opened.path).toBe(vec.unsignedHeader.path);
  });
});
