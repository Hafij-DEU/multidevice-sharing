// DuckDNS (M5c port-forward mode): the free dynamic name for the hub, and the TXT record Let's Encrypt's
// DNS-01 challenge reads. The token is the owner's secret: it is never logged or put in events.
import { NatError } from './nat.ts';

export const DUCKDNS_URL = 'https://www.duckdns.org';
const DOMAIN_RE = /^[a-z0-9-]{1,63}$/;

/** `domain` is the part before .duckdns.org. Sets the address (empty: the caller's) and/or the TXT record. */
export async function duckdnsUpdate(o: { domain: string; token: string; ip?: string; txt?: string; clearTxt?: boolean; baseUrl?: string }): Promise<void> {
  const domain = o.domain.replace(/\.duckdns\.org$/i, '').toLowerCase();
  if (!DOMAIN_RE.test(domain)) throw new NatError('invalid DuckDNS name');
  const q = new URLSearchParams({ domains: domain, token: o.token, ip: o.ip ?? '' });
  if (o.txt !== undefined) q.set('txt', o.txt);
  if (o.clearTxt) q.set('clear', 'true');
  let body = '';
  try {
    const r = await fetch(`${o.baseUrl ?? DUCKDNS_URL}/update?${q}`, { signal: AbortSignal.timeout(10_000) });
    body = (await r.text()).trim();
  } catch {
    throw new NatError('DuckDNS did not answer');
  }
  if (!body.startsWith('OK')) throw new NatError('DuckDNS refused the update (check the name and token)');
}
