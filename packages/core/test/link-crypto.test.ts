import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LinkCryptoError, openChunk, openManifest, sealChunk, sealManifest } from '../src/links/crypto.ts';

const v = JSON.parse(readFileSync(new URL('../../../protocol/vectors/link-v1.json', import.meta.url), 'utf8'));
const key = Buffer.from(v.keyHex, 'hex');

describe('link crypto', () => {
  it('matches the vector byte for byte', () => {
    const c = v.chunk;
    expect(sealChunk(key, v.linkId, c.fileIdx, c.chunkIdx, c.last, Buffer.from(c.plainHex, 'hex')).toString('hex')).toBe(c.sealedHex);
    expect(openChunk(key, v.linkId, 0, 0, true, Buffer.from(c.sealedHex, 'hex')).toString('hex')).toBe(c.plainHex);
    expect(sealManifest(key, v.linkId, v.manifest.value).toString('hex')).toBe(v.manifest.sealedHex);
    expect(openManifest(key, v.linkId, Buffer.from(v.manifest.sealedHex, 'hex'))).toEqual(v.manifest.value);
  });

  it('refuses a flipped bit, another chunk index, another last flag, another link or key', () => {
    const sealed = Buffer.from(v.chunk.sealedHex, 'hex');
    const flipped = Buffer.from(sealed);
    flipped[3]! ^= 1;
    for (const f of [
      () => openChunk(key, v.linkId, 0, 0, true, flipped),
      () => openChunk(key, v.linkId, 0, 1, true, sealed),
      () => openChunk(key, v.linkId, 1, 0, true, sealed),
      () => openChunk(key, v.linkId, 0, 0, false, sealed),
      () => openChunk(key, 'AAECAwQFBgcICQoLDA0OEA', 0, 0, true, sealed),
      () => openChunk(Buffer.alloc(32, 9), v.linkId, 0, 0, true, sealed),
    ]) expect(f).toThrow(LinkCryptoError);
  });
});
