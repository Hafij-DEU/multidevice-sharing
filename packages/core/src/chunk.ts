// Manifest + chunk sealing on top of HPKE auth mode (see ./crypto/hpke.ts).
//
// Wire model: the sender runs SetupAuthS once per session with info = "meshdrop/v1 " + sessionId.
// The manifest is sealed at seq 0 (AAD = sessionId); chunk (fileId, index) is sealed at
// seq ((fileId+1) << 32) | index (AAD = sessionId || u32be(fileId) || u32be(index)), so every
// ciphertext is bound to its session and position and nonces never repeat.
//
// Manifest serialization (frozen, byte-exact across engines): compact JSON, no whitespace, keys in
// a fixed order. Manifest: v, sessionId, from, to, createdAt, files, dirs, text (omitted if absent).
// FileEntry: fileId, path, size, mime, sha256. DirEntry: path. String escaping is that of ECMAScript
// JSON.stringify (only `"`, `\`, control chars < U+0020 and lone surrogates are escaped; all other
// characters, including non-ASCII, are raw UTF-8). Consumers parse with any JSON parser; only the
// sealing side needs byte-exactness.
import { randomBytes, type KeyObject } from 'node:crypto';
import type { Identity } from './identity.ts';
import {
  sealAt,
  openAt,
  setupAuthR,
  setupAuthS,
  type HpkeAead,
  type HpkeContext,
} from './crypto/hpke.ts';

export interface FileEntry { fileId: number; path: string; size: number; mime: string; sha256: string } // sha256 = plaintext hex
export interface DirEntry { path: string } // empty folders
export interface Manifest {
  v: 1; sessionId: string; from: string; to: string; createdAt: number;
  files: FileEntry[]; dirs: DirEntry[]; text?: string;
  /** The text is clipboard content (put it on the receiver's clipboard). Only with text, no files/dirs. */
  clipboard?: true;
  /** Photo backup (M8b): the receiver puts the files in its backup folder, not the inbox. */
  backup?: true;
  /** Copied files or an image: the receiver puts the files (saved in its inbox) on its clipboard. */
  clipboardFiles?: true;
  /** M11 burn after reading: the receiver deletes the files a few minutes after they are first opened. */
  burn?: true;
  /** M11 print: the receiver prints the files (if it allows printing for the sender). */
  print?: true;
}
export interface Offer { v: 1; sessionId: string; from: string; to: string; enc: string /*b64*/; sealedManifest: string /*b64*/ }
export interface HaveMap { [fileId: number]: number[] } // chunk indices already verified by receiver

export const CHUNK_SIZE = 4194304;
const TAG_LEN = 16;
const U32_MAX = 0xffffffff;

export function chunkCount(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('size must be a non-negative integer');
  return Math.ceil(size / CHUNK_SIZE);
}

function checkU32(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) throw new RangeError(`${what} must be a u32`);
}

export function chunkSeq(fileId: number, index: number): bigint {
  checkU32(fileId, 'fileId');
  checkU32(index, 'index');
  return ((BigInt(fileId) + 1n) << 32n) | BigInt(index);
}

export function sessionInfo(sessionId: string): Buffer {
  return Buffer.from('meshdrop/v1 ' + sessionId, 'utf8');
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export function chunkAad(sessionId: string, fileId: number, index: number): Buffer {
  checkU32(fileId, 'fileId');
  checkU32(index, 'index');
  return Buffer.concat([Buffer.from(sessionId, 'utf8'), u32be(fileId), u32be(index)]);
}

export function newSessionId(): string {
  return randomBytes(16).toString('base64url');
}

// ---- manifest shape / serialization ------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DEVICE_ID_HEX = /^[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
/** Caps on untrusted manifest size (path validation itself is the inbox's job). */
export const MAX_MANIFEST_FILES = 100000;
export const MAX_MANIFEST_DIRS = 100000;
export const MAX_MANIFEST_TEXT_BYTES = 1024 * 1024;

function bad(msg: string): never {
  throw new Error(`invalid manifest: ${msg}`);
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Validates the v===1 shape and returns a fresh copy with keys in canonical order. */
function normalizeManifest(x: unknown): Manifest {
  if (!isObj(x)) bad('not an object');
  if (x.v !== 1) bad('v must be 1');
  const { sessionId, from, to, createdAt, files, dirs, text, clipboard, backup, clipboardFiles, burn, print } = x;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) bad('sessionId');
  if (typeof from !== 'string' || !DEVICE_ID_HEX.test(from)) bad('from');
  if (typeof to !== 'string' || !DEVICE_ID_HEX.test(to)) bad('to');
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) bad('createdAt');
  if (!Array.isArray(files)) bad('files');
  if (!Array.isArray(dirs)) bad('dirs');
  if (text !== undefined && typeof text !== 'string') bad('text');
  if (files.length > MAX_MANIFEST_FILES) bad('too many files');
  if (dirs.length > MAX_MANIFEST_DIRS) bad('too many dirs');
  if (text !== undefined && Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_TEXT_BYTES) bad('text too large');
  if (clipboard !== undefined && (clipboard !== true || text === undefined || files.length > 0 || dirs.length > 0)) bad('clipboard');
  if (backup !== undefined && backup !== true) bad('backup');
  if (clipboardFiles !== undefined && (clipboardFiles !== true || files.length === 0)) bad('clipboardFiles');
  if (burn !== undefined && burn !== true) bad('burn');
  if (print !== undefined && (print !== true || files.length === 0)) bad('print');
  const seenIds = new Set<number>();
  const outFiles: FileEntry[] = files.map((f: unknown) => {
    if (!isObj(f)) bad('file entry');
    const { fileId, path, size, mime, sha256 } = f;
    if (typeof fileId !== 'number' || !Number.isInteger(fileId) || fileId < 0 || fileId > U32_MAX) bad('fileId');
    if (seenIds.has(fileId)) bad('duplicate fileId');
    seenIds.add(fileId);
    if (typeof path !== 'string') bad('file path');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) bad('file size');
    if (typeof mime !== 'string') bad('file mime');
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) bad('file sha256');
    return { fileId, path, size, mime, sha256 };
  });
  const outDirs: DirEntry[] = dirs.map((d: unknown) => {
    if (!isObj(d) || typeof d.path !== 'string') bad('dir entry');
    return { path: d.path };
  });
  const m: Manifest = { v: 1, sessionId, from, to, createdAt, files: outFiles, dirs: outDirs };
  if (text !== undefined) m.text = text;
  if (clipboard === true) m.clipboard = true;
  if (backup === true) m.backup = true;
  if (clipboardFiles === true) m.clipboardFiles = true;
  if (burn === true) m.burn = true;
  if (print === true) m.print = true;
  return m;
}

/** Deterministic manifest JSON (see the header comment). Validates the shape. */
export function serializeManifest(m: Manifest): string {
  return JSON.stringify(normalizeManifest(m));
}

// ---- sealing -----------------------------------------------------------------------------------

export function sealManifest(ctx: HpkeContext, m: Manifest): Buffer {
  const pt = Buffer.from(serializeManifest(m), 'utf8');
  return sealAt(ctx, 0n, Buffer.from(m.sessionId, 'utf8'), pt);
}

export function openManifest(ctx: HpkeContext, sessionId: string, ct: Buffer): Manifest {
  const pt = openAt(ctx, 0n, Buffer.from(sessionId, 'utf8'), ct);
  let parsed: unknown;
  try {
    parsed = JSON.parse(pt.toString('utf8'));
  } catch {
    bad('not JSON');
  }
  return normalizeManifest(parsed);
}

export function sealChunk(ctx: HpkeContext, sessionId: string, fileId: number, index: number, pt: Buffer): Buffer {
  if (pt.length > CHUNK_SIZE) throw new RangeError('chunk plaintext exceeds CHUNK_SIZE');
  return sealAt(ctx, chunkSeq(fileId, index), chunkAad(sessionId, fileId, index), pt);
}

export function openChunk(ctx: HpkeContext, sessionId: string, fileId: number, index: number, ct: Buffer): Buffer {
  return openAt(ctx, chunkSeq(fileId, index), chunkAad(sessionId, fileId, index), ct);
}

// ---- offers ------------------------------------------------------------------------------------

/**
 * Sender side. `opts.skE` fixes the HPKE ephemeral key and exists only for the frozen-vector test.
 */
export function createOffer(
  id: Identity,
  peerPub: KeyObject,
  m: Manifest,
  opts: { skE?: KeyObject } = {},
): { offer: Offer; ctx: HpkeContext } {
  if (m.from !== id.deviceId) throw new Error('manifest.from does not match the sending identity');
  const { enc, ctx } = setupAuthS(peerPub, sessionInfo(m.sessionId), id.privateKey, opts);
  const sealed = sealManifest(ctx, m);
  return {
    offer: {
      v: 1,
      sessionId: m.sessionId,
      from: m.from,
      to: m.to,
      enc: enc.toString('base64'),
      sealedManifest: sealed.toString('base64'),
    },
    ctx,
  };
}

/** Receiver side. `senderPub` must come from the trust store, never from the offer. */
export function acceptOffer(id: Identity, senderPub: KeyObject, o: Offer): { manifest: Manifest; ctx: HpkeContext } {
  if (!isObj(o) || o.v !== 1 || typeof o.sessionId !== 'string' || typeof o.to !== 'string' ||
      typeof o.from !== 'string' || !DEVICE_ID_HEX.test(o.from) || typeof o.enc !== 'string' || typeof o.sealedManifest !== 'string') {
    throw new Error('invalid offer');
  }
  if (o.to !== id.deviceId) throw new Error('offer is not addressed to this device');
  const ctx = setupAuthR(Buffer.from(o.enc, 'base64'), id.privateKey, sessionInfo(o.sessionId), senderPub);
  const manifest = openManifest(ctx, o.sessionId, Buffer.from(o.sealedManifest, 'base64'));
  if (manifest.sessionId !== o.sessionId) throw new Error('manifest sessionId does not match offer sessionId');
  if (manifest.from !== o.from) throw new Error('manifest from does not match offer from');
  if (manifest.to !== id.deviceId) throw new Error('manifest to does not match this device');
  return { manifest, ctx };
}

// ---- context persistence (resume state) --------------------------------------------------------

export function exportCtx(ctx: HpkeContext): string {
  return JSON.stringify({
    aead: ctx.aead,
    key: ctx.key.toString('base64'),
    baseNonce: ctx.baseNonce.toString('base64'),
    exporterSecret: ctx.exporterSecret.toString('base64'),
  });
}

const KEY_LEN: Record<HpkeAead, number> = { 'aes-128-gcm': 16, 'aes-256-gcm': 32 };

export function importCtx(s: string): HpkeContext {
  const o: unknown = JSON.parse(s);
  if (!isObj(o)) throw new Error('invalid ctx');
  const aead = o.aead;
  if (aead !== 'aes-128-gcm' && aead !== 'aes-256-gcm') throw new Error('invalid ctx: aead');
  const dec = (v: unknown, len: number, what: string): Buffer => {
    const b = typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.alloc(0);
    if (b.length !== len) throw new Error(`invalid ctx: ${what}`);
    return b;
  };
  return {
    aead,
    key: dec(o.key, KEY_LEN[aead], 'key'),
    baseNonce: dec(o.baseNonce, 12, 'baseNonce'),
    exporterSecret: dec(o.exporterSecret, 32, 'exporterSecret'),
  };
}
