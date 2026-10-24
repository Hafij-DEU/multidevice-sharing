import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LINK_CRYPTO_JS, LINK_PAGE } from '../src/links/page.ts';

const v = JSON.parse(readFileSync(new URL('../../../protocol/vectors/link-v1.json', import.meta.url), 'utf8'));

describe('link page', () => {
  it('is valid JavaScript, builds no HTML from strings, and decrypts with WebCrypto', () => {
    const d = mkdtempSync(join(tmpdir(), 'md-lpage-'));
    try {
      writeFileSync(join(d, 'app.js'), LINK_PAGE.js);
      execFileSync(process.execPath, ['--check', join(d, 'app.js')]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
    expect(LINK_PAGE.js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(LINK_PAGE.js).toContain("crypto.subtle.decrypt({ name: 'AES-GCM'");
    expect(LINK_PAGE.html).not.toMatch(/<script>|style=/);
  });

  it('its crypto helpers match the Node format (vector), both ways', async () => {
    const helpers = new Function(`${LINK_CRYPTO_JS}; return { b64urlToBytes, bytesToB64url, linkImportKey, linkOpen, linkSeal, MANIFEST_FILE };`)();
    const raw = helpers.b64urlToBytes(v.keyB64url);
    expect(Buffer.from(raw).toString('hex')).toBe(v.keyHex);
    expect(helpers.bytesToB64url(raw)).toBe(v.keyB64url);
    const key = await helpers.linkImportKey(raw);
    const plain = await helpers.linkOpen(key, v.linkId, 0, 0, true, Buffer.from(v.chunk.sealedHex, 'hex'));
    expect(Buffer.from(plain).toString('hex')).toBe(v.chunk.plainHex);
    const sealed = await helpers.linkSeal(key, v.linkId, 0, 0, true, Buffer.from(v.chunk.plainHex, 'hex'));
    expect(Buffer.from(sealed).toString('hex')).toBe(v.chunk.sealedHex);
    const man = await helpers.linkOpen(key, v.linkId, helpers.MANIFEST_FILE, 0, true, Buffer.from(v.manifest.sealedHex, 'hex'));
    expect(JSON.parse(Buffer.from(man).toString())).toEqual(v.manifest.value);
    await expect(helpers.linkOpen(key, v.linkId, 0, 1, true, Buffer.from(v.chunk.sealedHex, 'hex'))).rejects.toThrow();
  });
});
