// Internet reach (M5c): one mode at a time, chosen by the owner, kept in <home>/reach/.
//   tailscale     Funnel publishes the ingress at https://<machine>.<tailnet>.ts.net
//   cloudflare    a named tunnel publishes it at https://<host> (a hostname on the owner's domain)
//   port-forward  a public HTTPS listener (Let's Encrypt certificate for <name>.duckdns.org) that the
//                 router forwards to (UPnP or NAT-PMP when the router allows, else a manual rule)
// When a mode is up, its wss:// URL is the hub URL devices and internet links use.
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import { writeFileAtomic } from '../trust.ts';
import { LETS_ENCRYPT, obtainCertificate } from './acme.ts';
import { detect, type DetectOptions, type Detection } from './detect.ts';
import { DUCKDNS_URL, duckdnsUpdate } from './duckdns.ts';
import { defaultGateway, igdFromLocation, localAddressFor, pmpMap, ssdpDiscover, upnpMap, upnpUnmap, type Igd } from './nat.ts';
import { execRunner, execSpawner, type Runner, type Spawner } from './runner.ts';
import { Cloudflare, Tailscale } from './tunnel.ts';

export type ReachMode = 'off' | 'tailscale' | 'cloudflare' | 'port-forward';

export interface ReachConfig {
  mode: ReachMode;
  cloudflareHost?: string;
  duckdnsDomain?: string;
  /** What the router forwards (default 443) and what we listen on (default 53322). */
  externalPort?: number;
  internalPort?: number;
  /** Router rule: 'auto' (UPnP, else NAT-PMP) or 'manual' (the owner made it). */
  mapping?: 'auto' | 'manual';
  email?: string;
  staging?: boolean;
}

export interface ReachStatus {
  mode: ReachMode;
  state: 'off' | 'starting' | 'on' | 'error' | 'missing' | 'logged-out';
  url?: string;
  host?: string;
  error?: string;
  fix?: string;
  certExpiresAt?: number;
  tokenSet: boolean;
  /** Port-forward: how the router rule was made, and the local port it must point at. */
  mapped?: 'upnp' | 'natpmp' | 'manual';
  listenPort?: number;
}

export interface ReachEnv {
  home: string;
  ingressPort: () => number;
  /** Serve the hub (WebSocket + /l/ links) on a public HTTPS server. */
  attachPublic: (server: HttpsServer) => void;
  /** Make `url` this hub's internet URL (replacing `previous`, if any). */
  publish: (url: string | null, previous: string | null) => Promise<void>;
  runner?: Runner;
  spawner?: Spawner;
  acmeDirectory?: string;
  duckdnsUrl?: string;
  detect?: DetectOptions;
  /** Seconds to wait for the TXT record (tests: 0). */
  propagationMs?: number;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const DAY = 86_400_000;

export class ReachManager {
  readonly #e: ReachEnv;
  readonly #dir: string;
  #cfg: ReachConfig = { mode: 'off' };
  #status: ReachStatus = { mode: 'off', state: 'off', tokenSet: false };
  #tailscale: Tailscale;
  #cloudflare: Cloudflare | null = null;
  #server: HttpsServer | null = null;
  #igd: Igd | null = null;
  #renew: NodeJS.Timeout | null = null;
  #published: string | null = null;
  #lastDetection: Detection | null = null;

  constructor(env: ReachEnv) {
    this.#e = env;
    this.#dir = join(env.home, 'reach');
    this.#tailscale = new Tailscale(env.runner ?? execRunner, env.ingressPort);
    try {
      this.#cfg = JSON.parse(readFileSync(join(this.#dir, 'config.json'), 'utf8')) as ReachConfig;
    } catch {
      /* none yet */
    }
    this.#status = { mode: this.#cfg.mode, state: 'off', tokenSet: this.#tokenSet() };
  }

  get config(): ReachConfig {
    return { ...this.#cfg };
  }

  status(): ReachStatus {
    if (this.#cfg.mode === 'cloudflare' && this.#cloudflare) {
      const c = this.#cloudflare.status();
      return { ...this.#status, state: c.state === 'on' ? 'on' : c.state === 'off' ? this.#status.state : 'error', ...(c.error ? { error: c.error } : {}) };
    }
    return { ...this.#status, tokenSet: this.#tokenSet() };
  }

  lastDetection(): Omit<Detection, 'igd'> | null {
    if (!this.#lastDetection) return null;
    const { igd: _i, ...d } = this.#lastDetection;
    return d;
  }

  async detect(): Promise<Omit<Detection, 'igd'>> {
    this.#lastDetection = await detect(this.#e.detect);
    return this.lastDetection()!;
  }

  #tokenSet(): boolean {
    return existsSync(join(this.#dir, 'duckdns-token'));
  }

  #secret(name: string, value: string): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.#dir, name), value);
    chmodSync(join(this.#dir, name), 0o600);
  }

  /** Switches mode (the previous one is turned off first) and remembers the choice. */
  async set(cfg: ReachConfig, secrets: { duckdnsToken?: string } = {}): Promise<ReachStatus> {
    this.#validate(cfg, secrets);
    await this.stop(true);
    this.save(cfg, secrets);
    return this.start();
  }

  #validate(cfg: ReachConfig, secrets: { duckdnsToken?: string }): void {
    if (!['off', 'tailscale', 'cloudflare', 'port-forward'].includes(cfg.mode)) throw new Error('unknown mode');
    if (cfg.mode === 'cloudflare' && !HOST_RE.test(cfg.cloudflareHost ?? '')) throw new Error('enter the hostname on your Cloudflare domain, e.g. drop.example.com');
    if (cfg.mode === 'port-forward' && !/^[a-z0-9-]{1,63}(\.duckdns\.org)?$/i.test(cfg.duckdnsDomain ?? '')) throw new Error('enter your DuckDNS name, e.g. myhub (for myhub.duckdns.org)');
    for (const p of [cfg.externalPort, cfg.internalPort]) if (p !== undefined && (!Number.isInteger(p) || p < 0 || p > 65535)) throw new Error('invalid port');
    if (secrets.duckdnsToken !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(secrets.duckdnsToken)) throw new Error('that does not look like a DuckDNS token');
  }

  /** Validates and remembers the choice without applying it (the CLI next to a running listener). */
  save(cfg: ReachConfig, secrets: { duckdnsToken?: string } = {}): void {
    this.#validate(cfg, secrets);
    if (secrets.duckdnsToken !== undefined) this.#secret('duckdns-token', secrets.duckdnsToken);
    this.#cfg = { ...cfg, ...(cfg.duckdnsDomain ? { duckdnsDomain: cfg.duckdnsDomain.replace(/\.duckdns\.org$/i, '').toLowerCase() } : {}) };
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.#dir, 'config.json'), JSON.stringify(this.#cfg, null, 2));
  }

  /** Brings the saved mode up (engine start, or after set()). Never throws: errors land in status(). */
  async start(): Promise<ReachStatus> {
    const mode = this.#cfg.mode;
    this.#status = { mode, state: mode === 'off' ? 'off' : 'starting', tokenSet: this.#tokenSet() };
    try {
      if (mode === 'tailscale') {
        const t = await this.#tailscale.enable();
        if (t.state !== 'on') return (this.#status = { mode, state: t.state === 'error' ? 'error' : t.state, tokenSet: this.#tokenSet(), ...(t.error ? { error: t.error } : {}), ...(t.fix ? { fix: t.fix } : {}) });
        await this.#up(`wss://${t.host}/mesh/v1/hub`, t.host!);
      } else if (mode === 'cloudflare') {
        this.#cloudflare = new Cloudflare(this.#e.runner ?? execRunner, this.#e.spawner ?? execSpawner, this.#e.ingressPort, this.#cfg.cloudflareHost!);
        const c = await this.#cloudflare.enable();
        if (c.state !== 'on') return (this.#status = { mode, state: c.state === 'error' ? 'error' : c.state, tokenSet: this.#tokenSet(), ...(c.error ? { error: c.error } : {}), ...(c.fix ? { fix: c.fix } : {}) });
        await this.#up(`wss://${c.host}/mesh/v1/hub`, c.host!);
      } else if (mode === 'port-forward') {
        await this.#portForward();
      }
    } catch (e) {
      this.#status = { ...this.#status, state: 'error', error: e instanceof Error ? e.message : String(e) };
    }
    return this.status();
  }

  async #up(url: string, host: string, extra: Partial<ReachStatus> = {}): Promise<void> {
    await this.#e.publish(url, this.#published);
    this.#published = url;
    this.#status = { mode: this.#cfg.mode, state: 'on', url, host, tokenSet: this.#tokenSet(), ...extra };
  }

  async #portForward(): Promise<void> {
    const domain = this.#cfg.duckdnsDomain!;
    const host = `${domain}.duckdns.org`;
    if (!this.#tokenSet()) throw new Error('enter your DuckDNS token');
    const token = readFileSync(join(this.#dir, 'duckdns-token'), 'utf8').trim();
    const duck = this.#e.duckdnsUrl ?? DUCKDNS_URL;
    await duckdnsUpdate({ domain, token, baseUrl: duck });
    await this.#ensureCert(host, domain, token, duck);
    const ext = this.#cfg.externalPort ?? 443;
    const internal = this.#cfg.internalPort ?? 53322;
    const server = createHttpsServer({ ...this.#tlsFiles(), minVersion: 'TLSv1.2' });
    this.#e.attachPublic(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(internal, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => {});
    this.#server = server;
    const port = (server.address() as { port: number }).port;
    let mapped: ReachStatus['mapped'] = 'manual';
    if ((this.#cfg.mapping ?? 'auto') === 'auto') mapped = await this.#map(ext, port);
    await this.#up(`wss://${host}${ext === 443 ? '' : `:${ext}`}/mesh/v1/hub`, host, { mapped, listenPort: port, certExpiresAt: this.#certExpiry() ?? 0 });
    this.#renew = setInterval(() => void this.#renewIfDue(host, domain, token, duck), DAY);
    this.#renew.unref();
  }

  async #map(ext: number, port: number): Promise<'upnp' | 'natpmp' | 'manual'> {
    try {
      this.#igd = await igdFromLocation(await ssdpDiscover({ timeoutMs: 2500, ...this.#e.detect?.ssdp }));
      const me = await localAddressFor(new URL(this.#igd.control).hostname);
      await upnpMap(this.#igd, { externalPort: ext, internalPort: port, internalClient: me, description: 'MeshDrop hub' });
      return 'upnp';
    } catch {
      this.#igd = null;
    }
    const gw = this.#e.detect?.gateway === undefined ? defaultGateway() : this.#e.detect.gateway;
    if (gw) {
      try {
        await pmpMap(gw, port, ext, 7200, this.#e.detect?.natpmpPort !== undefined ? { port: this.#e.detect.natpmpPort } : {});
        return 'natpmp';
      } catch {
        /* none */
      }
    }
    throw new Error(`The router did not open port ${ext} automatically: forward TCP ${ext} to this PC's port ${port} on your router, then choose "I forwarded it myself".`);
  }

  #tlsFiles(): { key: string; cert: string } {
    return { key: readFileSync(join(this.#dir, 'key.pem'), 'utf8'), cert: readFileSync(join(this.#dir, 'cert.pem'), 'utf8') };
  }

  #certExpiry(): number | null {
    try {
      return new X509Certificate(readFileSync(join(this.#dir, 'cert.pem'))).validToDate.getTime();
    } catch {
      return null;
    }
  }

  async #ensureCert(host: string, domain: string, token: string, duck: string): Promise<void> {
    const exp = this.#certExpiry();
    let names = '';
    try {
      names = new X509Certificate(readFileSync(join(this.#dir, 'cert.pem'))).subjectAltName ?? '';
    } catch {
      /* none */
    }
    if (exp !== null && exp - Date.now() > 30 * DAY && names.includes(`DNS:${host}`)) return;
    let accountKey: { privateKey: KeyObject; publicKey: KeyObject };
    try {
      const k = createPrivateKey(readFileSync(join(this.#dir, 'account.key'), 'utf8'));
      accountKey = { privateKey: k, publicKey: createPublicKey(k) };
    } catch {
      accountKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      this.#secret('account.key', accountKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    }
    const { certPem, keyPem } = await obtainCertificate({
      directoryUrl: this.#e.acmeDirectory ?? (this.#cfg.staging ? 'https://acme-staging-v02.api.letsencrypt.org/directory' : LETS_ENCRYPT),
      accountKey, domain: host, ...(this.#cfg.email ? { email: this.#cfg.email } : {}),
      setTxt: (txt) => duckdnsUpdate({ domain, token, txt, baseUrl: duck }),
      clearTxt: () => duckdnsUpdate({ domain, token, clearTxt: true, txt: '', baseUrl: duck }),
      ...(this.#e.propagationMs !== undefined ? { propagationMs: this.#e.propagationMs } : {}),
    });
    this.#secret('key.pem', keyPem);
    this.#secret('cert.pem', certPem);
  }

  async #renewIfDue(host: string, domain: string, token: string, duck: string): Promise<void> {
    try {
      await duckdnsUpdate({ domain, token, baseUrl: duck }); // the address may have changed
      const before = this.#certExpiry();
      await this.#ensureCert(host, domain, token, duck);
      if (this.#certExpiry() !== before) this.#server?.setSecureContext(this.#tlsFiles());
      this.#status = { ...this.#status, certExpiresAt: this.#certExpiry() ?? 0 };
    } catch (e) {
      this.#status = { ...this.#status, error: `renewal: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Turns the current mode off (`unpublish`: also drop its URL from the list). */
  async stop(unpublish = false): Promise<void> {
    if (this.#renew) clearInterval(this.#renew);
    this.#renew = null;
    await this.#cloudflare?.disable();
    this.#cloudflare = null;
    if (unpublish && this.#cfg.mode === 'tailscale') await this.#tailscale.disable().catch(() => {});
    if (this.#server) {
      const s = this.#server;
      this.#server = null;
      await new Promise((r) => s.close(() => r(undefined)));
      s.closeAllConnections();
    }
    if (unpublish && this.#igd) await upnpUnmap(this.#igd, this.#cfg.externalPort ?? 443).catch(() => {});
    this.#igd = null;
    if (unpublish && this.#published) {
      await this.#e.publish(null, this.#published).catch(() => {});
      this.#published = null;
    }
    this.#status = { mode: this.#cfg.mode, state: 'off', tokenSet: this.#tokenSet() };
  }
}
