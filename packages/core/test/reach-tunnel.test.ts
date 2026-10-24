import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { RunResult, Runner, Spawner } from '../src/reach/runner.ts';
import { Cloudflare, Tailscale } from '../src/reach/tunnel.ts';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
function fake(table: Record<string, RunResult | ((args: string[]) => RunResult)>, calls: string[][] = []): Runner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    for (const [k, v] of Object.entries(table)) if (key.startsWith(k)) return typeof v === 'function' ? v(args) : v;
    return { code: 127, stdout: '', stderr: 'not found' };
  };
}
const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1234.ts.net.' } });

describe('Tailscale Funnel driver', () => {
  it('reports missing, logged out, off and on, and enables the funnel on the ingress', async () => {
    expect((await new Tailscale(fake({}), () => 53319).status()).state).toBe('missing');
    expect(await new Tailscale(fake({ 'tailscale status': ok(JSON.stringify({ BackendState: 'NeedsLogin' })) }), () => 53319).status()).toMatchObject({ state: 'logged-out', fix: 'Run: sudo tailscale up' });
    const calls: string[][] = [];
    let funnel = '{}';
    const t = new Tailscale(fake({
      'tailscale status': ok(running),
      'tailscale funnel status': () => ok(funnel),
      'tailscale funnel --bg': () => { funnel = JSON.stringify({ AllowFunnel: { 'pc.tail1234.ts.net:443': true } }); return ok(); },
      'tailscale funnel --https=443 off': ok(),
    }, calls), () => 53319);
    expect(await t.status()).toEqual({ provider: 'tailscale', state: 'off', host: 'pc.tail1234.ts.net' });
    expect(await t.enable()).toMatchObject({ state: 'on', host: 'pc.tail1234.ts.net' });
    expect(calls).toContainEqual(['tailscale', 'funnel', '--bg', '--https=443', 'http://127.0.0.1:53319']);
    expect((await t.status()).state).toBe('on');
  });

  it('turns a refused funnel into an error with a fix', async () => {
    const t = new Tailscale(fake({ 'tailscale status': ok(running), 'tailscale funnel --bg': { code: 1, stdout: '', stderr: 'Funnel not available; "funnel" node attribute not set' } }), () => 1);
    expect(await t.enable()).toMatchObject({ state: 'error', error: expect.stringContaining('Funnel not available'), fix: expect.stringContaining('admin console') });
  });
});

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill() {
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

describe('Cloudflare named tunnel driver', () => {
  it('logs in first, creates and routes the tunnel, runs it and restarts it when it dies', async () => {
    expect(await new Cloudflare(fake({ 'cloudflared tunnel list': { code: 1, stdout: '', stderr: 'Cannot determine default origin certificate path' } }), () => new FakeChild() as unknown as ChildProcess, () => 1, 'drop.example.com').enable()).toMatchObject({ state: 'logged-out', fix: 'Run once: cloudflared tunnel login' });
    const calls: string[][] = [];
    const children: FakeChild[] = [];
    const spawner: Spawner = (cmd, args) => {
      calls.push([cmd, ...args]);
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    };
    const cf = new Cloudflare(fake({ 'cloudflared tunnel list': ok('[]'), 'cloudflared tunnel create': ok(), 'cloudflared tunnel route dns': ok() }, calls), spawner, () => 53319, 'drop.example.com', [10]);
    expect(await cf.enable()).toEqual({ provider: 'cloudflare', state: 'on', host: 'drop.example.com' });
    expect(calls).toContainEqual(['cloudflared', 'tunnel', 'create', 'meshdrop']);
    expect(calls).toContainEqual(['cloudflared', 'tunnel', 'route', 'dns', '--overwrite-dns', 'meshdrop', 'drop.example.com']);
    expect(calls).toContainEqual(['cloudflared', 'tunnel', '--no-autoupdate', 'run', '--url', 'http://127.0.0.1:53319', 'meshdrop']);
    children[0]!.exitCode = 1;
    children[0]!.emit('exit', 1);
    expect(cf.status().state).toBe('error');
    await new Promise((r) => setTimeout(r, 50));
    expect(children).toHaveLength(2);
    expect(cf.status().state).toBe('on');
    await cf.disable();
    expect(cf.status().state).toBe('off');
  });
});
