import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppController, type Platform } from '../src/main/controller.ts';
import { HistoryStore } from '../src/main/history.ts';
import { SettingsStore, defaultSettings } from '../src/main/settings.ts';
import type { AppState, Settings } from '../src/shared/api.ts';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'md-ctl-'));
  tmps.push(d);
  return d;
}
const ctls: AppController[] = [];
afterAll(async () => {
  for (const c of ctls) await c.stop();
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}

interface FakePlatform extends Platform {
  clip: string[];
  notes: { title: string; body: string }[];
  clipboardText: string;
}
function fakePlatform(): FakePlatform {
  const p: FakePlatform = {
    clip: [],
    notes: [],
    clipboardText: '',
    notify: (title, body) => void p.notes.push({ title, body }),
    writeClipboard: (t) => void p.clip.push(t),
    readClipboard: () => p.clipboardText,
    openPath: async () => {},
    revealPath: () => {},
  };
  return p;
}

async function make(alias: string, over: Partial<Settings> = {}, home = tmpDir()): Promise<{ c: AppController; p: FakePlatform; home: string; inbox: string }> {
  const inbox = join(home, 'inbox');
  const settings = new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias, inbox, port: 0, discovery: false, ...over }));
  const p = fakePlatform();
  const c = new AppController({
    home,
    settings,
    history: new HistoryStore(join(home, 'desktop-history.json')),
    platform: p,
    engineOptions: { hub: { ingressPort: 0 }, hubBackoffMs: [50, 100], allowLoopbackHubUrls: true },
  });
  ctls.push(c);
  await c.start();
  return { c, p, home, inbox };
}

async function pair(a: AppController, b: AppController): Promise<void> {
  await a.addByAddress('127.0.0.1', b.state().self.port, 'bee');
  await b.addByAddress('127.0.0.1', a.state().self.port, 'ay');
}

describe('AppController', () => {
  it('pairs by address, sends a file, and both sides see it', async () => {
    const A = await make('alpha');
    const B = await make('beta');
    await pair(A.c, B.c);
    const f = join(tmpDir(), 'hello.txt');
    writeFileSync(f, 'hello world');
    const bId = B.c.state().self.deviceId;
    await A.c.send([bId], [{ kind: 'file', path: f }]);
    await until(() => A.c.state().transfers.some((t) => t.direction === 'out' && t.deviceId === bId && t.status === 'done'));
    const t = A.c.state().transfers.find((x) => x.deviceId === bId)!;
    expect(t).toMatchObject({ alias: 'bee', files: 1, bytes: 11 });
    await until(() => B.c.state().received.length === 1);
    expect(B.c.state().received[0]).toMatchObject({ from: A.c.state().self.deviceId, alias: 'ay', files: [join(B.inbox, 'hello.txt')] });
    expect(readFileSync(join(B.inbox, 'hello.txt'), 'utf8')).toBe('hello world');
    expect(B.p.notes.length).toBe(1);
  });

  it('puts received clipboard text on the clipboard only when clipboardReceive is on', async () => {
    const A = await make('a');
    const B = await make('b');
    const C = await make('c', { clipboardReceive: false });
    await pair(A.c, B.c);
    await pair(A.c, C.c);
    A.p.clipboardText = 'secret clip $(rm -rf ~)';
    await A.c.sendClipboard([B.c.state().self.deviceId, C.c.state().self.deviceId]);
    await until(() => B.c.state().received.length === 1 && C.c.state().received.length === 1);
    expect(B.p.clip).toEqual(['secret clip $(rm -rf ~)']);
    expect(C.p.clip).toEqual([]);
    expect(C.c.state().received[0]).toMatchObject({ text: 'secret clip $(rm -rf ~)', clipboard: true });
  });

  it('ignores a stale listen.pid and runs client-only next to a live listener', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    const h1 = tmpDir();
    writeFileSync(join(h1, 'listen.pid'), JSON.stringify({ pid: dead, port: 1 }));
    const S = await make('s', {}, h1);
    expect(S.c.state().mode).toBe('serving');
    expect(JSON.parse(readFileSync(join(h1, 'listen.pid'), 'utf8'))).toEqual({ pid: process.pid, port: S.c.state().self.port });

    const h2 = tmpDir();
    const port = await freePort();
    writeFileSync(join(h2, 'listen.pid'), JSON.stringify({ pid: process.ppid, port: 9 }));
    const L = await make('l', { port }, h2);
    expect(L.c.state().mode).toBe('client-only');
    const probe = createServer();
    await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(port, () => resolve()));
    await new Promise<void>((r) => probe.close(() => r())); // nothing bound the port
    expect(JSON.parse(readFileSync(join(h2, 'listen.pid'), 'utf8')).pid).toBe(process.ppid); // left alone
  });

  it('throttles state updates while a large folder transfers', async () => {
    const A = await make('a');
    const B = await make('b');
    await pair(A.c, B.c);
    const dir = join(tmpDir(), 'many');
    mkdirSync(dir);
    for (let i = 0; i < 2000; i++) writeFileSync(join(dir, `f${i}.txt`), `file ${i}`);
    const bId = B.c.state().self.deviceId;
    let updates = 0;
    A.c.on('state', (s: AppState) => {
      if (s.transfers.some((t) => t.deviceId === bId && t.direction === 'out' && t.sent > 0)) updates++;
    });
    const t0 = Date.now();
    await A.c.send([bId], [{ kind: 'dir', path: dir }]);
    await until(() => A.c.state().transfers.some((t) => t.deviceId === bId && t.status === 'done'), 60_000);
    await sleep(250);
    const secs = (Date.now() - t0) / 1000;
    expect(updates).toBeGreaterThan(0);
    expect(updates).toBeLessThanOrEqual(Math.ceil(secs * 10) + 2);
  }, 90_000);

  it('passes a hostile peer alias through state() as plain data', async () => {
    const A = await make('a');
    const B = await make('b');
    const evil = '<img src=x onerror=alert(1)>‮';
    await A.c.addByAddress('127.0.0.1', B.c.state().self.port, evil);
    expect(A.c.state().devices.find((d) => d.deviceId === B.c.state().self.deviceId)?.alias).toBe(evil);
  });

  it('refuses a port that is in use and keeps serving on the old one', async () => {
    const A = await make('a');
    const old = A.c.state().self.port;
    const blocker: Server = createServer();
    const busy = await new Promise<number>((r) => blocker.listen(0, () => r((blocker.address() as { port: number }).port)));
    try {
      await expect(A.c.setSettings({ port: busy })).rejects.toThrow(/in use/);
      expect(A.c.state().settings.port).toBe(0);
      expect(A.c.state().self.port).toBe(old);
    } finally {
      blocker.close();
    }
  });
});

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await new Promise<number>((r) => s.listen(0, () => r((s.address() as { port: number }).port)));
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
