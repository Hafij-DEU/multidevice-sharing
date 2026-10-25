// Tunnel mode (M5c): the hub's loopback ingress published through the owner's own tunnel account.
// We drive the installed CLIs and never install or log in for the owner: a missing program or a
// logged-out account comes back as a state with the exact command to run.
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Runner, Spawner } from './runner.ts';

export type TunnelState = 'missing' | 'logged-out' | 'off' | 'on' | 'error';

export interface TunnelStatus {
  provider: 'tailscale' | 'cloudflare';
  state: TunnelState;
  /** The public host (tailnet name, or the Cloudflare hostname). */
  host?: string;
  error?: string;
  /** What the owner should run or do to get further. */
  fix?: string;
}

const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';

export class Tailscale {
  readonly #run: Runner;
  readonly #port: () => number;

  constructor(run: Runner, ingressPort: () => number) {
    this.#run = run;
    this.#port = ingressPort;
  }

  async #self(): Promise<TunnelStatus & { dns?: string }> {
    const r = await this.#run('tailscale', ['status', '--json']);
    if (r.code === 127) return { provider: 'tailscale', state: 'missing', fix: 'Install Tailscale (https://tailscale.com/download), then run: sudo tailscale up' };
    let j: { BackendState?: string; Self?: { DNSName?: string } } = {};
    try {
      j = JSON.parse(r.stdout) as typeof j;
    } catch {
      /* not running */
    }
    if (j.BackendState !== 'Running' || !j.Self?.DNSName) return { provider: 'tailscale', state: 'logged-out', fix: 'Run: sudo tailscale up' };
    return { provider: 'tailscale', state: 'off', host: j.Self.DNSName.replace(/\.$/, '') };
  }

  async status(): Promise<TunnelStatus> {
    const s = await this.#self();
    if (s.state !== 'off') return s;
    const f = await this.#run('tailscale', ['funnel', 'status', '--json']);
    let on = false;
    try {
      const j = JSON.parse(f.stdout) as { AllowFunnel?: Record<string, boolean> };
      on = Object.entries(j.AllowFunnel ?? {}).some(([k, v]) => v && k.startsWith(`${s.host}:443`));
    } catch {
      /* no funnel config */
    }
    return { ...s, state: on ? 'on' : 'off' };
  }

  #enabling: Promise<TunnelStatus> | null = null;

  /** One attempt at a time: a second call while one runs gets the same answer. */
  enable(): Promise<TunnelStatus> {
    this.#enabling ??= this.#enable().finally(() => {
      this.#enabling = null;
    });
    return this.#enabling;
  }

  async #enable(): Promise<TunnelStatus> {
    const s = await this.#self();
    if (s.state !== 'off') return s;
    // --yes: never wait on a prompt; a tailnet without Funnel answers with the page that allows it
    const r = await this.#run('tailscale', ['funnel', '--bg', '--yes', '--https=443', `http://127.0.0.1:${this.#port()}`], { timeoutMs: 60_000 });
    if (r.code !== 0) {
      const out = `${r.stdout}\n${r.stderr}`;
      const approve = /https:\/\/login\.tailscale\.com\/\S+/.exec(out)?.[0];
      const fix = /access denied|permission|operator/i.test(out)
        ? 'Run once: sudo tailscale set --operator=$USER'
        : approve
          ? `Open ${approve} and allow Funnel (and HTTPS certificates), then press Apply`
          : 'Allow Funnel for this device in the Tailscale admin console (Access controls → nodeAttrs "funnel"), then try again';
      return { ...s, state: 'error', error: approve ? 'Funnel is not allowed on your tailnet yet' : firstLine(r.stderr || r.stdout), fix };
    }
    return { ...s, state: 'on' };
  }

  async disable(): Promise<void> {
    await this.#run('tailscale', ['funnel', '--https=443', 'off']);
  }
}

/** A Cloudflare named tunnel "meshdrop" on a hostname of the owner's domain, run as our child process. */
export class Cloudflare extends EventEmitter {
  readonly #run: Runner;
  readonly #spawn: Spawner;
  readonly #port: () => number;
  readonly #host: string;
  readonly #backoff: readonly number[];
  #child: ChildProcess | null = null;
  #want = false;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  #lastError: string | undefined;

  constructor(run: Runner, spawner: Spawner, ingressPort: () => number, host: string, backoffMs: readonly number[] = [1000, 5000, 15000, 60000]) {
    super();
    this.#run = run;
    this.#spawn = spawner;
    this.#port = ingressPort;
    this.#host = host;
    this.#backoff = backoffMs;
  }

  async #check(): Promise<TunnelStatus | null> {
    const r = await this.#run('cloudflared', ['tunnel', 'list', '--output', 'json']);
    if (r.code === 127) return { provider: 'cloudflare', state: 'missing', host: this.#host, fix: 'Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)' };
    if (r.code !== 0) {
      const msg = firstLine(r.stderr || r.stdout);
      if (/cert|login|origin/i.test(msg)) return { provider: 'cloudflare', state: 'logged-out', host: this.#host, fix: 'Run once: cloudflared tunnel login' };
      return { provider: 'cloudflare', state: 'error', host: this.#host, error: msg };
    }
    let list: { name?: string }[] = [];
    try {
      list = JSON.parse(r.stdout || '[]') as { name?: string }[];
    } catch {
      /* treat as empty */
    }
    if (!list.some((t) => t.name === 'meshdrop')) {
      const c = await this.#run('cloudflared', ['tunnel', 'create', 'meshdrop']);
      if (c.code !== 0) return { provider: 'cloudflare', state: 'error', host: this.#host, error: firstLine(c.stderr || c.stdout) };
    }
    return null;
  }

  status(): TunnelStatus {
    if (this.#child) return { provider: 'cloudflare', state: 'on', host: this.#host };
    return { provider: 'cloudflare', state: this.#lastError ? 'error' : 'off', host: this.#host, ...(this.#lastError ? { error: this.#lastError } : {}) };
  }

  async enable(): Promise<TunnelStatus> {
    const bad = await this.#check();
    if (bad) return bad;
    const d = await this.#run('cloudflared', ['tunnel', 'route', 'dns', '--overwrite-dns', 'meshdrop', this.#host]);
    if (d.code !== 0 && !/already exists/i.test(d.stderr + d.stdout)) return { provider: 'cloudflare', state: 'error', host: this.#host, error: firstLine(d.stderr || d.stdout), fix: `Make sure ${this.#host} is on a domain in your Cloudflare account` };
    this.#want = true;
    this.#attempt = 0;
    this.#lastError = undefined;
    this.#start();
    return this.status();
  }

  #start(): void {
    if (!this.#want || this.#child) return;
    const c = this.#spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${this.#port()}`, 'meshdrop']);
    this.#child = c;
    let tail = '';
    c.stderr?.on('data', (b: Buffer) => {
      tail = (tail + b.toString()).slice(-2000);
      if (/Registered tunnel connection/i.test(tail)) this.#attempt = 0;
    });
    c.on('error', () => {});
    c.once('exit', (code) => {
      this.#child = null;
      if (!this.#want) return;
      this.#lastError = `cloudflared exited (${code ?? 'signal'}): ${firstLine(tail)}`;
      this.emit('down', this.#lastError);
      const wait = this.#backoff[Math.min(this.#attempt++, this.#backoff.length - 1)] ?? 60_000;
      this.#timer = setTimeout(() => this.#start(), wait);
      this.#timer.unref();
    });
  }

  async disable(): Promise<void> {
    this.#want = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const c = this.#child;
    this.#child = null;
    this.#lastError = undefined;
    if (c && c.exitCode === null) {
      const gone = new Promise((r) => {
        const t = setTimeout(() => {
          c.kill('SIGKILL');
          r(undefined);
        }, 5000);
        c.once('exit', () => {
          clearTimeout(t);
          r(undefined);
        });
      });
      c.kill('SIGTERM');
      await gone;
    }
  }
}
