import { createHmac } from 'node:crypto';

const HASH_LEN = 32;

/** RFC 5869 HKDF-Extract with HMAC-SHA256. An empty salt acts as HashLen zero bytes. */
export function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest();
}

/** RFC 5869 HKDF-Expand with HMAC-SHA256. */
export function hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer {
  if (!Number.isInteger(len) || len < 0 || len > 255 * HASH_LEN) {
    throw new RangeError('hkdfExpand: invalid output length');
  }
  const blocks: Buffer[] = [];
  let t: Buffer = Buffer.alloc(0);
  for (let i = 1; blocks.length * HASH_LEN < len; i++) {
    t = createHmac('sha256', prk).update(t).update(info).update(Buffer.from([i])).digest();
    blocks.push(t);
  }
  return Buffer.concat(blocks).subarray(0, len);
}
