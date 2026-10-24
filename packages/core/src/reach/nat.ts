// Port forwarding on the owner's router (M5c): UPnP IGD (SSDP + SOAP) and NAT-PMP (RFC 6886).
// Both are LAN-only protocols spoken to the default gateway; no dependency, no shell.
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';

export class NatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NatError';
  }
}

// ---- UPnP IGD ------------------------------------------------------------------------------------

const IGD_TYPES = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2'];
const WAN_SERVICE = /urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:\d/;

/** SSDP M-SEARCH for an Internet Gateway Device; resolves its description URL (LOCATION). */
export function ssdpDiscover(opts: { address?: string; port?: number; timeoutMs?: number } = {}): Promise<string> {
  const address = opts.address ?? '239.255.255.250';
  const port = opts.port ?? 1900;
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4');
    const done = (err: Error | null, loc?: string) => {
      clearTimeout(timer);
      s.close();
      if (err) reject(err);
      else resolve(loc!);
    };
    const timer = setTimeout(() => done(new NatError('no UPnP gateway answered')), opts.timeoutMs ?? 3000);
    s.on('error', (e) => done(e));
    s.on('message', (msg) => {
      const m = /^location:\s*(\S+)/im.exec(msg.toString('latin1'));
      if (m && /^http:\/\//i.test(m[1]!)) done(null, m[1]!);
    });
    s.bind(0, () => {
      for (const st of IGD_TYPES) {
        const req = `M-SEARCH * HTTP/1.1\r\nHOST: ${address}:${port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        s.send(req, port, address);
      }
    });
  });
}

const tag = (xml: string, name: string): string | undefined => new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1]?.trim();
const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export interface Igd { control: string; service: string }

/** Reads the device description and finds the WAN connection service's control URL. */
export async function igdFromLocation(location: string, timeoutMs = 5000): Promise<Igd> {
  const r = await fetch(location, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new NatError(`gateway description: HTTP ${r.status}`);
  const xml = (await r.text()).slice(0, 1_000_000);
  for (const svc of xml.split(/<service>/i).slice(1)) {
    const type = tag(svc, 'serviceType');
    const ctl = tag(svc, 'controlURL');
    if (type && ctl && WAN_SERVICE.test(type)) return { service: type, control: new URL(ctl, tag(xml, 'URLBase') || location).toString() };
  }
  throw new NatError('the gateway has no WAN connection service');
}

async function soap(igd: Igd, action: string, args: Record<string, string | number>, timeoutMs = 5000): Promise<string> {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${igd.service}">${Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
    .join('')}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(igd.control, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${igd.service}#${action}"` },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = (await r.text()).slice(0, 1_000_000);
  if (!r.ok) throw new NatError(`UPnP ${action} refused: ${tag(text, 'errorDescription') ?? `HTTP ${r.status}`}`);
  return text;
}

export async function upnpExternalIp(igd: Igd): Promise<string> {
  const ip = tag(await soap(igd, 'GetExternalIPAddress', {}), 'NewExternalIPAddress');
  if (!ip) throw new NatError('the gateway did not say its external address');
  return ip;
}

export async function upnpMap(igd: Igd, m: { externalPort: number; internalPort: number; internalClient: string; description: string; leaseSec?: number }): Promise<void> {
  await soap(igd, 'AddPortMapping', {
    NewRemoteHost: '', NewExternalPort: m.externalPort, NewProtocol: 'TCP', NewInternalPort: m.internalPort,
    NewInternalClient: m.internalClient, NewEnabled: 1, NewPortMappingDescription: m.description, NewLeaseDuration: m.leaseSec ?? 0,
  });
}

export async function upnpUnmap(igd: Igd, externalPort: number): Promise<void> {
  await soap(igd, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: 'TCP' });
}

/** The local address this host uses to reach `host` (what the router should forward to). */
export function localAddressFor(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4');
    s.on('error', reject);
    s.connect(9, host, () => {
      const a = s.address().address;
      s.close();
      resolve(a);
    });
  });
}

// ---- NAT-PMP -------------------------------------------------------------------------------------

/** The IPv4 default gateway from /proc/net/route (Linux), or null. */
export function defaultGateway(routeFile = '/proc/net/route'): string | null {
  try {
    for (const line of readFileSync(routeFile, 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === '00000000' && f[2] && f[2] !== '00000000') {
        const n = parseInt(f[2], 16);
        return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
      }
    }
  } catch {
    /* not Linux */
  }
  return null;
}

function pmp(gateway: string, req: Buffer, op: number, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4');
    let wait = 250;
    let timer: NodeJS.Timeout;
    const done = (err: Error | null, b?: Buffer) => {
      clearTimeout(timer);
      s.close();
      if (err) reject(err);
      else resolve(b!);
    };
    const deadline = Date.now() + timeoutMs;
    const send = () => {
      if (Date.now() > deadline) return done(new NatError('no NAT-PMP answer from the gateway'));
      s.send(req, port, gateway);
      timer = setTimeout(send, wait);
      wait *= 2;
    };
    s.on('error', (e) => done(e));
    s.on('message', (b) => {
      if (b.length < 8 || b[0] !== 0 || b[1] !== op) return;
      const result = b.readUInt16BE(2);
      if (result !== 0) return done(new NatError(`NAT-PMP refused (result ${result})`));
      done(null, b);
    });
    s.bind(0, send);
  });
}

export async function pmpExternalIp(gateway: string, opts: { port?: number; timeoutMs?: number } = {}): Promise<string> {
  const b = await pmp(gateway, Buffer.from([0, 0]), 128, opts.port ?? 5351, opts.timeoutMs ?? 2000);
  if (b.length < 12) throw new NatError('short NAT-PMP answer');
  return [b[8], b[9], b[10], b[11]].join('.');
}

/** Maps TCP `internalPort` → `externalPort` for `lifetimeSec` (0 removes it); returns the port granted. */
export async function pmpMap(gateway: string, internalPort: number, externalPort: number, lifetimeSec: number, opts: { port?: number; timeoutMs?: number } = {}): Promise<number> {
  const req = Buffer.alloc(12);
  req[0] = 0;
  req[1] = 2;
  req.writeUInt16BE(internalPort, 4);
  req.writeUInt16BE(externalPort, 6);
  req.writeUInt32BE(lifetimeSec, 8);
  const b = await pmp(gateway, req, 130, opts.port ?? 5351, opts.timeoutMs ?? 2000);
  if (b.length < 16) throw new NatError('short NAT-PMP answer');
  return b.readUInt16BE(10);
}
