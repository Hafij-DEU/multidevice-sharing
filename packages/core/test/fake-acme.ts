// Test helper (not a test file): a fake ACME CA that checks every JWS and signs with openssl.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { thumbprint } from '../src/reach/acme.ts';

/** A fake ACME CA: checks every JWS, accepts DNS-01 when the published TXT is right, signs with openssl. */
export async function fakeAcme(dir: string, txtOf: () => string | undefined, closers: (() => void)[]) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.pem'), '-subj', '/CN=Fake ACME CA', '-days', '2'], { stdio: 'ignore' });
  let n = 0;
  const nonces = new Set<string>();
  const accounts = new Map<string, unknown>();
  const state = { authz: 'pending', order: 'pending', token: 'tok-123', cert: '', jwk: null as unknown };
  let base = '';
  const s: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const nonce = `n${n++}`;
      nonces.add(nonce);
      res.setHeader('replay-nonce', nonce);
      const url = req.url ?? '';
      if (url === '/dir') return res.end(JSON.stringify({ newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order` }));
      if (url === '/nonce') return res.end();
      const jws = JSON.parse(body) as { protected: string; payload: string; signature: string };
      const p = JSON.parse(Buffer.from(jws.protected, 'base64url').toString()) as { nonce: string; url: string; jwk?: object; kid?: string };
      const key = createPublicKey({ key: (p.jwk ?? accounts.get(p.kid!)) as never, format: 'jwk' });
      const okSig = verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'));
      if (!okSig || !nonces.delete(p.nonce) || p.url !== `${base}${url}`) {
        res.writeHead(400);
        return res.end(JSON.stringify({ type: 'urn:ietf:params:acme:error:malformed', detail: 'bad jws' }));
      }
      const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url').toString()) : null;
      if (url === '/acct') {
        accounts.set(`${base}/acct/1`, p.jwk);
        state.jwk = p.jwk;
        res.setHeader('location', `${base}/acct/1`);
        return res.end('{}');
      }
      const order = () => JSON.stringify({ status: state.order, authorizations: [`${base}/authz`], finalize: `${base}/finalize`, ...(state.order === 'valid' ? { certificate: `${base}/cert` } : {}) });
      if (url === '/order') {
        res.setHeader('location', `${base}/order/1`);
        return res.end(order());
      }
      if (url === '/order/1') return res.end(order());
      if (url === '/authz') return res.end(JSON.stringify({ status: state.authz, challenges: [{ type: 'http-01', url: `${base}/x`, token: 'no' }, { type: 'dns-01', url: `${base}/chal`, token: state.token }] }));
      if (url === '/chal') {
        const want = createHash('sha256').update(`${state.token}.${thumbprint(createPublicKey({ key: state.jwk as never, format: 'jwk' }))}`).digest('base64url');
        state.authz = txtOf() === want ? 'valid' : 'invalid';
        return res.end('{}');
      }
      if (url === '/finalize') {
        const csrDer = Buffer.from(payload.csr, 'base64url');
        writeFileSync(join(dir, 'req.pem'), `-----BEGIN CERTIFICATE REQUEST-----\n${csrDer.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE REQUEST-----\n`);
        execFileSync('openssl', ['req', '-in', join(dir, 'req.pem'), '-verify', '-noout'], { stdio: 'ignore' });
        execFileSync('openssl', ['x509', '-req', '-in', join(dir, 'req.pem'), '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'leaf.pem'), '-days', '2', '-copy_extensions', 'copy'], { stdio: 'ignore' });
        state.cert = readFileSync(join(dir, 'leaf.pem'), 'utf8') + readFileSync(join(dir, 'ca.pem'), 'utf8');
        state.order = 'valid';
        return res.end(order());
      }
      if (url === '/cert') {
        res.setHeader('content-type', 'application/pem-certificate-chain');
        return res.end(state.cert);
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  closers.push(() => s.close());
  return { directoryUrl: `${base}/dir`, caPem: () => readFileSync(join(dir, 'ca.pem'), 'utf8') };
}

