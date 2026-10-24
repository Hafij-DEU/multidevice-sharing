import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../src/identity.ts';
import { lsSend, LocalSendError } from '../src/localsend/client.ts';
import { LocalSendDiscovery, parseAnnounce, type LsPeerInfo } from '../src/localsend/discovery.ts';
import { LocalSendReceiver, type LsInfo } from '../src/localsend/server.ts';
import { serverTlsOptions } from '../src/tls.ts';
import { multicastIt, probeLoopbackMulticast } from './multicast.ts';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});
const me: LsInfo = { alias: 'MeshDrop PC', version: '2.0', deviceModel: 'Linux', deviceType: 'desktop', fingerprint: 'a'.repeat(64), port: 53317, protocol: 'https', download: false };

async function receiver() {
  const d = mkdtempSync(join(tmpdir(), 'md-lsc-'));
  closers.push(() => rmSync(d, { recursive: true, force: true }));
  const id = await loadOrCreateIdentity(join(d, 'home'));
  const r = new LocalSendReceiver({ self: () => ({ ...me, alias: 'Other', fingerprint: id.deviceId }), partialDir: join(d, 'p'), inboxRoot: join(d, 'inbox'), onEvent: () => {}, answerTimeoutMs: 3000 });
  const s: Server = createServer({ ...serverTlsOptions(id), requestCert: false }, (q, a) => void r.handle(q, a));
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
  closers.push(() => s.close());
  const peer: LsPeerInfo = { alias: 'Other', fingerprint: id.deviceId, host: '127.0.0.1', port: (s.address() as { port: number }).port, protocol: 'https', lastSeen: Date.now() };
  return { d, r, peer };
}

describe('LocalSend client', () => {
  it('sends files and a message after the receiver accepts; reports a decline', async () => {
    const { d, r, peer } = await receiver();
    writeFileSync(join(d, 'a.txt'), 'hello localsend');
    const auto = setInterval(() => r.pending()[0] && r.accept(r.pending()[0]!.id), 20);
    closers.push(() => clearInterval(auto));
    await lsSend(peer, me, { paths: [join(d, 'a.txt')], text: 'and a note' });
    expect(readFileSync(join(d, 'inbox', 'a.txt'), 'utf8')).toBe('hello localsend');
    clearInterval(auto);
    const no = setInterval(() => r.pending()[0] && r.reject(r.pending()[0]!.id), 20);
    closers.push(() => clearInterval(no));
    await expect(lsSend(peer, me, { paths: [], text: 'hi' })).rejects.toMatchObject({ code: 'declined' });
  });

  it('refuses a device whose certificate is not the announced fingerprint', async () => {
    const { peer } = await receiver();
    const err = await lsSend({ ...peer, fingerprint: 'b'.repeat(64) }, me, { paths: [], text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalSendError);
    expect((err as LocalSendError).code).toBe('fingerprint');
  });
});

describe('LocalSend discovery', () => {
  it('parses announces and ignores junk', () => {
    expect(parseAnnounce(JSON.stringify({ alias: 'Phone', version: '2.1', fingerprint: 'x', port: 53317, protocol: 'https', announce: true, deviceModel: 'Pixel' }), '192.168.1.9', 5)).toMatchObject({ alias: 'Phone', host: '192.168.1.9', port: 53317, announce: true, deviceModel: 'Pixel' });
    expect(parseAnnounce('{"alias":"x","version":"1.0","fingerprint":"y"}', 'h', 0)).toBeNull();
    expect(parseAnnounce('not json', 'h', 0)).toBeNull();
  });

  let mc = false;
  beforeAll(async () => {
    mc = await probeLoopbackMulticast(53399, '224.0.0.167');
  });
  multicastIt(() => mc)('two peers find each other by multicast and answer announces by register', async () => {
    const registered: string[] = [];
    const a = new LocalSendDiscovery({ self: () => ({ ...me, fingerprint: 'A'.repeat(64), alias: 'A' }), port: 53398, iface: '127.0.0.1', register: async (p) => (registered.push(p.alias), true) });
    const b = new LocalSendDiscovery({ self: () => ({ ...me, fingerprint: 'B'.repeat(64), alias: 'B' }), port: 53398, iface: '127.0.0.1', register: async (p) => (registered.push(p.alias), true) });
    a.start();
    closers.push(() => a.stop());
    await new Promise((r) => setTimeout(r, 100));
    b.start();
    closers.push(() => b.stop());
    for (let i = 0; i < 100 && !a.peer('B'.repeat(64)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(a.peer('B'.repeat(64))).toMatchObject({ alias: 'B', host: '127.0.0.1' });
    expect(registered).toContain('B');
  });
});
