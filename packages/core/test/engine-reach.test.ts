import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Engine } from '../src/engine.ts';
import type { Runner } from '../src/reach/runner.ts';
import { fakeAcme } from './fake-acme.ts';

const closers: (() => void)[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const c of closers.splice(0)) c();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'md-reach-'));
  closers.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

describe('engine internet reach', () => {
  it('tailscale mode publishes the funnel host as the hub URL, and off removes it', async () => {
    const d = tmp();
    const run: Runner = async (cmd, args) => {
      const k = [cmd, ...args].join(' ');
      if (k.startsWith('tailscale status')) return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail9.ts.net.' } }), stderr: '' };
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const e = await Engine.create({ home: join(d, 'h'), port: 0, discovery: false, guest: false, hub: { ingressPort: 0 }, reach: { runner: run } });
    engines.push(e);
    await e.hubInit([]);
    await e.start();
    expect(await e.reachSet({ mode: 'tailscale' })).toMatchObject({ mode: 'tailscale', state: 'on', url: 'wss://pc.tail9.ts.net/mesh/v1/hub' });
    expect(e.hubStatus().urls).toEqual(['wss://pc.tail9.ts.net/mesh/v1/hub']);
    await e.reachSet({ mode: 'off' });
    expect(e.hubStatus().urls).toEqual([]);
  });

  it('port-forward mode: DuckDNS, a certificate over DNS-01, and a public TLS listener serving the hub link and links', async () => {
    const d = tmp();
    let txt: string | undefined;
    const ca = await fakeAcme(d, () => txt, closers);
    const duck: Server = createServer((req, res) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (q.get('token') !== 'tok-12345678') return res.end('KO');
      if (q.has('txt') && !q.has('clear')) txt = q.get('txt')!;
      res.end('OK');
    });
    await new Promise<void>((r) => duck.listen(0, '127.0.0.1', () => r()));
    closers.push(() => duck.close());
    const e = await Engine.create({
      home: join(d, 'h'), port: 0, discovery: false, guest: false, hub: { ingressPort: 0 },
      reach: { acmeDirectory: ca.directoryUrl, duckdnsUrl: `http://127.0.0.1:${(duck.address() as { port: number }).port}`, propagationMs: 0 },
    });
    engines.push(e);
    await e.hubInit([]);
    await e.start();
    const st = await e.reachSet({ mode: 'port-forward', duckdnsDomain: 'myhub', internalPort: 0, mapping: 'manual' }, { duckdnsToken: 'tok-12345678' });
    expect(st).toMatchObject({ state: 'on', url: 'wss://myhub.duckdns.org/mesh/v1/hub', mapped: 'manual', tokenSet: true });
    expect(JSON.stringify(e.reachStatus())).not.toContain('tok-12345678');
    expect(e.hubStatus().urls).toEqual(['wss://myhub.duckdns.org/mesh/v1/hub']);

    const port = st.listenPort!;
    const hello = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/mesh/v1/hub`, { ca: ca.caPem(), servername: 'myhub.duckdns.org' } as WebSocket.ClientOptions);
      ws.on('message', (m) => {
        resolve(String(m));
        ws.terminate();
      });
      ws.on('error', reject);
    });
    expect(JSON.parse(hello)).toMatchObject({ t: 'hello', hub: e.identity.deviceId });

    writeFileSync(join(d, 'gift.txt'), 'x');
    const l = await e.linkCreate({ files: [join(d, 'gift.txt')], hours: 1 });
    expect(l.url.startsWith('https://myhub.duckdns.org/l/')).toBe(true);
    const info = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/l/${l.id}/api/info`, ca: ca.caPem(), servername: 'myhub.duckdns.org' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      });
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(info)).toEqual({ needsPassword: false, allowUploads: false });
    await e.reachSet({ mode: 'off' });
    expect(e.hubStatus().urls).toEqual([]);
  });
});
