// Engine facade: two in-process engines on 127.0.0.1 with separate homes and inboxes, multicast
// discovery disabled (pairing via manual probe only), plus a smoke test of the CLI.
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, UnknownDeviceError, type EngineEvent } from '../src/engine.ts';
import { TrustStore } from '../src/trust.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const tmps: string[] = [];
const engines: Engine[] = [];
function tmp(prefix = 'md-eng-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function mk(opts: { home?: string; serve?: boolean } = {}): Promise<{ e: Engine; home: string; inbox: string; events: EngineEvent[] }> {
  const home = opts.home ?? tmp('md-home-');
  const inbox = join(home, 'inbox');
  const e = await Engine.create({ home, inbox, port: 0, alias: 'test', discovery: false, serve: opts.serve ?? true });
  engines.push(e);
  const events: EngineEvent[] = [];
  e.on('event', (ev: EngineEvent) => events.push(ev));
  await e.start();
  return { e, home, inbox, events };
}

async function pairedPair() {
  const a = await mk();
  const b = await mk();
  const tb = await a.e.pairManual('127.0.0.1', b.e.port, 'bee');
  const ta = await b.e.pairManual('127.0.0.1', a.e.port, 'ay');
  return { a, b, ta, tb };
}

function fakeTrusted(store: TrustStore, deviceId: string, alias: string): void {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  store.add({ deviceId, alias, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string, addedAt: 1 });
}

describe('Engine', () => {
  it('two engines pairManual each other, then send("all", [file]) delivers it', async () => {
    const { a, b, ta, tb } = await pairedPair();
    expect(tb).toMatchObject({ deviceId: b.e.identity.deviceId, alias: 'bee' });
    expect(ta).toMatchObject({ deviceId: a.e.identity.deviceId, alias: 'ay' });
    // TrustStore holds the SPKI of the probed certificate.
    expect(a.e.trust.get(b.e.identity.deviceId)?.publicKeyPem).toBe(b.e.identity.publicKey.export({ type: 'spki', format: 'pem' }));
    // The probed peer is a manual discovery entry: present without multicast.
    expect(a.e.peers()).toEqual([
      expect.objectContaining({ deviceId: b.e.identity.deviceId, host: '127.0.0.1', port: b.e.port, manual: true, trusted: true }),
    ]);

    const data = randomBytes(5 * 1024 * 1024 + 17);
    const src = join(tmp(), 'five.bin');
    writeFileSync(src, data);
    const res = await a.e.send('all', [{ kind: 'file', srcPath: src }]);
    expect(res).toEqual([{ deviceId: b.e.identity.deviceId, status: 'done', sessionId: expect.any(String) }]);
    expect(sha(readFileSync(join(b.inbox, 'five.bin')))).toBe(sha(data));

    // Sender progress + result on A, receiver events on B, all on the one 'event' channel.
    const prog = a.events.filter((ev) => ev.source === 'sender' && ev.type === 'progress');
    expect(prog.at(-1)).toMatchObject({ deviceId: b.e.identity.deviceId, fileId: 0, sent: data.length, total: data.length });
    expect(a.events).toContainEqual({ source: 'sender', type: 'result', ...res[0]! });
    expect(b.events).toContainEqual(expect.objectContaining({ source: 'receiver', type: 'received', sessionId: res[0]!.sessionId }));
    // done: nothing left in the outbox
    expect(readdirSync(join(a.home, 'outbox')).filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it('send to an unknown prefix rejects with UnknownDeviceError', async () => {
    const { a } = await pairedPair();
    const item = [{ kind: 'text' as const, text: 'hi' }];
    await expect(a.e.send(['ffff'], item)).rejects.toBeInstanceOf(UnknownDeviceError);
    await expect(a.e.send(['ffff'], item)).rejects.toMatchObject({ query: 'ffff', reason: 'unknown' });
    await expect(a.e.send(['abc'], item)).rejects.toMatchObject({ query: 'abc', reason: 'invalid' });
  });

  it('ambiguous prefix rejects; a trusted device that is not present fails as offline', async () => {
    const { a, b } = await pairedPair();
    fakeTrusted(a.e.trust, 'abcd1' + '0'.repeat(59), 'x1');
    fakeTrusted(a.e.trust, 'abcd2' + '0'.repeat(59), 'x2');
    const item = [{ kind: 'text' as const, text: 'hi' }];
    const err = await a.e.send(['abcd'], item).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownDeviceError);
    expect(err).toMatchObject({ query: 'abcd', reason: 'ambiguous' });
    expect((err as UnknownDeviceError).matches).toHaveLength(2);

    const bShort = b.e.identity.deviceId.slice(0, 8).toUpperCase(); // case-insensitive
    const res = await a.e.send(['ABCD1', bShort], item);
    expect(res).toEqual([
      { deviceId: 'abcd1' + '0'.repeat(59), status: 'failed', sessionId: '', error: 'offline' },
      { deviceId: b.e.identity.deviceId, status: 'done', sessionId: expect.any(String) },
    ]);
    // 'all' only covers trusted devices that are present.
    const all = await a.e.send('all', item);
    expect(all.map((r) => r.deviceId)).toEqual([b.e.identity.deviceId]);
  });

  it("send('all') with no trusted device present resolves to []", async () => {
    const a = await mk();
    expect(await a.e.send('all', [{ kind: 'text', text: 'x' }])).toEqual([]);
  });

  it('refuses to pair with itself', async () => {
    const a = await mk();
    await expect(a.e.pairManual('127.0.0.1', a.e.port, 'me')).rejects.toThrow(/yourself/);
    expect(a.e.trust.list()).toEqual([]);
  });

  it('a running receiver picks up trust added by another process (CLI pair) without restart', async () => {
    const a = await mk();
    const b = await mk();
    await a.e.pairManual('127.0.0.1', b.e.port, 'bee');
    // A second engine on B's home, client-only (like `meshdrop pair` while `meshdrop listen` runs).
    const b2 = await mk({ home: b.home, serve: false });
    await b2.e.pairManual('127.0.0.1', a.e.port, 'ay');
    await b2.e.stop();
    const res = await a.e.send([b.e.identity.deviceId.slice(0, 6)], [{ kind: 'text', text: 'hello' }]);
    expect(res[0]).toMatchObject({ status: 'done' });
    expect(b.events).toContainEqual(expect.objectContaining({ source: 'receiver', type: 'received', text: 'hello' }));
  });

  it('stop() aborts an in-flight send (cancelled, resumable); a new engine on the same home resumes it', async () => {
    const { a, b } = await pairedPair();
    const data = randomBytes(40 * 1024 * 1024);
    const src = join(tmp(), 'forty.bin');
    writeFileSync(src, data);
    let stopping: Promise<void> | undefined;
    a.e.on('event', (ev: EngineEvent) => {
      if (ev.source === 'sender' && ev.type === 'progress' && !stopping) stopping = a.e.stop();
    });
    const res = await a.e.send('all', [{ kind: 'file', srcPath: src }]);
    await stopping;
    await a.e.stop(); // idempotent
    expect(res).toEqual([{ deviceId: b.e.identity.deviceId, status: 'cancelled', sessionId: expect.any(String) }]);
    expect(readdirSync(join(a.home, 'outbox'))).toContain(`${res[0]!.sessionId}.json`);

    // Restart: the manually paired address is remembered, so the target resolves without multicast.
    const a2 = await mk({ home: a.home });
    expect(a2.e.peers().map((p) => p.deviceId)).toEqual([b.e.identity.deviceId]);
    const resumed = await a2.e.resumePending();
    expect(resumed).toEqual([{ deviceId: b.e.identity.deviceId, status: 'done', sessionId: res[0]!.sessionId }]);
    expect(sha(readFileSync(join(b.inbox, 'forty.bin')))).toBe(sha(data));
    expect(a2.events).toContainEqual({ source: 'sender', type: 'result', ...resumed[0]! });
  });

  it('only a serving engine runs multicast discovery; a client-only engine never announces', async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const d = { port, iface: '127.0.0.1', intervalMs: 50, ttlMs: 2000 };
    const watcherHome = tmp('md-home-');
    const watcher = await Engine.create({ home: watcherHome, inbox: join(watcherHome, 'inbox'), port: 0, discovery: d });
    engines.push(watcher);
    await watcher.start();
    const seen = () => watcher.peers().map((p) => p.deviceId);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const cHome = tmp('md-home-');
    const client = await Engine.create({ home: cHome, inbox: join(cHome, 'inbox'), port: 0, discovery: d, serve: false });
    engines.push(client);
    await client.start();
    const sHome = tmp('md-home-');
    const server = await Engine.create({ home: sHome, inbox: join(sHome, 'inbox'), port: 0, discovery: d });
    engines.push(server);
    await server.start();
    for (let i = 0; i < 40 && !seen().includes(server.identity.deviceId); i++) await sleep(25);
    expect(seen()).toContain(server.identity.deviceId);
    expect(watcher.peers().find((p) => p.deviceId === server.identity.deviceId)?.port).toBe(server.port);
    expect(seen()).not.toContain(client.identity.deviceId);
  });

  it('alias is truncated to 64 UTF-16 units without splitting a code point; bad deviceType is refused', async () => {
    const home = tmp('md-home-');
    const e = await Engine.create({ home, inbox: join(home, 'inbox'), alias: 'a' + '\u{1F600}'.repeat(40), discovery: false });
    expect(e.alias.length).toBe(63);
    expect(e.alias.endsWith('\u{1F600}')).toBe(true);
    await expect(Engine.create({ home, deviceType: 'toaster' as never })).rejects.toThrow(/deviceType/);
  });

  it('send before start() rejects', async () => {
    const home = tmp('md-home-');
    const e = await Engine.create({ home, inbox: join(home, 'inbox'), port: 0, discovery: false });
    engines.push(e);
    await expect(e.send('all', [{ kind: 'text', text: 'x' }])).rejects.toThrow(/not started/);
  });
});

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe('CLI', () => {
  it('id prints the device id of --home (and MESHDROP_HOME is overridden by --home)', async () => {
    const home = tmp('md-cli-');
    const other = tmp('md-cli-');
    const r = await runCli(['id', '--home', home], { MESHDROP_HOME: other });
    expect(r.code).toBe(0);
    const id = /\b([0-9a-f]{64})\b/.exec(r.stdout)?.[1];
    expect(id).toBeDefined();
    const e = await Engine.create({ home, inbox: join(home, 'inbox'), discovery: false });
    expect(e.identity.deviceId).toBe(id);
    expect(readdirSync(other)).toEqual([]);
  });

  it('send with no trusted peer present exits non-zero with a message', async () => {
    const home = tmp('md-cli-');
    const f = join(home, 'f.txt');
    writeFileSync(f, 'x');
    const r = await runCli(['send', 'all', f, '--home', home]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/no trusted device/i);
  });

  it('send to an unknown prefix exits non-zero', async () => {
    const home = tmp('md-cli-');
    const r = await runCli(['send', 'ffff', '--text', 'x', '--home', home]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/unknown device/i);
  });
});
