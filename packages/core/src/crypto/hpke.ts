// RFC 9180 HPKE, mode_auth (0x02), DHKEM(P-256, HKDF-SHA256) 0x0010, HKDF-SHA256 0x0001,
// AES-GCM (0x0001 = AES-128, 0x0002 = AES-256). Every primitive is node:crypto; HKDF is the
// RFC 5869 composition in ./hkdf.ts.
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { hkdfExpand, hkdfExtract } from './hkdf.ts';

export type HpkeAead = 'aes-128-gcm' | 'aes-256-gcm';

export interface HpkeContext {
  key: Buffer;
  baseNonce: Buffer;
  exporterSecret: Buffer;
  aead: HpkeAead;
}

export class HpkeOpenError extends Error {
  constructor(message = 'HPKE open failed') {
    super(message);
    this.name = 'HpkeOpenError';
  }
}

const MODE_AUTH = 0x02;
const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
const N_SECRET = 32;
const N_H = 32;
const N_N = 12;
const N_T = 16;
const VERSION = Buffer.from('HPKE-v1', 'ascii');
const EMPTY = Buffer.alloc(0);

const AEADS: Record<HpkeAead, { id: number; nk: number }> = {
  'aes-128-gcm': { id: 0x0001, nk: 16 },
  'aes-256-gcm': { id: 0x0002, nk: 32 },
};

function i2osp(n: number | bigint, len: number): Buffer {
  let v = BigInt(n);
  if (v < 0n || v >= 1n << BigInt(8 * len)) throw new RangeError('i2osp: out of range');
  const out = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const ascii = (s: string): Buffer => Buffer.from(s, 'ascii');

const KEM_SUITE = Buffer.concat([ascii('KEM'), i2osp(KEM_ID, 2)]);

function hpkeSuite(aead: HpkeAead): Buffer {
  return Buffer.concat([ascii('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEADS[aead].id, 2)]);
}

function labeledExtract(suite: Buffer, salt: Buffer, label: string, ikm: Buffer): Buffer {
  return hkdfExtract(salt, Buffer.concat([VERSION, suite, ascii(label), ikm]));
}

function labeledExpand(suite: Buffer, prk: Buffer, label: string, info: Buffer, len: number): Buffer {
  return hkdfExpand(prk, Buffer.concat([i2osp(len, 2), VERSION, suite, ascii(label), info]), len);
}

/** Uncompressed SEC1 point 0x04 || X || Y (65 bytes). */
function serializePublic(pk: KeyObject): Buffer {
  const jwk = pk.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new TypeError('expected a P-256 public key');
  }
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

function deserializePublic(point: Buffer): KeyObject {
  if (point.length !== 65 || point[0] !== 0x04) throw new HpkeOpenError('invalid encapsulated key');
  try {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    throw new HpkeOpenError('invalid encapsulated key');
  }
}

function dh(sk: KeyObject, pk: KeyObject): Buffer {
  return diffieHellman({ privateKey: sk, publicKey: pk });
}

function extractAndExpand(dhs: Buffer, kemContext: Buffer): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dhs);
  return labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', kemContext, N_SECRET);
}

function keySchedule(sharedSecret: Buffer, info: Buffer, aead: HpkeAead): HpkeContext {
  const suite = hpkeSuite(aead);
  const pskIdHash = labeledExtract(suite, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(suite, EMPTY, 'info_hash', info);
  const ksContext = Buffer.concat([Buffer.from([MODE_AUTH]), pskIdHash, infoHash]);
  const secret = labeledExtract(suite, sharedSecret, 'secret', EMPTY);
  return {
    key: labeledExpand(suite, secret, 'key', ksContext, AEADS[aead].nk),
    baseNonce: labeledExpand(suite, secret, 'base_nonce', ksContext, N_N),
    exporterSecret: labeledExpand(suite, secret, 'exp', ksContext, N_H),
    aead,
  };
}

/** AuthEncap + KeySchedule (RFC 9180 sections 4.1 and 5.1). `opts.skE` is for tests only. */
export function setupAuthS(
  pkR: KeyObject,
  info: Buffer,
  skS: KeyObject,
  opts: { aead?: HpkeAead; skE?: KeyObject } = {},
): { enc: Buffer; ctx: HpkeContext } {
  const aead = opts.aead ?? 'aes-256-gcm';
  const skE = opts.skE ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const enc = serializePublic(createPublicKey(skE));
  const dhs = Buffer.concat([dh(skE, pkR), dh(skS, pkR)]);
  const kemContext = Buffer.concat([enc, serializePublic(pkR), serializePublic(createPublicKey(skS))]);
  return { enc, ctx: keySchedule(extractAndExpand(dhs, kemContext), info, aead) };
}

/** AuthDecap + KeySchedule. */
export function setupAuthR(
  enc: Buffer,
  skR: KeyObject,
  info: Buffer,
  pkS: KeyObject,
  opts: { aead?: HpkeAead } = {},
): HpkeContext {
  const aead = opts.aead ?? 'aes-256-gcm';
  const pkE = deserializePublic(enc);
  const dhs = Buffer.concat([dh(skR, pkE), dh(skR, pkS)]);
  const kemContext = Buffer.concat([enc, serializePublic(createPublicKey(skR)), serializePublic(pkS)]);
  return keySchedule(extractAndExpand(dhs, kemContext), info, aead);
}

function nonceAt(ctx: HpkeContext, seq: bigint): Buffer {
  if (seq < 0n || seq >= 1n << 96n) throw new RangeError('seq must be in [0, 2^96)');
  const n = i2osp(seq, N_N);
  for (let i = 0; i < N_N; i++) n[i] = n[i]! ^ ctx.baseNonce[i]!;
  return n;
}

/** Seal at an explicit sequence number. Returns ciphertext || 16-byte tag. */
export function sealAt(ctx: HpkeContext, seq: bigint, aad: Buffer, pt: Buffer): Buffer {
  const c = createCipheriv(ctx.aead, ctx.key, nonceAt(ctx, seq), { authTagLength: N_T });
  c.setAAD(aad);
  const body = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

/** Open at an explicit sequence number. Throws HpkeOpenError on any authentication failure. */
export function openAt(ctx: HpkeContext, seq: bigint, aad: Buffer, ct: Buffer): Buffer {
  const nonce = nonceAt(ctx, seq);
  if (ct.length < N_T) throw new HpkeOpenError('ciphertext too short');
  try {
    const d = createDecipheriv(ctx.aead, ctx.key, nonce, { authTagLength: N_T });
    d.setAAD(aad);
    d.setAuthTag(ct.subarray(ct.length - N_T));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - N_T)), d.final()]);
  } catch {
    throw new HpkeOpenError();
  }
}
