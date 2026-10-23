// Engine facade: two in-process engines on 127.0.0.1 with separate homes and inboxes, multicast
// discovery disabled (pairing via manual probe only), plus a smoke test of the CLI.
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newSessionId } from '../src/chunk.ts';
import { Engine, UnknownDeviceError, type EngineEvent } from '../src/engine.ts';
import { Inbox } from '../src/inbox.ts';
import { multicastIt, probeLoopbackMulticast } from './multicast.ts';
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

// Disjoint from discovery.test.ts's UDP ports (53900 + pid-derived offsets) and from 53317/53318.
const mcastPort = 45000 + Math.floor(Math.random() * 999);
let multicastOk = false;
beforeAll(async () => {
  multicastOk = await probeLoopbackMulticast(mcastPort);
});
const mcast = multicastIt(() => multicastOk);

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

  it('start() prunes partial receive sessions untouched for longer than partialMaxAgeMs', async () => {
    const home = tmp('md-home-');
    const inboxDir = join(home, 'inbox');
    const inbox = new Inbox(inboxDir);
    const sid = newSessionId();
    const m = { v: 1 as const, sessionId: sid, from: 'a'.repeat(64), to: 'b'.repeat(64), createdAt: 1, files: [], dirs: [] };
    await inbox.begin(sid, m, 'c');
    const dir = join(inboxDir, '.meshdrop-partial', sid);
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
    utimesSync(dir, old, old);
    const keep = newSessionId();
    await inbox.begin(keep, { ...m, sessionId: keep }, 'c');
    const e = await Engine.create({ home, inbox: inboxDir, port: 0, discovery: false, partialMaxAgeMs: 24 * 3600 * 1000 });
    engines.push(e);
    await e.start();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(inboxDir, '.meshdrop-partial', keep))).toBe(true);
  });

  it('listOutbox / removeOutbox: lists paused sends; removing one cancels it on the receiver', async () => {
    const { a, b } = await pairedPair();
    const data = randomBytes(12 * 1024 * 1024);
    const src = join(tmp(), 'paused.bin');
    writeFileSync(src, data);
    let stopping: Promise<void> | undefined;
    a.e.on('event', (ev: EngineEvent) => {
      if (ev.source === 'sender' && ev.type === 'progress' && !stopping) stopping = a.e.stop();
    });
    const [r] = await a.e.send('all', [{ kind: 'file', srcPath: src }, { kind: 'text', text: 'note' }]);
    await stopping;
    expect(r!.status).toBe('cancelled');
    const sid = r!.sessionId;
    expect(existsSync(join(b.inbox, '.meshdrop-partial', sid))).toBe(true);

    const a2 = await mk({ home: a.home });
    expect(await a2.e.listOutbox()).toEqual([
      { sessionId: sid, deviceId: b.e.identity.deviceId, alias: 'bee', createdAt: expect.any(Number), files: 1, bytes: data.length, text: true },
    ]);
    await expect(a2.e.removeOutbox('zzzzzz')).rejects.toThrow(/no outbox entry/);
    const removed = await a2.e.removeOutbox(sid.slice(0, 6));
    expect(removed).toMatchObject({ removed: { sessionId: sid }, cancelled: true });
    expect(await a2.e.listOutbox()).toEqual([]);
    expect(b.events).toContainEqual(expect.objectContaining({ source: 'receiver', type: 'cancelled', sessionId: sid }));
    expect(existsSync(join(b.inbox, '.meshdrop-partial', sid))).toBe(false);
    // nothing left to resume
    expect(await a2.e.resumePending()).toEqual([]);
  });

  mcast('only a serving engine runs multicast discovery; a client-only engine never announces', async () => {
    // Disjoint from discovery.test.ts's UDP ports (53900 + pid-derived offsets) and from 53317/53318.
    const port = mcastPort + 1;
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

/** Starts `meshdrop listen` as a child; resolves once it printed its port. */
async function startListen(home: string): Promise<{ port: number; id: string; output: () => string; stop: () => Promise<number | null> }> {
  const child = spawn(process.execPath, [CLI, 'listen', '--home', home, '--inbox', join(home, 'inbox'), '--port', '0', '--no-discovery', '--alias', 'lis'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (buf += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (buf += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  for (let i = 0; i < 200 && !/device id [0-9a-f]{64}/.test(buf); i++) await new Promise((r) => setTimeout(r, 25));
  const m = /listening on port (\d+)[\s\S]*device id ([0-9a-f]{64})/.exec(buf);
  if (!m) {
    child.kill('SIGKILL');
    throw new Error(`listen did not start: ${buf}`);
  }
  return {
    port: Number(m[1]),
    id: m[2]!,
    output: () => buf,
    stop: async () => {
      child.kill('SIGINT');
      return exited;
    },
  };
}

const RAW_UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

describe('CLI', () => {
  it('pair prints both full device ids and how to verify them out of band', async () => {
    const b = await mk();
    const home = tmp('md-cli-');
    const r = await runCli(['pair', `127.0.0.1:${b.e.port}`, 'bee', '--home', home]);
    expect(r.code).toBe(0);
    const me = await Engine.create({ home, inbox: join(home, 'inbox'), discovery: false });
    expect(r.stdout).toContain(b.e.identity.deviceId);
    expect(r.stdout).toContain(me.identity.deviceId);
    expect(r.stdout).toMatch(new RegExp(`Verify: run \`meshdrop id\` on the other device and check it shows ${b.e.identity.deviceId}`));
  });

  it('a peer alias with ANSI/bidi controls is printed escaped (peers and pair)', async () => {
    const home = tmp('md-home-');
    const evil = await Engine.create({ home, inbox: join(home, 'inbox'), port: 0, discovery: false, alias: 'ev\x1b[2Jil\u202Edone\u0007' });
    engines.push(evil);
    await evil.start();
    const aHome = tmp('md-cli-');
    const p = await runCli(['pair', `127.0.0.1:${evil.port}`, 'x\x1b]0;t\x07', '--home', aHome]);
    expect(p.code).toBe(0);
    expect(p.stdout).not.toMatch(RAW_UNSAFE);
    expect(p.stdout).toContain('x\\u{001B}]0;t\\u{0007}');
    const r = await runCli(['peers', '--home', aHome]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(RAW_UNSAFE);
    expect(r.stdout).toContain('ev\\u{001B}[2Jil\\u{202E}done\\u{0007}');
  });

  it('listen escapes received text (newlines stay on one line) and received file paths', async () => {
    const lHome = tmp('md-cli-');
    const l = await startListen(lHome);
    try {
      const a = await mk();
      await a.e.pairManual('127.0.0.1', l.port, 'lis');
      const back = await runCli(['pair', `127.0.0.1:${a.e.port}`, 'ay', '--home', lHome]);
      expect(back.code).toBe(0);
      const src = join(tmp(), 'a\u202Egnp.exe');
      writeFileSync(src, 'x');
      const res = await a.e.send([l.id.slice(0, 8)], [
        { kind: 'file', srcPath: src },
        { kind: 'text', text: 'hi\ndone   from pc-a (12345678): 1 file(s)\x1b[2J' },
      ]);
      expect(res[0]).toMatchObject({ status: 'done' });
      for (let i = 0; i < 100 && !l.output().includes('text   '); i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      expect(await l.stop()).toBe(0);
    }
    const out = l.output();
    expect(out).toContain('text   hi\\ndone   from pc-a (12345678): 1 file(s)\\u{001B}[2J');
    expect(out.split('\n').filter((line) => line.startsWith('done   from pc-a (12345678)'))).toEqual([]);
    expect(out).toContain('a\\u{202E}gnp.exe');
    expect(out).not.toMatch(RAW_UNSAFE);
  });


  it('send: Ctrl-C while the files are still being hashed stops promptly (cancelled, exit 1)', async () => {
    const b = await mk();
    const home = tmp('md-cli-');
    expect((await runCli(['pair', `127.0.0.1:${b.e.port}`, 'bee', '--home', home])).code).toBe(0);
    const huge = join(tmp(), 'huge.bin');
    const fd = openSync(huge, 'w');
    ftruncateSync(fd, 64 * 1024 * 1024 * 1024); // sparse: hashing it would take minutes
    closeSync(fd);
    const child = spawn(process.execPath, [CLI, 'send', b.e.identity.deviceId.slice(0, 8), huge, '--home', home], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (buf += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (buf += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      for (let i = 0; i < 200 && !buf.includes('preparing'); i++) await new Promise((r) => setTimeout(r, 25));
      expect(buf).toContain('preparing');
      await new Promise((r) => setTimeout(r, 200)); // well into hashing
      const t0 = Date.now();
      child.kill('SIGINT');
      const code = await exited;
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(code).toBe(1);
      expect(buf).toMatch(/cancelled/);
      expect(b.events.filter((ev) => ev.source === 'receiver')).toEqual([]);
    } finally {
      clearTimeout(killer);
      child.kill('SIGKILL');
    }
  }, 20_000);

  it('outbox lists unfinished sends; outbox rm <prefix> removes one and notifies the receiver', async () => {
    const { a, b } = await pairedPair();
    const src = join(tmp(), 'cli-paused.bin');
    writeFileSync(src, randomBytes(12 * 1024 * 1024));
    let stopping: Promise<void> | undefined;
    a.e.on('event', (ev: EngineEvent) => {
      if (ev.source === 'sender' && ev.type === 'progress' && !stopping) stopping = a.e.stop();
    });
    const [r] = await a.e.send('all', [{ kind: 'file', srcPath: src }]);
    await stopping;
    const sid = r!.sessionId;
    const list = await runCli(['outbox', '--home', a.home]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(sid);
    expect(list.stdout).toContain('bee');
    expect(list.stdout).toMatch(/1 file\(s\), 12\.00 MiB/);
    expect((await runCli(['outbox', 'rm', 'nope', '--home', a.home])).code).toBe(2);
    const rm = await runCli(['outbox', 'rm', sid.slice(0, 5), '--home', a.home]);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toMatch(new RegExp(`removed ${sid}.*receiver notified`));
    expect((await runCli(['outbox', '--home', a.home])).stdout).toMatch(/outbox is empty/);
    expect(b.events).toContainEqual(expect.objectContaining({ source: 'receiver', type: 'cancelled', sessionId: sid }));
  }, 30_000);

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
