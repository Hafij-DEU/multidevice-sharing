import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  MAX_MANIFEST_DIRS,
  MAX_MANIFEST_FILES,
  MAX_MANIFEST_TEXT_BYTES,
  acceptOffer,
  chunkAad,
  chunkCount,
  chunkSeq,
  createOffer,
  exportCtx,
  importCtx,
  newSessionId,
  openChunk,
  openManifest,
  sealChunk,
  sealManifest,
  serializeManifest,
  sessionInfo,
  type Manifest,
  type Offer,
} from '../src/chunk.ts';
import { HpkeOpenError, sealAt, setupAuthR, setupAuthS, type HpkeContext } from '../src/crypto/hpke.ts';
import { loadOrCreateIdentity, type Identity } from '../src/identity.ts';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'meshdrop-chunk-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OTHER_SESSION = 'BBBBBBBBBBBBBBBBBBBBBB';
const sha256hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function twoIdentities(): Promise<[Identity, Identity]> {
  return [await loadOrCreateIdentity(tmpDir()), await loadOrCreateIdentity(tmpDir())];
}

function sampleManifest(from: string, to: string, sessionId = newSessionId()): Manifest {
  return {
    v: 1,
    sessionId,
    from,
    to,
    createdAt: 1790000000000,
    files: [
      { fileId: 0, path: 'a.txt', size: 5, mime: 'text/plain', sha256: sha256hex(Buffer.from('hello')) },
      { fileId: 1, path: 'sub/b.bin', size: 0, mime: 'application/octet-stream', sha256: sha256hex(Buffer.alloc(0)) },
    ],
    dirs: [{ path: 'empty-dir' }],
    text: 'hi',
  };
}

describe('chunk arithmetic', () => {
  it('CHUNK_SIZE is 4 MiB', () => expect(CHUNK_SIZE).toBe(4194304));
  it('chunkCount', () => {
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(4194304)).toBe(1);
    expect(chunkCount(4194305)).toBe(2);
    expect(chunkCount(3 * 4194304)).toBe(3);
  });
  it('seq layout', () => {
    expect(chunkSeq(0, 0)).toBe(1n << 32n);
    expect(chunkSeq(2, 5)).toBe((3n << 32n) | 5n);
  });
  it('session info and AAD layout', () => {
    expect(sessionInfo('abc')).toEqual(Buffer.from('meshdrop/v1 abc', 'utf8'));
    expect(chunkAad('abc', 2, 5)).toEqual(Buffer.concat([Buffer.from('abc'), Buffer.from('00000002', 'hex'), Buffer.from('00000005', 'hex')]));
  });
  it('newSessionId is 16 random bytes as base64url', () => {
    const a = newSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(16);
    expect(newSessionId()).not.toBe(a);
  });
});

describe('clipboard messages', () => {
  it('a text-only manifest may carry clipboard:true and round-trips', async () => {
    const [alice, bob] = await twoIdentities();
    const m = { ...sampleManifest(alice.deviceId, bob.deviceId), files: [], dirs: [], text: 'copied', clipboard: true as const };
    const { offer } = createOffer(alice, bob.publicKey, m);
    expect(acceptOffer(bob, alice.publicKey, JSON.parse(JSON.stringify(offer))).manifest).toEqual(m);
  });

  it('clipboard is refused with files, dirs or without text, and must be exactly true', async () => {
    const [alice, bob] = await twoIdentities();
    const base = sampleManifest(alice.deviceId, bob.deviceId);
    expect(() => createOffer(alice, bob.publicKey, { ...base, text: 'x', clipboard: true })).toThrow(/clipboard/);
    const { text: _t, ...noText } = base;
    expect(() => createOffer(alice, bob.publicKey, { ...noText, files: [], dirs: [], clipboard: true })).toThrow(/clipboard/);
    expect(() => createOffer(alice, bob.publicKey, { ...base, files: [], dirs: [], text: 'x', clipboard: false as unknown as true })).toThrow(/clipboard/);
  });
});

describe('offer / manifest sealing', () => {
  it('offer round trip', async () => {
    const [alice, bob] = await twoIdentities();
    const m = sampleManifest(alice.deviceId, bob.deviceId);
    const { offer, ctx } = createOffer(alice, bob.publicKey, m);
    expect(offer).toMatchObject({ v: 1, sessionId: m.sessionId, from: alice.deviceId, to: bob.deviceId });
    // the offer travels as JSON
    const wire = JSON.parse(JSON.stringify(offer));
    const got = acceptOffer(bob, alice.publicKey, wire);
    expect(got.manifest).toEqual(m);
    expect(got.ctx.key.equals(ctx.key)).toBe(true);
    expect(got.ctx.baseNonce.equals(ctx.baseNonce)).toBe(true);
  });

  it('offer to wrong device rejected', async () => {
    const [alice, bob] = await twoIdentities();
    const carol = await loadOrCreateIdentity(tmpDir());
    const { offer } = createOffer(alice, bob.publicKey, sampleManifest(alice.deviceId, bob.deviceId));
    expect(() => acceptOffer(carol, alice.publicKey, offer)).toThrow(/addressed/);
  });

  it('offer from a different sender key fails authentication', async () => {
    const [alice, bob] = await twoIdentities();
    const mallory = await loadOrCreateIdentity(tmpDir());
    const { offer } = createOffer(alice, bob.publicKey, sampleManifest(alice.deviceId, bob.deviceId));
    expect(() => acceptOffer(bob, mallory.publicKey, offer)).toThrow(HpkeOpenError);
  });

  it('rejects manifest/offer sessionId mismatch', async () => {
    const [alice, bob] = await twoIdentities();
    const { offer } = createOffer(alice, bob.publicKey, sampleManifest(alice.deviceId, bob.deviceId));
    // Re-seal under the offer's session context but with a manifest naming another session.
    const info = sessionInfo(offer.sessionId);
    const { enc, ctx } = setupAuthS(bob.publicKey, info, alice.privateKey);
    const forged: Offer = {
      ...offer,
      enc: enc.toString('base64'),
      sealedManifest: sealManifestRaw(ctx, offer.sessionId, sampleManifest(alice.deviceId, bob.deviceId, OTHER_SESSION)).toString('base64'),
    };
    expect(() => acceptOffer(bob, alice.publicKey, forged)).toThrow(/sessionId/);
  });

  it('rejects offer.from that disagrees with the authenticated manifest', async () => {
    const [alice, bob] = await twoIdentities();
    const { offer } = createOffer(alice, bob.publicKey, sampleManifest(alice.deviceId, bob.deviceId));
    expect(() => acceptOffer(bob, alice.publicKey, { ...offer, from: 'e'.repeat(64) })).toThrow(/from/);
    expect(() => acceptOffer(bob, alice.publicKey, { ...offer, from: 'nothex' })).toThrow(/invalid offer/);
    expect(() => acceptOffer(bob, alice.publicKey, { ...offer, from: undefined } as unknown as Offer)).toThrow(/invalid offer/);
  });

  it('rejects a manifest whose to is not this device', async () => {
    const [alice, bob] = await twoIdentities();
    // Offer.to is bob, but the authenticated manifest names someone else.
    const m = sampleManifest(alice.deviceId, 'd'.repeat(64));
    const { enc, ctx } = setupAuthS(bob.publicKey, sessionInfo(m.sessionId), alice.privateKey);
    const forged: Offer = {
      v: 1, sessionId: m.sessionId, from: m.from, to: bob.deviceId,
      enc: enc.toString('base64'), sealedManifest: sealManifest(ctx, m).toString('base64'),
    };
    expect(() => acceptOffer(bob, alice.publicKey, forged)).toThrow(/this device/);
  });

  it('createOffer refuses a manifest not from this identity', async () => {
    const [alice, bob] = await twoIdentities();
    expect(() => createOffer(alice, bob.publicKey, sampleManifest('f'.repeat(64), bob.deviceId))).toThrow(/from/);
  });

  it('manifest shape is validated on seal and open', async () => {
    const [alice, bob] = await twoIdentities();
    const m = sampleManifest(alice.deviceId, bob.deviceId);
    const { ctx } = createOffer(alice, bob.publicKey, m);
    expect(() => sealManifest(ctx, { ...m, v: 2 } as unknown as Manifest)).toThrow(/manifest/);
    expect(() => sealManifest(ctx, { ...m, files: 'x' } as unknown as Manifest)).toThrow(/manifest/);
    expect(() => sealManifest(ctx, { ...m, files: [{ ...m.files[0]!, sha256: 'zz' }] })).toThrow(/manifest/);
    // A correctly-sealed but malformed document is rejected on open.
    const bad = sealManifestRaw(ctx, m.sessionId, { ...m, v: 2 });
    expect(() => openManifest(ctx, m.sessionId, bad)).toThrow(/manifest/);
    // Wrong session AAD fails authentication.
    const ok = sealManifest(ctx, m);
    expect(() => openManifest(ctx, OTHER_SESSION, ok)).toThrow(HpkeOpenError);
    expect(openManifest(ctx, m.sessionId, ok)).toEqual(m);
  });

  it('rejects duplicate fileIds', async () => {
    const [alice, bob] = await twoIdentities();
    const m = sampleManifest(alice.deviceId, bob.deviceId);
    const { ctx } = createOffer(alice, bob.publicKey, m);
    const dup = { ...m, files: [m.files[0]!, { ...m.files[1]!, fileId: 0 }] };
    expect(() => sealManifest(ctx, dup)).toThrow(/duplicate fileId/);
    expect(() => openManifest(ctx, m.sessionId, sealManifestRaw(ctx, m.sessionId, dup))).toThrow(/duplicate fileId/);
  });

  it('constrains sessionId, from and to formats', () => {
    const m = sampleManifest('a'.repeat(64), 'b'.repeat(64));
    expect(() => serializeManifest({ ...m, sessionId: 'sess' })).toThrow(/sessionId/);
    expect(() => serializeManifest({ ...m, sessionId: 'A'.repeat(23) })).toThrow(/sessionId/);
    expect(() => serializeManifest({ ...m, sessionId: 'A'.repeat(21) + '=' })).toThrow(/sessionId/);
    expect(() => serializeManifest({ ...m, from: 'A'.repeat(64) })).toThrow(/from/);
    expect(() => serializeManifest({ ...m, from: 'a'.repeat(63) })).toThrow(/from/);
    expect(() => serializeManifest({ ...m, to: 'b'.repeat(65) })).toThrow(/to/);
  });

  it('enforces size caps (files, dirs, text bytes)', () => {
    const m = sampleManifest('a'.repeat(64), 'b'.repeat(64));
    const f = (i: number) => ({ fileId: i, path: 'p', size: 0, mime: 'x', sha256: '0'.repeat(64) });
    const files = (n: number) => Array.from({ length: n }, (_, i) => f(i));
    const dirs = (n: number) => Array.from({ length: n }, () => ({ path: 'd' }));
    expect(() => serializeManifest({ ...m, files: files(MAX_MANIFEST_FILES) })).not.toThrow();
    expect(() => serializeManifest({ ...m, files: files(MAX_MANIFEST_FILES + 1) })).toThrow(/too many files/);
    expect(() => serializeManifest({ ...m, dirs: dirs(MAX_MANIFEST_DIRS) })).not.toThrow();
    expect(() => serializeManifest({ ...m, dirs: dirs(MAX_MANIFEST_DIRS + 1) })).toThrow(/too many dirs/);
    expect(() => serializeManifest({ ...m, text: 'a'.repeat(MAX_MANIFEST_TEXT_BYTES) })).not.toThrow();
    expect(() => serializeManifest({ ...m, text: 'a'.repeat(MAX_MANIFEST_TEXT_BYTES + 1) })).toThrow(/text too large/);
    // cap is on UTF-8 bytes, not characters: 2-byte chars
    expect(() => serializeManifest({ ...m, text: '\u00e9'.repeat(MAX_MANIFEST_TEXT_BYTES / 2 + 1) })).toThrow(/text too large/);
    expect(() => serializeManifest({ ...m, text: '\u00e9'.repeat(MAX_MANIFEST_TEXT_BYTES / 2) })).not.toThrow();
  });

  it('manifest serialization is deterministic regardless of input key order', () => {
    const m = sampleManifest('a'.repeat(64), 'b'.repeat(64), OTHER_SESSION);
    const shuffled = { text: m.text, dirs: m.dirs, files: m.files.map((f) => ({ sha256: f.sha256, mime: f.mime, size: f.size, path: f.path, fileId: f.fileId })), createdAt: m.createdAt, to: m.to, from: m.from, sessionId: m.sessionId, v: 1 } as Manifest;
    expect(serializeManifest(shuffled)).toBe(serializeManifest(m));
    expect(serializeManifest(m).startsWith(`{"v":1,"sessionId":"${OTHER_SESSION}","from":"`)).toBe(true);
    const { text: _t, ...noText } = m;
    expect(serializeManifest(noText as Manifest)).not.toContain('"text"');
  });
});

describe('chunks', () => {
  it('seal/open round trip', async () => {
    const [alice, bob] = await twoIdentities();
    const m = sampleManifest(alice.deviceId, bob.deviceId);
    const { offer, ctx } = createOffer(alice, bob.publicKey, m);
    const rx = acceptOffer(bob, alice.publicKey, offer).ctx;
    const pt = Buffer.from('hello');
    const ct = sealChunk(ctx, m.sessionId, 0, 0, pt);
    expect(ct).toHaveLength(pt.length + 16);
    expect(openChunk(rx, m.sessionId, 0, 0, ct)).toEqual(pt);
  });

  it('chunk bound to position', async () => {
    const [alice, bob] = await twoIdentities();
    const m = sampleManifest(alice.deviceId, bob.deviceId);
    const { ctx } = createOffer(alice, bob.publicKey, m);
    const ct = sealChunk(ctx, m.sessionId, 0, 1, Buffer.from('payload'));
    expect(openChunk(ctx, m.sessionId, 0, 1, ct)).toEqual(Buffer.from('payload'));
    expect(() => openChunk(ctx, m.sessionId, 0, 2, ct)).toThrow(HpkeOpenError);
    expect(() => openChunk(ctx, m.sessionId, 1, 1, ct)).toThrow(HpkeOpenError);
    expect(() => openChunk(ctx, 'other-session', 0, 1, ct)).toThrow(HpkeOpenError);
  });

  it('manifest ciphertext cannot be replayed as a chunk', async () => {
    const [alice, bob] = await twoIdentities();
    const m = sampleManifest(alice.deviceId, bob.deviceId);
    const { offer, ctx } = createOffer(alice, bob.publicKey, m);
    const sealed = Buffer.from(offer.sealedManifest, 'base64');
    expect(() => openChunk(ctx, m.sessionId, 0, 0, sealed)).toThrow(HpkeOpenError);
  });

  it('rejects out-of-range ids and oversized chunks', async () => {
    const [alice, bob] = await twoIdentities();
    const { ctx } = createOffer(alice, bob.publicKey, sampleManifest(alice.deviceId, bob.deviceId));
    expect(() => sealChunk(ctx, 's', -1, 0, Buffer.alloc(1))).toThrow(RangeError);
    expect(() => sealChunk(ctx, 's', 0, 2 ** 32, Buffer.alloc(1))).toThrow(RangeError);
    expect(() => sealChunk(ctx, 's', 0, 0, Buffer.alloc(CHUNK_SIZE + 1))).toThrow(RangeError);
    expect(sealChunk(ctx, 's', 0, 0, Buffer.alloc(CHUNK_SIZE))).toHaveLength(CHUNK_SIZE + 16);
  });
});

describe('ctx persistence', () => {
  it('exportCtx/importCtx round trip keeps the context usable', async () => {
    const [alice, bob] = await twoIdentities();
    const m = sampleManifest(alice.deviceId, bob.deviceId);
    const { offer, ctx } = createOffer(alice, bob.publicKey, m);
    const s = exportCtx(ctx);
    expect(typeof s).toBe('string');
    const back = importCtx(s);
    expect(back).toEqual(ctx);
    const ct = sealChunk(ctx, m.sessionId, 1, 0, Buffer.from('x'));
    expect(openChunk(back, m.sessionId, 1, 0, ct)).toEqual(Buffer.from('x'));
    expect(openManifest(back, m.sessionId, Buffer.from(offer.sealedManifest, 'base64'))).toEqual(m);
  });
  it('importCtx rejects garbage', () => {
    expect(() => importCtx('not json')).toThrow();
    expect(() => importCtx(JSON.stringify({ key: 'AA==', baseNonce: 'AA==', exporterSecret: 'AA==', aead: 'aes-256-gcm' }))).toThrow(/ctx/);
    expect(() => importCtx(JSON.stringify({ key: '', baseNonce: '', exporterSecret: '', aead: 'rot13' }))).toThrow(/ctx/);
  });
});

// ---------------------------------------------------------------------------------------------
// Frozen cross-engine vectors: protocol/vectors/chunk-v1.json
// ---------------------------------------------------------------------------------------------

const VECTOR_URL = new URL('../../../protocol/vectors/chunk-v1.json', import.meta.url);

/** P-256 private key from its raw 32-byte scalar (PKCS#8 without the optional public key). */
function privFromScalar(dHex: string): KeyObject {
  const der = Buffer.concat([Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'), Buffer.from(dHex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
function pubHex(sk: KeyObject): string {
  const jwk = createPublicKey(sk).export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('hex');
}
function fakeIdentity(deviceId: string, sk: KeyObject): Identity {
  return { deviceId, privateKey: sk, publicKey: createPublicKey(sk), certDer: Buffer.alloc(0), certPem: '', keyPem: '' };
}

const CHUNK_PLAINTEXT = Buffer.from('00112233445566778899', 'hex'); // the 10-byte file

const INPUTS = {
  senderPrivateKeyScalarHex: '4b1e54cdaf25624ade1bc2bae65dfa0596aeac64bccb4370fd91c0c4daa80524',
  receiverPrivateKeyScalarHex: '26b079d7ee5747edcd754daf81d0567eb231fc70369ff836f6dbd109e9567a8d',
  skEScalarHex: 'de60b8ba4de931c4856cd335a7ef0dd5dc403f6831c2e620f174b7cface0f4ab',
  sessionId: 'AAECAwQFBgcICQoLDA0ODw', // base64url of bytes 00..0f
  fromDeviceId: '11'.repeat(32),
  toDeviceId: '22'.repeat(32),
  chunkFileId: 0,
  chunkIndex: 0,
  chunkPlaintextHex: CHUNK_PLAINTEXT.toString('hex'),
};

function buildManifest(i: typeof INPUTS): Manifest {
  return {
    v: 1,
    sessionId: i.sessionId,
    from: i.fromDeviceId,
    to: i.toDeviceId,
    createdAt: 1790000000000,
    files: [
      {
        fileId: 0,
        path: 'docs/héllo.bin', // non-ASCII on purpose: serialization must be raw UTF-8
        size: 10,
        mime: 'application/octet-stream',
        sha256: sha256hex(Buffer.from(i.chunkPlaintextHex, 'hex')),
      },
    ],
    dirs: [{ path: 'empty/dir' }],
    text: 'hi "quoted"\n',
  };
}

const NOTES = [
  'Frozen MeshDrop chunk/manifest sealing vector (v1). A second engine (Java) must reproduce every output byte-for-byte from the inputs.',
  'Keys: P-256 private keys are given as raw 32-byte big-endian scalars (d); public keys as uncompressed SEC1 points (04||X||Y), hex.',
  'HPKE: RFC 9180 mode_auth 0x02, DHKEM(P-256,HKDF-SHA256) 0x0010, HKDF-SHA256 0x0001, AES-256-GCM 0x0002. Sender runs SetupAuthS(pkR=receiver public, info, skS=sender private) with the fixed ephemeral skE; receiver runs SetupAuthR(enc, skR, info, pkS).',
  'info = UTF-8("meshdrop/v1 " + sessionId).',
  'Nonce for seq: baseNonce XOR I2OSP(seq, 12) (RFC 9180 section 5.2). seal output = ciphertext || 16-byte GCM tag.',
  'Manifest seq = 0, AAD = UTF-8(sessionId). Manifest plaintext = UTF-8 of manifestJson below.',
  'manifestJson serialization: compact JSON (no whitespace) with keys in fixed order. Manifest: v, sessionId, from, to, createdAt, files, dirs, then text (omitted when absent). File entry: fileId, path, size, mime, sha256. Dir entry: path. Integers as plain decimal. Strings escape only ", \\, and control chars below U+0020 (as \\b \\f \\n \\r \\t, others \\u00xx with lowercase hex); everything else, including non-ASCII, is raw UTF-8 (this is exactly ECMAScript JSON.stringify).',
  'Chunk seq = ((fileId + 1) << 32) | chunkIndex (fileId, chunkIndex are u32). AAD = UTF-8(sessionId) || u32be(fileId) || u32be(chunkIndex).',
  'Offer wire fields: enc and sealedManifest are standard base64 (with padding) of the hex values given here.',
];

interface VectorFile {
  description: string[];
  inputs: typeof INPUTS & {
    senderPublicKeyHex: string;
    receiverPublicKeyHex: string;
    skEPublicKeyHex: string;
  };
  manifest: Manifest;
  manifestJson: string;
  manifestJsonHex: string;
  infoHex: string;
  manifestSeq: string;
  manifestAadHex: string;
  encHex: string;
  keyHex: string;
  baseNonceHex: string;
  exporterSecretHex: string;
  sealedManifestHex: string;
  offer: { v: 1; sessionId: string; from: string; to: string; enc: string; sealedManifest: string };
  chunk: { fileId: number; index: number; plaintextHex: string; seq: string; seqHex: string; aadHex: string; sealedHex: string };
}

function compute(i: typeof INPUTS): VectorFile {
  const skS = privFromScalar(i.senderPrivateKeyScalarHex);
  const skR = privFromScalar(i.receiverPrivateKeyScalarHex);
  const skE = privFromScalar(i.skEScalarHex);
  const manifest = buildManifest(i);
  const sender = fakeIdentity(i.fromDeviceId, skS);
  const { offer, ctx } = createOffer(sender, createPublicKey(skR), manifest, { skE });
  const pt = Buffer.from(i.chunkPlaintextHex, 'hex');
  const sealed = sealChunk(ctx, i.sessionId, i.chunkFileId, i.chunkIndex, pt);
  const json = serializeManifest(manifest);
  const seq = chunkSeq(i.chunkFileId, i.chunkIndex);
  return {
    description: NOTES,
    inputs: {
      ...i,
      senderPublicKeyHex: pubHex(skS),
      receiverPublicKeyHex: pubHex(skR),
      skEPublicKeyHex: pubHex(skE),
    },
    manifest,
    manifestJson: json,
    manifestJsonHex: Buffer.from(json, 'utf8').toString('hex'),
    infoHex: sessionInfo(i.sessionId).toString('hex'),
    manifestSeq: '0',
    manifestAadHex: Buffer.from(i.sessionId, 'utf8').toString('hex'),
    encHex: Buffer.from(offer.enc, 'base64').toString('hex'),
    keyHex: ctx.key.toString('hex'),
    baseNonceHex: ctx.baseNonce.toString('hex'),
    exporterSecretHex: ctx.exporterSecret.toString('hex'),
    sealedManifestHex: Buffer.from(offer.sealedManifest, 'base64').toString('hex'),
    offer,
    chunk: {
      fileId: i.chunkFileId,
      index: i.chunkIndex,
      plaintextHex: i.chunkPlaintextHex,
      seq: seq.toString(),
      seqHex: seq.toString(16).padStart(24, '0'),
      aadHex: chunkAad(i.sessionId, i.chunkFileId, i.chunkIndex).toString('hex'),
      sealedHex: sealed.toString('hex'),
    },
  };
}

describe('frozen vectors (chunk-v1.json)', () => {
  if (process.env.UPDATE_VECTORS === '1') {
    it('regenerates chunk-v1.json', () => {
      writeFileSync(VECTOR_URL, JSON.stringify(compute(INPUTS), null, 2) + '\n');
      expect(existsSync(VECTOR_URL)).toBe(true);
    });
  }

  it('reproduces enc, sealedManifest and chunk 0 byte-for-byte', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as VectorFile;
    const got = compute(vec.inputs);
    expect(got).toEqual(vec);
    // Independent checks of the pieces a second engine must match.
    expect(vec.manifestJson).toBe(serializeManifest(vec.manifest));
    expect(vec.manifestJsonHex).toBe(Buffer.from(vec.manifestJson, 'utf8').toString('hex'));
    expect(vec.infoHex).toBe(Buffer.from('meshdrop/v1 ' + vec.inputs.sessionId).toString('hex'));
    expect(vec.chunk.aadHex).toBe(
      Buffer.from(vec.inputs.sessionId).toString('hex') + '00000000' + '00000000',
    );
    expect(vec.chunk.seq).toBe((1n << 32n).toString());
  });

  it('the stored vector decrypts under the receiver key', () => {
    const vec = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as VectorFile;
    const skR = privFromScalar(vec.inputs.receiverPrivateKeyScalarHex);
    const receiver = fakeIdentity(vec.inputs.toDeviceId, skR);
    const senderPub = createPublicKey(privFromScalar(vec.inputs.senderPrivateKeyScalarHex));
    const { manifest, ctx } = acceptOffer(receiver, senderPub, vec.offer);
    expect(manifest).toEqual(vec.manifest);
    const pt = openChunk(ctx, vec.inputs.sessionId, vec.chunk.fileId, vec.chunk.index, Buffer.from(vec.chunk.sealedHex, 'hex'));
    expect(pt.toString('hex')).toBe(vec.chunk.plaintextHex);
    // Raw HPKE path agrees with the helper path.
    const ctx2 = setupAuthR(Buffer.from(vec.encHex, 'hex'), skR, Buffer.from(vec.infoHex, 'hex'), senderPub);
    expect(ctx2.key.toString('hex')).toBe(vec.keyHex);
  });
});

// Test-only helper to forge a manifest ciphertext that bypasses sealManifest validation / session checks.
function sealManifestRaw(ctx: HpkeContext, sessionId: string, m: unknown): Buffer {
  return sealAt(ctx, 0n, Buffer.from(sessionId, 'utf8'), Buffer.from(JSON.stringify(m), 'utf8'));
}
