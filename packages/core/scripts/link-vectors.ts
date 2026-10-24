// Writes protocol/vectors/link-v1.json (fixed key, id and plaintexts): node scripts/link-vectors.ts
import { writeFileSync } from 'node:fs';
import { sealChunk, sealManifest, LINK_DOMAIN } from '../src/links/crypto.ts';

const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const linkId = 'AAECAwQFBgcICQoLDA0ODw';
const plain = Buffer.from('hello, internet guest');
const manifest = { v: 1 as const, files: [{ name: 'hello.txt', size: plain.length, type: 'text/plain' }], text: 'for you' };
const out = {
  description: `Internet link v1. AES-256-GCM, nonce = u32be(file) || u64be(chunk), AAD = utf8("${LINK_DOMAIN}") || 0x00 || utf8(linkId) || 0x00 || u32be(file) || u64be(chunk) || u8(last); sealed = ciphertext || tag. Manifest = file 0xffffffff chunk 0 last, JSON.stringify of the object below.`,
  keyHex: key.toString('hex'),
  keyB64url: key.toString('base64url'),
  linkId,
  chunk: { fileIdx: 0, chunkIdx: 0, last: true, plainHex: plain.toString('hex'), sealedHex: sealChunk(key, linkId, 0, 0, true, plain).toString('hex') },
  manifest: { value: manifest, sealedHex: sealManifest(key, linkId, manifest).toString('hex') },
};
writeFileSync(new URL('../../../protocol/vectors/link-v1.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
