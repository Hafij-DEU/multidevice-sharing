import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { detect, isShared } from '../src/reach/detect.ts';
import { duckdnsUpdate } from '../src/reach/duckdns.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function serve(fn: (url: string) => string): Promise<string> {
  const s = createServer((req, res) => res.end(fn(req.url ?? '')));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

describe('reach detection', () => {
  it('knows shared address ranges', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.0.9', '100.64.1.1', '100.127.255.1']) expect(isShared(ip)).toBe(true);
    for (const ip of ['203.0.113.7', '100.128.0.1', '172.32.0.1']) expect(isShared(ip)).toBe(false);
  });

  it('suggests a tunnel without UPnP or NAT-PMP, and says which public address it saw', async () => {
    const ipify = await serve(() => '203.0.113.7\n');
    const d = await detect({ publicIpUrls: [ipify], ssdp: { address: '127.0.0.1', port: 9, timeoutMs: 200 }, gateway: null });
    expect(d).toMatchObject({ publicIp: '203.0.113.7', upnp: false, natpmp: false, cgnat: false, suggestion: 'tunnel' });
  });
});

describe('DuckDNS', () => {
  it('updates the address and the TXT record, and reports refusals without the token', async () => {
    const seen: string[] = [];
    const base = await serve((u) => {
      seen.push(u);
      return u.includes('token=good') ? 'OK' : 'KO';
    });
    await duckdnsUpdate({ domain: 'myhub.duckdns.org', token: 'good', baseUrl: base });
    await duckdnsUpdate({ domain: 'myhub', token: 'good', txt: 'abc', baseUrl: base });
    expect(seen[0]).toBe('/update?domains=myhub&token=good&ip=');
    expect(seen[1]).toContain('txt=abc');
    const err = await duckdnsUpdate({ domain: 'myhub', token: 'secret-bad', baseUrl: base }).catch((e: Error) => e);
    expect(String(err)).toMatch(/refused/);
    expect(String(err)).not.toContain('secret-bad');
    await expect(duckdnsUpdate({ domain: 'bad name', token: 'x', baseUrl: base })).rejects.toThrow(/invalid/);
  });
});
