import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine } from '@meshdrop/core/src/engine.ts';
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
  clipboardFiles: string[];
  clipFilesWritten: string[][];
}
function fakePlatform(): FakePlatform {
  const p: FakePlatform = {
    clip: [],
    notes: [],
    clipboardText: '',
    clipboardFiles: [],
    clipFilesWritten: [],
    readClipboardFiles: () => p.clipboardFiles,
    writeClipboardFiles: (paths) => {
      p.clipFilesWritten.push(paths);
      p.clipboardFiles = paths; // what a real clipboard would then hold
    },
    notify: (title, body) => void p.notes.push({ title, body }),
    writeClipboard: (t) => void p.clip.push(t),
    readClipboard: () => p.clipboardText,
    openPath: async () => {},
    revealPath: () => {},
    thumbnail: async () => null,
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
    engineOptions: { hub: { ingressPort: 0 }, hubBackoffMs: [50, 100], allowLoopbackHubUrls: true, guest: { port: 0 } },
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

  it('ignores a stale listen.pid (even with a live pid) and runs client-only next to a verified listener', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    const h1 = tmpDir();
    writeFileSync(join(h1, 'listen.pid'), JSON.stringify({ pid: dead, port: 1 }));
    const S = await make('s', {}, h1);
    expect(S.c.state().mode).toBe('serving');
    expect(JSON.parse(readFileSync(join(h1, 'listen.pid'), 'utf8'))).toEqual({ pid: process.pid, port: S.c.state().self.port });

    const h0 = tmpDir(); // a reused pid: alive, but not a MeshDrop listener
    writeFileSync(join(h0, 'listen.pid'), JSON.stringify({ pid: process.ppid, port: 9 }));
    expect((await make('r', {}, h0)).c.state().mode).toBe('serving');

    const h2 = tmpDir();
    const svc = await Engine.create({ home: h2, inbox: join(h2, 'inbox'), port: 0, discovery: false, alias: 'svc' });
    await svc.start();
    try {
      writeFileSync(join(h2, 'listen.pid'), JSON.stringify({ pid: process.ppid, port: svc.port }));
      const port = await freePort();
      const L = await make('l', { port }, h2);
      expect(L.c.state().mode).toBe('client-only');
      const probe = createServer();
      await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(port, () => resolve()));
      await new Promise<void>((r) => probe.close(() => r())); // nothing bound the port
      expect(JSON.parse(readFileSync(join(h2, 'listen.pid'), 'utf8')).pid).toBe(process.ppid); // left alone
      await expect(L.c.hubInit([])).rejects.toThrow(/background service/);
      await expect(L.c.setReceiving(false)).rejects.toThrow(/background service/);
    } finally {
      await svc.stop();
    }
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

  it('keeps two concurrent sends to one device apart', async () => {
    const A = await make('a');
    const B = await make('b');
    await pair(A.c, B.c);
    const bId = B.c.state().self.deviceId;
    const f = join(tmpDir(), 'big.bin');
    writeFileSync(f, Buffer.alloc(48 * 1024 * 1024, 7));
    await A.c.send([bId], [{ kind: 'file', path: f }]);
    await until(() => A.c.state().transfers.some((t) => t.sent > 0));
    A.p.clipboardText = 'meanwhile';
    await A.c.sendClipboard([bId]);
    const outs = () => A.c.state().transfers.filter((t) => t.direction === 'out');
    await until(() => outs().length === 2 && outs().every((t) => t.status === 'done'), 60_000);
    await sleep(300);
    expect(outs()).toHaveLength(2);
    expect(outs().find((t) => t.files === 1)).toMatchObject({ bytes: 48 * 1024 * 1024, sent: 48 * 1024 * 1024, status: 'done' });
  }, 90_000);

  it('Resume all does not add rows for sends whose device is away', async () => {
    const A = await make('a');
    const B = await make('b');
    await pair(A.c, B.c);
    const bId = B.c.state().self.deviceId;
    const f = join(tmpDir(), 'away.bin');
    writeFileSync(f, Buffer.alloc(64 * 1024 * 1024, 1));
    await A.c.send([bId], [{ kind: 'file', path: f }]);
    await until(() => A.c.state().transfers.some((t) => t.sent > 0));
    await B.c.stop();
    await until(() => A.c.state().outbox.length === 1 && !A.c.state().transfers.some((t) => t.status === 'sending' || t.status === 'preparing'), 30_000);
    const before = A.c.state().transfers.length;
    await A.c.resumeOutbox();
    await sleep(1500);
    expect(A.c.state().transfers).toHaveLength(before);
  }, 60_000);

  it('a send to a device that is away waits, then goes out when the device is seen again', async () => {
    const A = await make('a');
    const bHome = tmpDir();
    const B = await make('b', {}, bHome);
    await pair(A.c, B.c);
    const bId = B.c.state().self.deviceId;
    await B.c.stop();
    const f = join(tmpDir(), 'later.txt');
    writeFileSync(f, 'later');
    await A.c.send([bId], [{ kind: 'file', path: f }]);
    await until(() => A.c.state().transfers.some((t) => t.deviceId === bId && t.status === 'waiting'), 30_000);
    expect(A.c.state().outbox).toEqual([expect.objectContaining({ deviceId: bId, waiting: true })]);
    const B2 = await make('b', {}, bHome);
    await A.c.addNearby('127.0.0.1', B2.c.state().self.port);
    await until(() => A.c.state().transfers.some((t) => t.deviceId === bId && t.status === 'done'), 30_000);
    expect(readFileSync(join(B2.inbox, 'later.txt'), 'utf8')).toBe('later');
    await until(() => A.c.state().outbox.length === 0);
  }, 60_000);

  it('shared clipboard: newly copied text reaches the other device, and does not echo back', async () => {
    const A = await make('a', { clipboardSync: true });
    const B = await make('b', { clipboardSync: true });
    await pair(A.c, B.c);
    A.p.clipboardText = 'already there';
    await sleep(1500); // the first look only takes note
    A.p.clipboardText = 'copied on A';
    await until(() => B.p.clip.includes('copied on A'), 15_000);
    B.p.clipboardText = 'copied on A'; // B's clipboard now holds it: B must not send it back
    await sleep(2500);
    expect(A.p.clip).toEqual([]);
    expect(B.p.clip).not.toContain('already there');
  }, 30_000);

  it('folder sync: set up from the app on both sides, a file travels, the state shows the round', async () => {
    const A = await make('a');
    const B = await make('b');
    await pair(A.c, B.c);
    const fa = join(tmpDir(), 'SyncA');
    const fb = join(tmpDir(), 'SyncB');
    await A.c.syncPut('Shared', fa, [B.c.state().self.deviceId]);
    await B.c.syncPut('Shared', fb, [A.c.state().self.deviceId]);
    writeFileSync(join(fa, 'shared.txt'), 'both');
    await B.c.syncNow();
    expect(readFileSync(join(fb, 'shared.txt'), 'utf8')).toBe('both');
    const p = B.c.state().sync!.folders[0]!.partners[0]!;
    expect(p).toMatchObject({ deviceId: A.c.state().self.deviceId, present: true, last: { errors: 0 } }); // pulled by syncNow or already by the poke
    expect(B.c.state().sync!.folders.map((f) => [f.name, f.folder])).toEqual([['Shared', fb]]);
    await B.c.syncRemove('Shared');
    expect(B.c.state().sync!.folders).toEqual([]);
  }, 30_000);

  it('shared clipboard: files copied on one PC are put on the other one\'s clipboard, without echo', async () => {
    const A = await make('a', { clipboardSync: true });
    const B = await make('b', { clipboardSync: true });
    await pair(A.c, B.c);
    await sleep(1500); // the first look only takes note
    const f = join(tmpDir(), 'report.pdf');
    writeFileSync(f, 'pdf');
    A.p.clipboardFiles = [f];
    await until(() => B.p.clipFilesWritten.length === 1, 15_000);
    expect(B.p.clipFilesWritten[0]).toEqual([join(B.inbox, 'report.pdf')]);
    expect(readFileSync(join(B.inbox, 'report.pdf'), 'utf8')).toBe('pdf');
    await sleep(2500);
    expect(A.p.clipFilesWritten).toEqual([]); // B did not send it back
    expect(B.p.notes.some((n) => n.title === 'Clipboard')).toBe(true);
  }, 30_000);

  it('files handed in from Files wait for the Send page, once', async () => {
    const A = await make('a');
    const d = tmpDir();
    const f = join(d, 'a.txt');
    writeFileSync(f, 'a');
    A.c.addShared([f, d, join(d, 'missing')]);
    expect(A.c.state().sharedPending).toBe(2);
    expect(await A.c.takeSharedItems()).toEqual([{ kind: 'file', path: f }, { kind: 'dir', path: d }]);
    expect(A.c.state().sharedPending).toBeUndefined();
  });

  it('pausing receiving refuses files but keeps the device and its hub up', async () => {
    const H = await make('hub');
    await H.c.hubInit([]);
    const A = await make('a');
    expect(await A.c.join((await H.c.createInvite()).uri)).toBe('member');
    await until(() => A.c.state().hub.online);
    await H.c.setReceiving(false);
    expect(H.c.state().hub.online).toBe(true);
    expect(H.c.receiving).toBe(false);
    const f = join(tmpDir(), 'p.txt');
    writeFileSync(f, 'paused?');
    const hId = H.c.state().self.deviceId;
    await A.c.send([hId], [{ kind: 'file', path: f }]);
    await until(() => A.c.state().transfers.some((t) => t.deviceId === hId && t.status === 'failed'), 30_000);
    expect(H.c.state().received).toEqual([]);
    await H.c.setReceiving(true);
    await A.c.send([hId], [{ kind: 'file', path: f }]);
    await until(() => H.c.state().received.length === 1, 30_000);
  }, 60_000);

  it('starts without receiving when its port is taken, says why, and recovers from Settings', async () => {
    const blocker: Server = createServer();
    const busy = await new Promise<number>((r) => blocker.listen(0, () => r((blocker.address() as { port: number }).port)));
    try {
      const A = await make('a', { port: busy });
      expect(A.c.state().error).toMatch(/in use/);
      expect(A.c.state().settings.port).toBe(busy);
      await A.c.setSettings({ port: 0 });
      expect(A.c.state().error).toBeUndefined();
      expect(A.c.state().self.port).not.toBe(busy);
    } finally {
      blocker.close();
    }
  });

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

describe('AppController guests', () => {
  it('opens a guest link for the set length, prompts for an offer, and records what was received', async () => {
    const A = await make('alpha', { guestMinutes: 15 });
    expect(A.c.state().guest).toMatchObject({ active: false, available: true });
    const g = await A.c.guestStart();
    expect(Math.abs(g.expiresAt - (Date.now() + 15 * 60_000))).toBeLessThan(5_000);
    expect(A.c.state().guest).toMatchObject({ active: true, url: g.url, qrSvg: g.qrSvg, claimed: false });
    const token = g.url.split('/').pop()!;
    const base = g.url.slice(0, g.url.indexOf('/g/'));
    const cookie = ((await fetch(g.url)).headers.get('set-cookie') ?? '').split(';')[0]!;
    const h = { 'x-guest-token': token, cookie };
    const { id } = (await (await fetch(`${base}/g/api/offers`, { method: 'POST', headers: h, body: JSON.stringify({ files: [{ name: 'g.txt', size: 2 }], text: 'hi' }) })).json()) as { id: string };
    await until(() => (A.c.state().guest?.offers.length ?? 0) === 1);
    expect(A.c.state().guest?.offers[0]).toMatchObject({ id, text: 'hi', files: [{ name: 'g.txt', size: 2 }] });
    expect(A.p.notes.some((n) => n.title === 'A guest wants to send')).toBe(true);
    await A.c.guestAccept(id);
    await fetch(`${base}/g/api/offers/${id}/0?offset=0`, { method: 'PUT', headers: h, body: 'ok' });
    await until(() => A.c.state().received.some((r) => r.from === 'guest'));
    expect(A.c.state().received.find((r) => r.from === 'guest')).toMatchObject({ alias: 'Guest', files: [join(A.inbox, 'g.txt')], text: 'hi' });
    const shared = join(tmpDir(), 's.txt');
    writeFileSync(shared, 'x');
    await A.c.guestShare([shared]);
    expect(A.c.state().guest?.shared).toEqual([{ id: expect.any(String), name: 's.txt', size: 1 }]);
    await A.c.guestEnd();
    expect(A.c.state().guest?.active).toBe(false);
    expect((await fetch(`${base}/g/api/session`, { headers: h })).status).toBe(410);
  });

  it('keeps the guest length within 5 minutes to 24 hours', async () => {
    const A = await make('alpha');
    expect(A.c.state().settings.guestMinutes).toBe(60);
    await expect(A.c.setSettings({ guestMinutes: 2 })).rejects.toThrow(/5/);
    await expect(A.c.setSettings({ guestMinutes: 2000 })).rejects.toThrow(/1440|24/);
    expect((await A.c.setSettings({ guestMinutes: 240 })).guestMinutes).toBe(240);
  });
});

describe('AppController internet links', () => {
  it('the hub creates, lists and removes links; other devices cannot', async () => {
    const H = await make('hub');
    await H.c.hubInit([]);
    const f = join(tmpDir(), 'gift.txt');
    writeFileSync(f, 'gift');
    const l = await H.c.linkCreate({ files: [f], days: 1, allowUploads: false, maxDownloads: 2 });
    expect(l.url).toContain(`/l/${l.id}#k=`);
    await until(() => (H.c.state().links ?? []).some((x) => x.id === l.id));
    expect(H.c.state().links![0]).toMatchObject({ id: l.id, label: 'gift.txt', maxDownloads: 2, url: l.url });
    await H.c.linkRevoke(l.id);
    expect(H.c.state().links).toEqual([]);
    const A = await make('a');
    expect(A.c.state().links).toBeUndefined();
    await expect(A.c.linkCreate({ files: [f], days: 1, allowUploads: false })).rejects.toThrow(/hub/);
  });
});

describe('AppController internet access', () => {
  it('turns Tailscale Funnel on for the hub and reports a missing CLI with its fix', async () => {
    const home = tmpDir();
    const inbox = join(home, 'inbox');
    let installed = false;
    const settings = new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias: 'hub', inbox, port: 0, discovery: false }));
    const c = new AppController({
      home, settings, history: new HistoryStore(join(home, 'desktop-history.json')), platform: fakePlatform(),
      engineOptions: {
        hub: { ingressPort: 0 }, guest: { port: 0 },
        reach: {
          runner: async (cmd, args) => {
            if (!installed) return { code: 127, stdout: '', stderr: 'not found' };
            if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub.tail1.ts.net.' } }), stderr: '' };
            return { code: 0, stdout: '{}', stderr: '' };
          },
        },
      },
    });
    ctls.push(c);
    await c.start();
    await c.hubInit([]);
    await until(() => c.state().reach !== undefined);
    await expect(c.reachSet({ mode: 'tailscale' })).rejects.toThrow(/tailscale\.com\/download/);
    installed = true;
    await c.reachSet({ mode: 'tailscale' });
    await until(() => c.state().reach?.state === 'on');
    expect(c.state().reach).toMatchObject({ mode: 'tailscale', url: 'wss://hub.tail1.ts.net/mesh/v1/hub' });
    expect(c.state().hub.urls).toEqual(['wss://hub.tail1.ts.net/mesh/v1/hub']);
  });
});
