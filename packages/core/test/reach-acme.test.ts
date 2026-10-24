import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { obtainCertificate } from '../src/reach/acme.ts';
import { fakeAcme } from './fake-acme.ts';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

describe('ACME DNS-01', () => {
  it('gets a certificate for the name after publishing the right TXT record, then clears it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-acme-'));
    closers.push(() => rmSync(d, { recursive: true, force: true }));
    let txt: string | undefined;
    let cleared = false;
    const ca = await fakeAcme(d, () => txt, closers);
    const r = await obtainCertificate({
      directoryUrl: ca.directoryUrl, accountKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }), domain: 'myhub.duckdns.org',
      setTxt: async (v) => void (txt = v), clearTxt: async () => void (cleared = true), propagationMs: 0, pollMs: 10,
    });
    const leaf = new X509Certificate(r.certPem);
    expect(leaf.subjectAltName).toContain('DNS:myhub.duckdns.org');
    expect(leaf.publicKey.equals(createPublicKey(r.keyPem))).toBe(true);
    expect(cleared).toBe(true);
  });
});
