// A minimal ACME (RFC 8555) client for the port-forward mode's public certificate, using the DNS-01
// challenge through DuckDNS's TXT record (no port 80 needed). ES256 account key; flattened JWS.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { buildCsr } from '../x509.ts';

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';

class AcmeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcmeError';
  }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function jwkOf(pub: KeyObject): { crv: string; kty: string; x: string; y: string } {
  const j = pub.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
  return { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
}

/** RFC 7638 thumbprint: SHA-256 of the required members in lexicographic order. */
export const thumbprint = (pub: KeyObject): string => {
  const j = jwkOf(pub);
  return b64u(createHash('sha256').update(`{"crv":"${j.crv}","kty":"${j.kty}","x":"${j.x}","y":"${j.y}"}`).digest());
};

export interface ObtainOptions {
  directoryUrl: string;
  accountKey: { privateKey: KeyObject; publicKey: KeyObject };
  domain: string;
  email?: string;
  /** Publish the DNS-01 TXT value at _acme-challenge.<domain> (DuckDNS: its TXT update). */
  setTxt: (value: string) => Promise<void>;
  clearTxt?: () => Promise<void>;
  /** Time for the TXT record to be visible before Let's Encrypt looks (default 30 s). */
  propagationMs?: number;
  pollMs?: number;
}

export async function obtainCertificate(o: ObtainOptions): Promise<{ certPem: string; keyPem: string }> {
  const poll = o.pollMs ?? 2000;
  const dir = (await (await fetch(o.directoryUrl)).json()) as { newNonce: string; newAccount: string; newOrder: string };
  let nonce = '';
  const freshNonce = async () => {
    const r = await fetch(dir.newNonce, { method: 'HEAD' });
    nonce = r.headers.get('replay-nonce') ?? '';
  };
  await freshNonce();
  let kid: string | undefined;
  const post = async (url: string, payload: unknown | null, retry = true): Promise<Response> => {
    const protectedHeader: Record<string, unknown> = { alg: 'ES256', nonce, url, ...(kid ? { kid } : { jwk: jwkOf(o.accountKey.publicKey) }) };
    const p = b64u(JSON.stringify(protectedHeader));
    const pl = payload === null ? '' : b64u(JSON.stringify(payload));
    const signature = b64u(sign('sha256', Buffer.from(`${p}.${pl}`), { key: o.accountKey.privateKey, dsaEncoding: 'ieee-p1363' }));
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/jose+json' }, body: JSON.stringify({ protected: p, payload: pl, signature }) });
    nonce = r.headers.get('replay-nonce') ?? nonce;
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as { type?: string; detail?: string };
      if (retry && err.type === 'urn:ietf:params:acme:error:badNonce') return post(url, payload, false);
      throw new AcmeError(`ACME ${new URL(url).pathname}: ${err.detail ?? r.status}`);
    }
    return r;
  };
  const acct = await post(dir.newAccount, { termsOfServiceAgreed: true, ...(o.email ? { contact: [`mailto:${o.email}`] } : {}) });
  kid = acct.headers.get('location') ?? undefined;
  if (!kid) throw new AcmeError('ACME account has no location');
  const orderRes = await post(dir.newOrder, { identifiers: [{ type: 'dns', value: o.domain }] });
  const orderUrl = orderRes.headers.get('location')!;
  let order = (await orderRes.json()) as { status: string; authorizations: string[]; finalize: string; certificate?: string };
  try {
    for (const az of order.authorizations) {
      const a = (await (await post(az, null)).json()) as { status: string; challenges: { type: string; url: string; token: string }[] };
      if (a.status === 'valid') continue;
      const ch = a.challenges.find((c) => c.type === 'dns-01');
      if (!ch) throw new AcmeError('the CA offered no DNS-01 challenge');
      await o.setTxt(b64u(createHash('sha256').update(`${ch.token}.${thumbprint(o.accountKey.publicKey)}`).digest()));
      await new Promise((r) => setTimeout(r, o.propagationMs ?? 30_000));
      await post(ch.url, {});
      for (let i = 0; ; i++) {
        const s = (await (await post(az, null)).json()) as { status: string; challenges?: { error?: { detail?: string } }[] };
        if (s.status === 'valid') break;
        if (s.status === 'invalid' || i > 60) throw new AcmeError(`DNS check failed: ${s.challenges?.find((c) => c.error)?.error?.detail ?? s.status}`);
        await new Promise((r) => setTimeout(r, poll));
      }
    }
    const certKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await post(order.finalize, { csr: b64u(buildCsr(o.domain, certKey.publicKey, certKey.privateKey)) });
    for (let i = 0; order.status !== 'valid'; i++) {
      if (order.status === 'invalid' || i > 60) throw new AcmeError('the CA did not issue the certificate');
      await new Promise((r) => setTimeout(r, poll));
      order = (await (await post(orderUrl, null)).json()) as typeof order;
    }
    const certPem = await (await post(order.certificate!, null)).text();
    return { certPem, keyPem: certKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
  } finally {
    await o.clearTxt?.().catch(() => {});
  }
}
