// Which internet mode can work here (M5c): the router's WAN address (UPnP, else NAT-PMP) against the
// public address seen from outside. A WAN address in a private or CGNAT range, or one that differs
// from the public address, means inbound connections never reach this router: port forwarding cannot
// work and a tunnel is the way.
import { NatError, defaultGateway, igdFromLocation, pmpExternalIp, ssdpDiscover, upnpExternalIp, type Igd } from './nat.ts';

export const DEFAULT_PUBLIC_IP_URLS = ['https://api.ipify.org', 'https://ifconfig.me/ip'];
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isShared(ip: string): boolean {
  const m = IPV4.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a === 127;
}

export interface Detection {
  /** What the router says its WAN address is. */
  wanIp?: string;
  /** This network's address as seen from outside. */
  publicIp?: string;
  upnp: boolean;
  natpmp: boolean;
  /** Inbound connections cannot reach this network (carrier-grade NAT or a second router). */
  cgnat: boolean;
  suggestion: 'tunnel' | 'port-forward';
  /** One sentence for the owner. */
  reason: string;
  igd?: Igd;
}

export interface DetectOptions {
  publicIpUrls?: string[];
  ssdp?: { address?: string; port?: number; timeoutMs?: number };
  gateway?: string | null;
  natpmpPort?: number;
}

export async function publicIp(urls: string[] = DEFAULT_PUBLIC_IP_URLS): Promise<string | undefined> {
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
      const t = (await r.text()).trim();
      if (r.ok && IPV4.test(t)) return t;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export async function detect(o: DetectOptions = {}): Promise<Detection> {
  let wanIp: string | undefined;
  let igd: Igd | undefined;
  let upnp = false;
  let natpmp = false;
  try {
    igd = await igdFromLocation(await ssdpDiscover({ timeoutMs: 2500, ...o.ssdp }));
    wanIp = await upnpExternalIp(igd);
    upnp = true;
  } catch (e) {
    if (!(e instanceof NatError) && !(e instanceof Error)) throw e;
  }
  if (!wanIp) {
    const gw = o.gateway === undefined ? defaultGateway() : o.gateway;
    if (gw) {
      try {
        wanIp = await pmpExternalIp(gw, o.natpmpPort !== undefined ? { port: o.natpmpPort } : {});
        natpmp = true;
      } catch {
        /* no NAT-PMP */
      }
    }
  }
  const pub = await publicIp(o.publicIpUrls);
  const behindCgnat = (wanIp !== undefined && isShared(wanIp)) || (wanIp !== undefined && pub !== undefined && wanIp !== pub);
  const base = { ...(wanIp ? { wanIp } : {}), ...(pub ? { publicIp: pub } : {}), ...(igd ? { igd } : {}), upnp, natpmp, cgnat: behindCgnat };
  if (behindCgnat) {
    return { ...base, suggestion: 'tunnel', reason: `Your router's internet address (${wanIp}) is not your public address${pub ? ` (${pub})` : ''}: your provider shares it (CGNAT), so port forwarding cannot work. Use a tunnel.` };
  }
  if (upnp || natpmp) {
    return { ...base, suggestion: 'port-forward', reason: `Your router can open a port automatically (${upnp ? 'UPnP' : 'NAT-PMP'}) and has a public address${pub ? ` (${pub})` : ''}: port forwarding can work. A tunnel works too.` };
  }
  return { ...base, suggestion: 'tunnel', reason: 'Your router does not open ports automatically. A tunnel is simplest; port forwarding needs a manual rule on the router.' };
}
