// Internet guest links (M5b): what the hub stores is ciphertext under a 32-byte link key that exists
// only in the link's URL fragment (#k=). Files are sealed in 4 MiB chunks with AES-256-GCM:
//   nonce = u32be(fileIdx) ‖ u64be(chunkIdx)          (unique per key: files and chunks are numbered)
//   AAD   = utf8("meshdrop-link-v1") ‖ 0x00 ‖ utf8(linkId) ‖ 0x00 ‖ u32be(fileIdx) ‖ u64be(chunkIdx) ‖ u8(last)
//   chunk = ciphertext ‖ 16-byte tag
// The manifest ({v:1, files:[{name,size,type?}], text?}) is file 0xffffffff, chunk 0, last. Guest
// uploads use file 0xfffffffe for their offer and 0x80000000 + i for the slices of offered file i,
// sealed with a key of their own per offer, so no two offers ever share a nonce under one key:
//   uploadKey = HKDF-SHA256(ikm = link key, salt = 16 random bytes from the browser (X-Upload-Salt),
//                           info = utf8("meshdrop-link-upload-v1") ‖ 0x00 ‖ utf8(linkId), 32 bytes)
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const LINK_DOMAIN = 'meshdrop-link-v1';
export const LINK_CHUNK = 4 * 1024 * 1024;
export const MANIFEST_FILE = 0xffffffff;
export const OFFER_FILE = 0xfffffffe;
export const UPLOAD_BASE = 0x80000000;

export class LinkCryptoError extends Error {
  constructor(message = 'link data does not decrypt') {
    super(message);
    this.name = 'LinkCryptoError';
  }
}

export interface LinkManifest {
  v: 1;
  files: { name: string; size: number; type?: string }[];
  text?: string;
}

export const UPLOAD_SALT_BYTES = 16;
const UPLOAD_KEY_DOMAIN = 'meshdrop-link-upload-v1';

/** The key one upload offer (and its slices) is sealed with: derived from the link key and the offer's salt. */
export function uploadKey(linkKey: Buffer, linkId: string, salt: Buffer): Buffer {
  if (linkKey.length !== 32 || salt.length !== UPLOAD_SALT_BYTES) throw new LinkCryptoError('bad upload key input');
  return Buffer.from(hkdfSync('sha256', linkKey, salt, Buffer.concat([Buffer.from(UPLOAD_KEY_DOMAIN), Buffer.of(0), Buffer.from(linkId)]), 32));
}

export const newLinkKey = (): Buffer => randomBytes(32);
export const newLinkId = (): string => randomBytes(16).toString('base64url');
/** What the hub keeps to recognise the key (to check uploads), never the key itself. */
export const keyHash = (key: Buffer): string => createHash('sha256').update(key).digest('hex');

function nonce(fileIdx: number, chunkIdx: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(fileIdx >>> 0, 0);
  n.writeBigUInt64BE(BigInt(chunkIdx), 4);
  return n;
}

function aad(linkId: string, fileIdx: number, chunkIdx: number, last: boolean): Buffer {
  const tail = Buffer.alloc(13);
  tail.writeUInt32BE(fileIdx >>> 0, 0);
  tail.writeBigUInt64BE(BigInt(chunkIdx), 4);
  tail.writeUInt8(last ? 1 : 0, 12);
  return Buffer.concat([Buffer.from(LINK_DOMAIN), Buffer.of(0), Buffer.from(linkId), Buffer.of(0), tail]);
}

export function sealChunk(key: Buffer, linkId: string, fileIdx: number, chunkIdx: number, last: boolean, plain: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce(fileIdx, chunkIdx));
  c.setAAD(aad(linkId, fileIdx, chunkIdx, last));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

export function openChunk(key: Buffer, linkId: string, fileIdx: number, chunkIdx: number, last: boolean, sealed: Buffer): Buffer {
  if (key.length !== 32 || sealed.length < 16) throw new LinkCryptoError();
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce(fileIdx, chunkIdx));
    d.setAAD(aad(linkId, fileIdx, chunkIdx, last));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  } catch {
    throw new LinkCryptoError();
  }
}

export const sealManifest = (key: Buffer, linkId: string, m: LinkManifest): Buffer =>
  sealChunk(key, linkId, MANIFEST_FILE, 0, true, Buffer.from(JSON.stringify(m)));

export function openManifest(key: Buffer, linkId: string, sealed: Buffer): LinkManifest {
  const m = JSON.parse(openChunk(key, linkId, MANIFEST_FILE, 0, true, sealed).toString('utf8')) as LinkManifest;
  if (m?.v !== 1 || !Array.isArray(m.files)) throw new LinkCryptoError('bad manifest');
  return m;
}

/** Chunks of a file of `size` bytes (an empty file is one empty, last chunk). */
export const linkChunkCount = (size: number): number => Math.max(1, Math.ceil(size / LINK_CHUNK));
