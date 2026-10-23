import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hkdfExpand, hkdfExtract } from '../src/crypto/hkdf.ts';
import { HpkeOpenError, openAt, sealAt, setupAuthR, setupAuthS } from '../src/crypto/hpke.ts';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const b64u = (b: Buffer): string => b.toString('base64url');

function pubFromPoint(point: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
    format: 'jwk',
  });
}
function privFromScalar(d: Buffer, point: Buffer): KeyObject {
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(d),
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

interface Vec {
  aead_id: number;
  info: string;
  skEm: string;
  pkEm: string;
  skRm: string;
  pkRm: string;
  skSm: string;
  pkSm: string;
  enc: string;
  key: string;
  base_nonce: string;
  exporter_secret: string;
  encryptions: { aad: string; ct: string; pt: string }[];
}
const vectors = JSON.parse(
  readFileSync(new URL('../../../protocol/vectors/hpke-auth-p256.json', import.meta.url), 'utf8'),
) as Vec[];

describe('HKDF', () => {
  it('RFC 5869 case 1', () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = hex('000102030405060708090a0b0c');
    const info = hex('f0f1f2f3f4f5f6f7f8f9');
    const prk = hkdfExtract(salt, ikm);
    expect(prk.toString('hex')).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
    expect(hkdfExpand(prk, info, 42).toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('RFC 9180 auth vectors (DHKEM P-256, HKDF-SHA256)', () => {
  it('has vectors for aes-128-gcm and aes-256-gcm', () => {
    expect(vectors.map((v) => v.aead_id).sort()).toEqual([1, 2]);
  });
  for (const v of vectors) {
    const aead = v.aead_id === 1 ? 'aes-128-gcm' : 'aes-256-gcm';
    it(`aead_id=${v.aead_id}: setup and seal/open match`, () => {
      const pkR = pubFromPoint(hex(v.pkRm));
      const skR = privFromScalar(hex(v.skRm), hex(v.pkRm));
      const pkS = pubFromPoint(hex(v.pkSm));
      const skS = privFromScalar(hex(v.skSm), hex(v.pkSm));
      const skE = privFromScalar(hex(v.skEm), hex(v.pkEm));
      const info = hex(v.info);

      const { enc, ctx } = setupAuthS(pkR, info, skS, { aead, skE });
      expect(enc.toString('hex')).toBe(v.enc);
      expect(ctx.key.toString('hex')).toBe(v.key);
      expect(ctx.baseNonce.toString('hex')).toBe(v.base_nonce);
      expect(ctx.exporterSecret.toString('hex')).toBe(v.exporter_secret);
      expect(ctx.aead).toBe(aead);

      const rctx = setupAuthR(hex(v.enc), skR, info, pkS, { aead });
      expect(rctx.key.toString('hex')).toBe(v.key);
      expect(rctx.baseNonce.toString('hex')).toBe(v.base_nonce);
      expect(rctx.exporterSecret.toString('hex')).toBe(v.exporter_secret);

      v.encryptions.forEach((e, i) => {
        const ct = sealAt(ctx, BigInt(i), hex(e.aad), hex(e.pt));
        expect(ct.toString('hex')).toBe(e.ct);
        expect(openAt(rctx, BigInt(i), hex(e.aad), hex(e.ct)).toString('hex')).toBe(e.pt);
      });
    });
  }
});

function pair(): { pk: KeyObject; sk: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pk: publicKey, sk: privateKey };
}

describe('HPKE behaviour', () => {
  it('round trip at sparse seq (default AES-256-GCM)', () => {
    const r = pair();
    const s = pair();
    const info = Buffer.from('meshdrop test');
    const { enc, ctx } = setupAuthS(r.pk, info, s.sk);
    expect(ctx.aead).toBe('aes-256-gcm');
    expect(ctx.key.length).toBe(32);
    const rctx = setupAuthR(enc, r.sk, info, s.pk);
    const seq = 2n ** 40n + 7n;
    const aad = Buffer.from('aad');
    const pt = Buffer.from('hello sparse world');
    const ct = sealAt(ctx, seq, aad, pt);
    expect(ct.length).toBe(pt.length + 16);
    expect(openAt(rctx, seq, aad, ct).equals(pt)).toBe(true);
  });

  it('tamper fails', () => {
    const r = pair();
    const s = pair();
    const { enc, ctx } = setupAuthS(r.pk, Buffer.alloc(0), s.sk);
    const rctx = setupAuthR(enc, r.sk, Buffer.alloc(0), s.pk);
    const ct = sealAt(ctx, 1n, Buffer.alloc(0), Buffer.from('payload'));
    ct[0] = ct[0]! ^ 1;
    expect(() => openAt(rctx, 1n, Buffer.alloc(0), ct)).toThrow(HpkeOpenError);
  });

  it('wrong seq or aad fails', () => {
    const r = pair();
    const s = pair();
    const { enc, ctx } = setupAuthS(r.pk, Buffer.alloc(0), s.sk);
    const rctx = setupAuthR(enc, r.sk, Buffer.alloc(0), s.pk);
    const ct = sealAt(ctx, 1n, Buffer.from('a'), Buffer.from('payload'));
    expect(() => openAt(rctx, 2n, Buffer.from('a'), ct)).toThrow(HpkeOpenError);
    expect(() => openAt(rctx, 1n, Buffer.from('b'), ct)).toThrow(HpkeOpenError);
    expect(() => openAt(rctx, 1n, Buffer.from('a'), Buffer.alloc(3))).toThrow(HpkeOpenError);
  });

  it('wrong sender key fails', () => {
    const r = pair();
    const s = pair();
    const other = pair();
    const { enc, ctx } = setupAuthS(r.pk, Buffer.alloc(0), s.sk);
    const bad = setupAuthR(enc, r.sk, Buffer.alloc(0), other.pk);
    const ct = sealAt(ctx, 0n, Buffer.alloc(0), Buffer.from('payload'));
    expect(() => openAt(bad, 0n, Buffer.alloc(0), ct)).toThrow(HpkeOpenError);
  });

  it('rejects seq >= 2^96 and negative', () => {
    const r = pair();
    const s = pair();
    const { ctx } = setupAuthS(r.pk, Buffer.alloc(0), s.sk);
    expect(() => sealAt(ctx, 2n ** 96n, Buffer.alloc(0), Buffer.alloc(1))).toThrow(RangeError);
    expect(() => sealAt(ctx, -1n, Buffer.alloc(0), Buffer.alloc(1))).toThrow(RangeError);
    expect(() => sealAt(ctx, 2n ** 96n - 1n, Buffer.alloc(0), Buffer.alloc(1))).not.toThrow();
  });
});
