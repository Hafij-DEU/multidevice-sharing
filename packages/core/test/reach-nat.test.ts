import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGateway, igdFromLocation, pmpExternalIp, pmpMap, ssdpDiscover, upnpExternalIp, upnpMap, upnpUnmap } from '../src/reach/nat.ts';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function fakeIgd() {
  const mappings = new Map<string, string>();
  const http: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/desc.xml') {
        res.end(`<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>`);
        return;
      }
      const action = /#(\w+)"/.exec(String(req.headers.soapaction))?.[1];
      if (action === 'GetExternalIPAddress') res.end('<s:Envelope><s:Body><u:R><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:R></s:Body></s:Envelope>');
      else if (action === 'AddPortMapping') {
        mappings.set(/<NewExternalPort>(\d+)/.exec(body)![1]!, `${/<NewInternalClient>([^<]+)/.exec(body)![1]}:${/<NewInternalPort>(\d+)/.exec(body)![1]}`);
        res.end('<ok/>');
      } else if (action === 'DeletePortMapping') {
        mappings.delete(/<NewExternalPort>(\d+)/.exec(body)![1]!);
        res.end('<ok/>');
      } else {
        res.writeHead(500);
        res.end('<errorDescription>Invalid Action</errorDescription>');
      }
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  closers.push(() => http.close());
  const port = (http.address() as { port: number }).port;
  const ssdp: Socket = createSocket('udp4');
  ssdp.on('message', (m, rinfo) => {
    if (m.toString().startsWith('M-SEARCH')) ssdp.send(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${port}/desc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => ssdp.bind(0, '127.0.0.1', () => r()));
  closers.push(() => ssdp.close());
  return { mappings, ssdpPort: ssdp.address().port };
}

describe('UPnP IGD', () => {
  it('discovers the gateway, reads its WAN address, maps and unmaps a port', async () => {
    const g = await fakeIgd();
    const loc = await ssdpDiscover({ address: '127.0.0.1', port: g.ssdpPort, timeoutMs: 2000 });
    const igd = await igdFromLocation(loc);
    expect(igd.service).toBe('urn:schemas-upnp-org:service:WANIPConnection:1');
    expect(await upnpExternalIp(igd)).toBe('203.0.113.7');
    await upnpMap(igd, { externalPort: 443, internalPort: 53322, internalClient: '192.168.1.5', description: 'MeshDrop' });
    expect(g.mappings.get('443')).toBe('192.168.1.5:53322');
    await upnpUnmap(igd, 443);
    expect(g.mappings.size).toBe(0);
  });

  it('times out when nothing answers', async () => {
    await expect(ssdpDiscover({ address: '127.0.0.1', port: 9, timeoutMs: 300 })).rejects.toThrow(/no UPnP gateway/);
  });
});

describe('NAT-PMP', () => {
  it('reads the external address and maps a port', async () => {
    const s = createSocket('udp4');
    s.on('message', (m, r) => {
      if (m[1] === 0) {
        const b = Buffer.alloc(12);
        b[1] = 128;
        Buffer.from([198, 51, 100, 9]).copy(b, 8);
        s.send(b, r.port, r.address);
      } else if (m[1] === 2) {
        const b = Buffer.alloc(16);
        b[1] = 130;
        b.writeUInt16BE(m.readUInt16BE(4), 8);
        b.writeUInt16BE(m.readUInt16BE(6) + 1, 10);
        b.writeUInt32BE(m.readUInt32BE(8), 12);
        s.send(b, r.port, r.address);
      }
    });
    await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
    closers.push(() => s.close());
    const port = s.address().port;
    expect(await pmpExternalIp('127.0.0.1', { port })).toBe('198.51.100.9');
    expect(await pmpMap('127.0.0.1', 53322, 443, 7200, { port })).toBe(444);
  });

  it('finds the default gateway in a route table', () => {
    const d = mkdtempSync(join(tmpdir(), 'md-route-'));
    closers.push(() => rmSync(d, { recursive: true, force: true }));
    writeFileSync(join(d, 'route'), 'Iface\tDestination\tGateway\tFlags\nwlan0\t0001A8C0\t00000000\t0001\nwlan0\t00000000\t0101A8C0\t0003\n');
    expect(defaultGateway(join(d, 'route'))).toBe('192.168.1.1');
  });
});
