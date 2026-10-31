import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { OFFER_FILE, UPLOAD_BASE, sealChunk, uploadKey } from '@meshdrop/core/src/links/crypto.ts';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine } from '@meshdrop/core/src/engine.ts';
import { PassThrough } from 'node:stream';
import { AppController, toPrims, type InputPrim, type MediaPipe, type Platform } from '../src/main/controller.ts';
import { HistoryStore } from '../src/main/history.ts';
import { SettingsStore, defaultSettings } from '../src/main/settings.ts';
import { NetMan, type Run } from '../src/main/netman.ts';
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
  opened: string[];
  revealed: string[];
  prims: InputPrim[];
  lasers: [number, number, boolean][];
  rings: boolean[];
  urls: string[];
  camera: Buffer[];
  speaker: Buffer[];
  mic: Buffer[];
  printed: string[];
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
    opened: [],
    revealed: [],
    prims: [],
    lasers: [],
    rings: [],
    urls: [],
    camera: [],
    speaker: [],
    mic: [],
    printed: [],
    print: async (f) => void p.printed.push(f),
    captureAudio: (): MediaPipe => {
      const out = new PassThrough();
      out.write(Buffer.alloc(1920, 7));
      return { out, stop: () => out.end(), onExit: () => {} };
    },
    speakerSink: (): MediaPipe => {
      const inp = new PassThrough();
      inp.on('data', (c: Buffer) => p.speaker.push(c));
      return { in: inp, stop: () => inp.destroy(), onExit: () => {} };
    },
    cameraSink: (): MediaPipe => {
      const inp = new PassThrough();
      inp.on('data', (c: Buffer) => p.camera.push(c));
      return { in: inp, stop: () => inp.destroy(), onExit: () => {} };
    },
    micSink: (): MediaPipe => {
      const inp = new PassThrough();
      inp.on('data', (c: Buffer) => p.mic.push(c));
      return { in: inp, stop: () => inp.destroy(), onExit: () => {} };
    },
    input: async (x) => void p.prims.push(...x),
    laser: (x, y, on) => void p.lasers.push([x, y, on]),
    ring: (on) => void p.rings.push(on),
    openUrl: async (u) => void p.urls.push(u),
    status: async () => ({ battery: { level: 42, charging: true } }),
    openPath: async (x) => void p.opened.push(x),
    revealPath: (x) => void p.revealed.push(x),
    thumbnail: async () => null,
  };
  return p;
}

async function make(alias: string, over: Partial<Settings> = {}, home = tmpDir(), net?: (onChange: () => void) => NetMan): Promise<{ c: AppController; p: FakePlatform; home: string; inbox: string }> {
  const inbox = join(home, 'inbox');
  const settings = new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias, inbox, port: 0, discovery: false, ...over }));
  const p = fakePlatform();
  const c = new AppController({
    home,
    settings,
    history: new HistoryStore(join(home, 'desktop-history.json')),
    platform: p,
    engineOptions: { hub: { ingressPort: 0 }, hubBackoffMs: [50, 100], allowLoopbackHubUrls: true, guest: { port: 0 } },
    timing: { burnAfterOpenMs: 300, tickMs: 100, scheduleMinMs: 200 },
    ...(net ? { net } : {}),
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

  it('shared clipboard with slow async reads (Linux helper): polls never overlap, and still sync', async () => {
    const A = await make('a', { clipboardSync: true });
    const B = await make('b', { clipboardSync: true });
    await pair(A.c, B.c);
    let reading = 0;
    let most = 0;
    A.p.readClipboard = async () => {
      const snap = A.p.clipboardText;
      most = Math.max(most, ++reading);
      await sleep(2500); // slower than the 1 s poll
      reading--;
      return snap;
    };
    A.p.clipboardText = 'already there';
    await sleep(3000);
    A.p.clipboardText = 'copied on A (slowly)';
    await until(() => B.p.clip.includes('copied on A (slowly)'), 15_000);
    expect(most).toBe(1);
  }, 30_000);

  it('shared clipboard: a poll that read before received text landed does not send the old text back', async () => {
    const A = await make('a', { clipboardSync: true });
    const B = await make('b', { clipboardSync: true });
    await pair(A.c, B.c);
    B.p.clipboardText = 'old on B';
    B.p.writeClipboard = (t) => {
      B.p.clip.push(t);
      B.p.clipboardText = t; // a real clipboard now holds it
    };
    // B's reads take most of a poll, so one is in flight when A's text arrives
    B.p.readClipboard = async () => {
      const snap = B.p.clipboardText;
      await sleep(950);
      return snap;
    };
    await sleep(2500); // the first look only takes note
    A.p.clipboardText = 'copied on A';
    await sleep(1500);
    A.p.clipboardText = 'copied on A';
    await until(() => B.p.clip.includes('copied on A'), 15_000);
    await sleep(3000);
    expect(A.p.clip).not.toContain('old on B');
    expect(A.p.clip).toEqual([]);
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
  it('a received program or script is shown in its folder, never started (security review #13)', async () => {
    const A = await make('ay');
    mkdirSync(A.inbox, { recursive: true });
    for (const n of ['photo.jpg', 'evil.desktop', 'run.sh', 'noext']) writeFileSync(join(A.inbox, n), 'x');
    chmodSync(join(A.inbox, 'noext'), 0o755);
    for (const n of ['photo.jpg', 'evil.desktop', 'run.sh', 'noext']) await A.c.openFile(join(A.inbox, n));
    expect(A.p.opened).toEqual([join(A.inbox, 'photo.jpg')]);
    expect(A.p.revealed).toEqual(['evil.desktop', 'run.sh', 'noext'].map((n) => join(A.inbox, n)));
  });

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
  it('a send through an internet link asks the owner to accept, with no guest QR open (it waited forever)', async () => {
    const H = await make('hub');
    await H.c.hubInit([]);
    const l = await H.c.linkCreate({ files: [], text: 'Send your files here.', days: 1, allowUploads: true });
    const key = Buffer.from(l.url.split('#k=')[1]!, 'base64url');
    const api = `${l.url.slice(0, l.url.indexOf('/l/'))}/l/${l.id}/api`;
    const { session } = (await (await fetch(`${api}/open`, { method: 'POST', headers: { 'x-link-key': key.toString('base64url') } })).json()) as { session: string };
    const salt = randomBytes(16);
    const offer = sealChunk(uploadKey(key, l.id, salt), l.id, OFFER_FILE, 0, true, Buffer.from(JSON.stringify({ files: [{ name: 'back.txt', size: 4 }] })));
    const { id } = (await (await fetch(`${api}/offers`, { method: 'POST', headers: { 'x-link-session': session, 'x-upload-salt': salt.toString('base64url') }, body: new Uint8Array(offer) })).json()) as { id: string };
    expect(H.c.state().guest?.active).toBe(false);
    await until(() => (H.c.state().guest?.offers.length ?? 0) === 1);
    expect(H.c.state().guest?.offers[0]).toMatchObject({ id, via: 'link' });
    await H.c.guestAccept(id);
    expect(((await (await fetch(`${api}/offers/${id}`, { headers: { 'x-link-session': session } })).json()) as { status: string }).status).toBe('accepted');
    const up = sealChunk(uploadKey(key, l.id, salt), l.id, UPLOAD_BASE, 0, true, Buffer.from('back'));
    expect((await fetch(`${api}/offers/${id}/0?offset=0`, { method: 'PUT', headers: { 'x-link-session': session }, body: new Uint8Array(up) })).status).toBeLessThan(300);
    await until(() => existsSync(join(H.inbox, 'back.txt')));
    expect(readFileSync(join(H.inbox, 'back.txt'), 'utf8')).toBe('back');
  });

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
          runner: async (_cmd, args) => {
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

  it('M10 app messages: input only from allowed devices, ring, notifications, link handoff, status', async () => {
    const A = await make('ay');
    const B = await make('bee');
    await pair(A.c, B.c);
    const aId = A.c.state().self.deviceId;
    const bId = B.c.state().self.deviceId;
    const input = { kind: 'input', events: [{ t: 'move', dx: 5, dy: -3 }, { t: 'click', b: 'left' }, { t: 'laser', x: 0.5, y: 0.25, on: true }] };
    expect(await A.c.appSend(bId, input)).toMatchObject({ status: 403, body: { error: 'remote-off' } });
    expect(B.p.prims).toEqual([]);
    await B.c.setSettings({ remoteFrom: [aId] });
    expect(await A.c.appSend(bId, input)).toMatchObject({ status: 200 });
    expect(B.p.prims).toEqual([{ t: 'move', dx: 5, dy: -3 }, { t: 'button', button: 272, down: true }, { t: 'button', button: 272, down: false }]);
    expect(B.p.lasers).toEqual([[0.5, 0.25, true]]);

    expect(await A.c.appSend(bId, { kind: 'ring' })).toMatchObject({ status: 200 });
    expect(B.c.state().ringing).toBe(true);
    await B.c.ringStop();
    expect(B.p.rings).toEqual([true, false]);

    await A.c.appSend(bId, { kind: 'notify', key: 'k1', app: 'Messages', title: 'Mum', text: 'call me', time: 5, replyable: true });
    expect(B.c.state().phoneNotes).toEqual([expect.objectContaining({ from: aId, key: 'k1', title: 'Mum', text: 'call me', replyable: true })]);
    await A.c.appSend(bId, { kind: 'notify-removed', key: 'k1' });
    expect(B.c.state().phoneNotes).toEqual([]);

    expect(await A.c.appSend(bId, { kind: 'open-url', url: 'javascript:alert(1)' })).toMatchObject({ status: 400 });
    expect(await A.c.appSend(bId, { kind: 'open-url', url: 'https://example.com/a' })).toMatchObject({ status: 200 });
    expect(B.p.urls).toEqual(['https://example.com/a']);
    await B.c.setSettings({ openLinks: false });
    expect(await A.c.appSend(bId, { kind: 'open-url', url: 'https://example.com/b' })).toMatchObject({ status: 403 });

    expect(await A.c.appSend(bId, { kind: 'status' })).toMatchObject({ status: 200, body: { battery: { level: 42 } } });
    expect(A.c.state().deviceStatus?.[bId]).toMatchObject({ battery: { level: 42, charging: true } });
  });

  it('M14: a shared hotspot is joined when the Wi-Fi is free, offered when not; hosting asks before leaving a network', async () => {
    let network = '';
    const calls: string[][] = [];
    const nmcli: Run = async (_c, args) => {
      calls.push(args);
      if (args[0] !== '-t') return '';
      return `GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:${network ? 100 : 30} (x)\nGENERAL.CONNECTION:${network || '--'}\nGENERAL.METERED:no\nGENERAL.DRIVER:iwlwifi\n`;
    };
    const A = await make('alpha');
    const B = await make('beta', {}, tmpDir(), (onChange) => new NetMan(nmcli, onChange, 'me'));
    await pair(A.c, B.c);
    const bId = B.c.state().self.deviceId;
    expect(A.c.state().noWifi).toBeUndefined(); // no NetworkManager there
    expect(B.c.state().noWifi).toEqual({ guarded: [] });

    expect(await A.c.appSend(bId, { kind: 'hotspot', ssid: 'PhoneAP', psk: 'short' })).toMatchObject({ status: 400 });
    expect(await A.c.appSend(bId, { kind: 'hotspot', ssid: 'PhoneAP', psk: 'secret123', hosts: ['127.0.0.1:1', 'evil'] })).toMatchObject({ status: 200 });
    await until(() => B.c.state().noWifi?.hotspot?.role === 'joined');
    expect(B.c.state().noWifi?.hotspot).toEqual({ role: 'joined', ssid: 'PhoneAP' });
    expect(calls.some((a) => a[0] === 'connection' && a[1] === 'up')).toBe(true);
    expect(calls.flat()).not.toContain('secret123');

    await B.c.hotspotStop();
    expect(calls.at(-1)).toEqual(['connection', 'delete', 'id', 'MeshDrop join']);
    network = 'Home';
    await A.c.appSend(bId, { kind: 'hotspot', ssid: 'PhoneAP', psk: 'secret123', hosts: [] });
    await until(() => B.c.state().noWifi?.offer?.ssid === 'PhoneAP');
    expect(B.c.state().noWifi?.hotspot).toBeUndefined(); // the Wi-Fi stays on Home
    await expect(B.c.hotspotJoin('PhoneAP', 'secret123')).rejects.toThrow('wifi-busy:Home');

    await expect(B.c.hotspotStart()).rejects.toThrow('wifi-busy:Home');
    await B.c.hotspotStart(true);
    const h = B.c.state().noWifi?.hotspot;
    expect(h).toMatchObject({ role: 'host', ssid: expect.stringMatching(/^MeshDrop-/) });
    expect(h?.qrSvg).toContain('<svg');
    expect(B.c.state().noWifi?.offer).toBeUndefined();
    expect(calls.some((a) => a[2] === 'hotspot' && a.includes(h!.ssid))).toBe(true);
  });

  it('toPrims types text and keys with modifiers', () => {
    expect(toPrims([{ t: 'text', s: 'aé€' }]).filter((p) => p.t === 'key' && p.down).map((p) => (p as { keysym: number }).keysym)).toEqual([0x61, 0xe9, 0x01000000 + 0x20ac]);
    expect(toPrims([{ t: 'key', k: 'Tab', mods: ['Alt'] }])).toEqual([
      { t: 'key', keysym: 0xffe9, down: true }, { t: 'key', keysym: 0xff09, down: true }, { t: 'key', keysym: 0xff09, down: false }, { t: 'key', keysym: 0xffe9, down: false },
    ]);
    expect(toPrims([{ t: 'key', k: 'rm -rf' }])).toEqual([]);
  });

  it('a phone playing its sound here as Bluetooth audio shows under Live now, and Stop ends it', async () => {
    const home = tmpDir();
    let report: (s: { address: string; name: string }[]) => void = () => undefined;
    const stopped: string[] = [];
    const bt = {
      bonded: async () => [],
      dial: async () => { throw new Error('Host is down'); },
      listen: async () => undefined,
      stop: () => undefined,
      onAudio: (cb: typeof report) => { report = cb; },
      audioStop: async (a: string) => { stopped.push(a); report([]); },
    };
    const c = new AppController({
      home,
      settings: new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias: 'pc', inbox: join(home, 'inbox'), port: 0, discovery: false })),
      history: new HistoryStore(join(home, 'desktop-history.json')),
      platform: fakePlatform(),
      engineOptions: { hub: { ingressPort: 0 }, guest: { port: 0 } },
      bt,
    });
    ctls.push(c);
    await c.start();
    const pushed: AppState[] = [];
    c.on('state', (st: AppState) => pushed.push(st));
    report([{ address: 'DD:DD:DD:DD:DD:DD', name: 'POCO X3 Pro' }]);
    await until(() => pushed.some((st) => st.streams?.length === 1)); // the window hears of it
    expect(c.state().streams).toEqual([{ id: 'bt-audio:DD:DD:DD:DD:DD:DD', kind: 'bt-audio', peer: '', alias: 'POCO X3 Pro' }]);
    await c.streamStop('bt-audio:DD:DD:DD:DD:DD:DD');
    expect(stopped).toEqual(['DD:DD:DD:DD:DD:DD']);
    expect(c.state().streams).toEqual([]);
  });

  it('a search for Bluetooth devices warns only while a stream goes over the Bluetooth link', async () => {
    const home = tmpDir();
    let scan: (on: boolean) => void = () => undefined;
    const bt = {
      bonded: async () => [],
      dial: async () => { throw new Error('Host is down'); },
      listen: async () => undefined,
      stop: () => undefined,
      onScanning: (cb: typeof scan) => { scan = cb; },
    };
    const p = fakePlatform();
    const c = new AppController({
      home,
      settings: new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias: 'pc', inbox: join(home, 'inbox'), port: 0, discovery: false })),
      history: new HistoryStore(join(home, 'desktop-history.json')),
      platform: p,
      engineOptions: { hub: { ingressPort: 0 }, guest: { port: 0 } },
      bt,
    });
    ctls.push(c);
    await c.start();
    scan(true);
    expect(c.state().btScanning).toBeUndefined(); // nothing streams over Bluetooth: nothing to break up
    expect(p.notes).toEqual([]);
  });

  it('a phone asks the PC to stop its own Bluetooth audio, and only its own', async () => {
    const A = await make('ay');
    const aId = A.c.state().self.deviceId;
    const home = tmpDir();
    writeFileSync(join(home, 'bt-peers.json'), JSON.stringify({ 'DD:DD:DD:DD:DD:DD': aId }));
    let report: (s: { address: string; name: string }[]) => void = () => undefined;
    const stopped: string[] = [];
    const bt = {
      bonded: async () => [],
      dial: async () => { throw new Error('Host is down'); },
      listen: async () => undefined,
      stop: () => undefined,
      onAudio: (cb: typeof report) => { report = cb; },
      audioStop: async (a: string) => { stopped.push(a); report([]); },
    };
    const B = new AppController({
      home,
      settings: new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias: 'bee', inbox: join(home, 'inbox'), port: 0, discovery: false })),
      history: new HistoryStore(join(home, 'desktop-history.json')),
      platform: fakePlatform(),
      engineOptions: { hub: { ingressPort: 0 }, guest: { port: 0 } },
      bt,
    });
    ctls.push(B);
    await B.start();
    await pair(A.c, B);
    const bId = B.state().self.deviceId;
    expect(await A.c.appSend(bId, { kind: 'bt-audio-stop' })).toMatchObject({ status: 404, body: { error: 'not-playing' } });
    report([{ address: 'EE:EE:EE:EE:EE:EE', name: 'Someone else' }, { address: 'DD:DD:DD:DD:DD:DD', name: 'POCO X3 Pro' }]);
    expect(await A.c.appSend(bId, { kind: 'bt-audio-stop' })).toMatchObject({ status: 200 });
    expect(stopped).toEqual(['DD:DD:DD:DD:DD:DD']);
  });

  it('a phone asks the PC to connect its Bluetooth audio, so it needs no reconnect by hand', async () => {
    const A = await make('ay');
    const aId = A.c.state().self.deviceId;
    const home = tmpDir();
    writeFileSync(join(home, 'bt-peers.json'), JSON.stringify({ 'DD:DD:DD:DD:DD:DD': aId }));
    let report: (s: { address: string; name: string }[]) => void = () => undefined;
    const started: string[] = [];
    let fail = false;
    const bt = {
      bonded: async () => [],
      dial: async () => { throw new Error('Host is down'); },
      listen: async () => undefined,
      stop: () => undefined,
      onAudio: (cb: typeof report) => { report = cb; },
      audioStop: async () => undefined,
      audioStart: async (a: string) => {
        if (fail) throw new Error('br-connection-page-timeout');
        started.push(a);
        report([{ address: a, name: 'POCO X3 Pro' }]);
      },
    };
    const B = new AppController({
      home,
      settings: new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias: 'bee', inbox: join(home, 'inbox'), port: 0, discovery: false })),
      history: new HistoryStore(join(home, 'desktop-history.json')),
      platform: fakePlatform(),
      engineOptions: { hub: { ingressPort: 0 }, guest: { port: 0 } },
      bt,
    });
    ctls.push(B);
    await B.start();
    await pair(A.c, B);
    const bId = B.state().self.deviceId;
    fail = true;
    expect(await A.c.appSend(bId, { kind: 'bt-audio-start' })).toMatchObject({ status: 502, body: { error: 'br-connection-page-timeout' } });
    fail = false;
    expect(await A.c.appSend(bId, { kind: 'bt-audio-start' })).toMatchObject({ status: 200 });
    expect(started).toEqual(['DD:DD:DD:DD:DD:DD']);
    // already playing here: nothing to connect
    expect(await A.c.appSend(bId, { kind: 'bt-audio-start' })).toMatchObject({ status: 200 });
    expect(started).toEqual(['DD:DD:DD:DD:DD:DD']);
  });

  it.skipIf(spawnSync('gst-launch-1.0', ['--version']).status !== 0)("a phone's microphone over Bluetooth leaves its Bluetooth audio alone; this PC's sound holds it", async () => {
    const { LanTransport } = await import('@meshdrop/core/src/transfer/transport.ts');
    const { loadOrCreateIdentity } = await import('@meshdrop/core/src/identity.ts');
    const { opusEncoder, opusType } = await import('../src/main/opus.ts');
    const A = await make('ay');
    const aId = A.c.state().self.deviceId;
    const home = tmpDir();
    writeFileSync(join(home, 'bt-peers.json'), JSON.stringify({ 'DD:DD:DD:DD:DD:DD': aId }));
    const started: string[] = [];
    const bt = {
      bonded: async () => [],
      dial: async () => { throw new Error('Host is down'); },
      listen: async () => undefined,
      stop: () => undefined,
      onAudio: () => undefined,
      audioStop: async () => undefined,
      audioStart: async (a: string) => void started.push(a),
    };
    const p = fakePlatform();
    const B = new AppController({
      home,
      settings: new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias: 'bee', inbox: join(home, 'inbox'), port: 0, discovery: false })),
      history: new HistoryStore(join(home, 'desktop-history.json')),
      platform: p,
      engineOptions: { hub: { ingressPort: 0 }, guest: { port: 0 } },
      bt,
    });
    ctls.push(B);
    await B.start();
    await pair(A.c, B);
    await B.setSettings({ remoteFrom: [aId] });
    const enc = opusEncoder(1);
    const chunks: Buffer[] = [];
    enc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((r) => enc.on('end', r));
    enc.end(Buffer.alloc(48_000 * 2 / 2)); // half a second of silence
    await done;
    const idA = await loadOrCreateIdentity(A.home);
    const lan = new LanTransport(idA, { deviceId: B.state().self.deviceId, host: '127.0.0.1', port: B.state().self.port });
    const r = await lan.request('POST', '/mesh/v1/stream/mic', Buffer.concat(chunks), { 'content-type': opusType(1) }, { timeoutMs: 10_000 });
    expect(r.status).toBe(200);
    await until(() => Buffer.concat(p.mic).length > 0);
    expect(started).toEqual([]);
    const { connectPinned } = await import('@meshdrop/core/src/tls.ts');
    const sock = await connectPinned('127.0.0.1', B.state().self.port, idA, B.state().self.deviceId, { timeoutMs: 5000 });
    sock.write('GET /mesh/v1/stream/audio?codec=opus HTTP/1.0\r\nHost: x\r\n\r\n');
    await until(() => started.length > 0);
    expect(started).toEqual(['DD:DD:DD:DD:DD:DD']);
    sock.destroy();
    await new Promise((r) => setTimeout(r, 200));
  });

  it('a phone with no Bluetooth link here cannot ask for Bluetooth audio', async () => {
    const A = await make('ay');
    const home = tmpDir();
    const bt = {
      bonded: async () => [],
      dial: async () => { throw new Error('Host is down'); },
      listen: async () => undefined,
      stop: () => undefined,
      onAudio: () => undefined,
      audioStop: async () => undefined,
      audioStart: async () => { throw new Error('unexpected'); },
    };
    const B = new AppController({
      home,
      settings: new SettingsStore(join(home, 'desktop-settings.json'), defaultSettings({ alias: 'bee', inbox: join(home, 'inbox'), port: 0, discovery: false })),
      history: new HistoryStore(join(home, 'desktop-history.json')),
      platform: fakePlatform(),
      engineOptions: { hub: { ingressPort: 0 }, guest: { port: 0 } },
      bt,
    });
    ctls.push(B);
    await B.start();
    await pair(A.c, B);
    expect(await A.c.appSend(B.state().self.deviceId, { kind: 'bt-audio-start' })).toMatchObject({ status: 409, body: { error: 'no-bluetooth' } });
  });

  it('M10b streams: PC sound only for allowed devices; a phone camera arrives as a stream', async () => {
    const { LanTransport } = await import('@meshdrop/core/src/transfer/transport.ts');
    const { loadOrCreateIdentity } = await import('@meshdrop/core/src/identity.ts');
    const A = await make('ay');
    const B = await make('bee');
    await pair(A.c, B.c);
    const aId = A.c.state().self.deviceId;
    const idA = await loadOrCreateIdentity(A.home);
    const lan = () => new LanTransport(idA, { deviceId: B.c.state().self.deviceId, host: '127.0.0.1', port: B.c.state().self.port });
    expect((await lan().request('GET', '/mesh/v1/stream/audio', undefined, {}, { timeoutMs: 5000 })).status).toBe(403);
    await B.c.setSettings({ remoteFrom: [aId] });
    const { connectPinned } = await import('@meshdrop/core/src/tls.ts');
    const sock = await connectPinned('127.0.0.1', B.c.state().self.port, idA, B.c.state().self.deviceId, { timeoutMs: 5000 });
    sock.write('GET /mesh/v1/stream/audio HTTP/1.0\r\nHost: x\r\n\r\n');
    let got = Buffer.alloc(0);
    await new Promise<void>((ok) => sock.on('data', (c: Buffer) => ((got = Buffer.concat([got, c])), got.length > 1900 && ok())));
    expect(got.toString('latin1')).toMatch(/^HTTP\/1\.1 200[\s\S]*audio\/L16/);
    expect(B.c.state().streams).toEqual([expect.objectContaining({ kind: 'audio', peer: aId })]);
    sock.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(B.c.state().streams).toEqual([]);

    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const r = await lan().request('POST', '/mesh/v1/stream/camera', jpeg, { 'content-type': 'image/jpeg' }, { timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect(Buffer.concat(B.p.camera)).toEqual(jpeg);
  });

  it.skipIf(spawnSync('gst-launch-1.0', ['--version']).status !== 0)('M14: sound sent as Opus (a Bluetooth link) plays as PCM', async () => {
    const { LanTransport } = await import('@meshdrop/core/src/transfer/transport.ts');
    const { loadOrCreateIdentity } = await import('@meshdrop/core/src/identity.ts');
    const { opusEncoder, opusType } = await import('../src/main/opus.ts');
    const A = await make('ay');
    const B = await make('bee');
    await pair(A.c, B.c);
    await B.c.setSettings({ remoteFrom: [A.c.state().self.deviceId] });
    const enc = opusEncoder(2);
    const chunks: Buffer[] = [];
    enc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((r) => enc.on('end', r));
    enc.end(Buffer.alloc(48_000 * 4 / 2)); // half a second of silence
    await done;
    const opus = Buffer.concat(chunks);
    const idA = await loadOrCreateIdentity(A.home);
    const lan = new LanTransport(idA, { deviceId: B.c.state().self.deviceId, host: '127.0.0.1', port: B.c.state().self.port });
    const r = await lan.request('POST', '/mesh/v1/stream/sound', opus, { 'content-type': opusType(2) }, { timeoutMs: 10_000 });
    expect(r.status).toBe(200);
    // decoded PCM arrives (the live filter keeps ~120 ms of a burst), then the stream closes
    await until(() => Buffer.concat(B.p.speaker).length >= 48_000 * 4 / 20);
    expect(Buffer.concat(B.p.speaker).length).toBeGreaterThan(opus.length);
    await until(() => (B.c.state().streams ?? []).length === 0);
  });

  it("one PC's sound plays on another PC that allows it; refused otherwise; Stop ends it on both", async () => {
    const A = await make('ay');
    const B = await make('bee');
    await pair(A.c, B.c);
    const aId = A.c.state().self.deviceId;
    const bId = B.c.state().self.deviceId;
    await expect(A.c.streamStart(bId, 'sound')).rejects.toThrow(/tick this PC/);
    expect(A.c.state().streams).toEqual([]);
    await B.c.setSettings({ remoteFrom: [aId] });
    await A.c.streamStart(bId, 'sound');
    expect(A.c.state().streams).toEqual([expect.objectContaining({ kind: 'sound-out', peer: bId })]);
    await until(() => Buffer.concat(B.p.speaker).length >= 1920);
    expect(B.c.state().streams).toEqual([expect.objectContaining({ kind: 'sound', peer: aId })]);
    await A.c.streamStop(A.c.state().streams![0]!.id);
    expect(A.c.state().streams).toEqual([]);
    await until(() => (B.c.state().streams ?? []).length === 0);
  });

  it('M11: burn after reading, read receipts, print, smart inbox and send later', async () => {
    const A = await make('ay');
    const B = await make('bee', { sortInbox: true });
    await pair(A.c, B.c);
    const bId = B.c.state().self.deviceId;
    const dir = tmpDir();
    const photo = join(dir, 'photo.jpg');
    writeFileSync(photo, 'jpeg');
    await A.c.send([bId], [{ kind: 'file', path: photo }]);
    await until(() => B.c.state().received.length === 1);
    expect(B.c.state().received[0]!.files).toEqual([join(B.inbox, 'Images', 'photo.jpg')]);

    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'read once');
    await A.c.send([bId], [{ kind: 'file', path: secret }], { burn: true, print: true });
    await until(() => B.c.state().received.length === 2);
    const rec = B.c.state().received[0]!;
    expect(rec).toMatchObject({ burn: true });
    expect(rec.files[0]).toBe(join(B.inbox, 'secret.txt')); // burn files are not sorted
    expect(B.p.printed).toEqual([rec.files[0]]);
    await B.c.openFile(rec.files[0]!);
    await until(() => A.c.state().transfers.some((t) => t.openedAt !== undefined));
    await until(() => B.c.state().received[0]!.burned === true, 5000);
    expect(existsSync(rec.files[0]!)).toBe(false);

    const later = join(dir, 'later.txt');
    writeFileSync(later, 'from the past');
    await A.c.send([bId], [{ kind: 'file', path: later }], { at: Date.now() + 600 });
    expect(A.c.state().scheduled).toEqual([expect.objectContaining({ targets: [bId], names: ['later.txt'] })]);
    expect(B.c.state().received.length).toBe(2);
    await until(() => B.c.state().received.length === 3, 8000);
    expect(A.c.state().scheduled).toEqual([]);
  });

  it('M11: shake to grab answers only allowed devices; old received files are cleaned up', async () => {
    const A = await make('ay');
    const B = await make('bee');
    await pair(A.c, B.c);
    const aId = A.c.state().self.deviceId;
    const bId = B.c.state().self.deviceId;
    B.p.clipboardText = 'copied on the PC';
    expect(await A.c.appSend(bId, { kind: 'clipboard-get' })).toMatchObject({ status: 403 });
    await B.c.setSettings({ remoteFrom: [aId] });
    expect(await A.c.appSend(bId, { kind: 'clipboard-get' })).toEqual({ status: 200, body: { text: 'copied on the PC' } });

    const home = tmpDir();
    const inbox = join(home, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const old = join(inbox, 'old.txt');
    writeFileSync(old, 'x');
    writeFileSync(join(home, 'desktop-history.json'), JSON.stringify([{ at: Date.now() - 3 * 86_400_000, from: 'guest', alias: 'Guest', files: [old] }]));
    const C = await make('sea', { cleanupDays: 1 }, home);
    await until(() => C.c.state().received[0]?.cleaned === true, 5000);
    expect(existsSync(old)).toBe(false);
  });

  it('M12: a paired device has a watch party made on this PC; codes resolve to links', async () => {
    const A = await make('ay');
    const B = await make('bee');
    await pair(A.c, B.c);
    const bId = B.c.state().self.deviceId;
    const r = await A.c.appSend(bId, { kind: 'watch-create', name: 'Movie night' });
    expect(r.status).toBe(200);
    const body = r.body as { code: string; hostToken: string; links: string[] };
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(B.c.state().watch).toEqual([expect.objectContaining({ code: body.code, name: 'Movie night', hostToken: body.hostToken })]);
    expect(await B.c.watchResolve(body.code.toLowerCase())).toBe(body.links[0]); // the Wi-Fi link comes first
    expect(await B.c.watchResolve('ZZZZZZ')).toBeNull();
    await expect(B.c.watchResolve('nope')).rejects.toThrow(/6 letters/);
    await expect(B.c.watchOpen('https://evil.example/x')).rejects.toThrow(/watch-party link/);
    await A.c.appSend(bId, { kind: 'watch-end', code: body.code });
    expect(B.c.state().watch).toEqual([]);
    // a room made here has a QR code for every link: the internet one and this Wi-Fi's
    const mine = await B.c.watchCreate('Here');
    expect(mine.links.length).toBeGreaterThan(0);
    expect(mine.qrSvgs).toHaveLength(mine.links.length);
    for (const q of mine.qrSvgs) expect(q).toContain('<svg');
    await B.c.watchEnd(mine.code);
  });

  it('M13 handoff: a phone takes the browser page (fresh from the extension); a phone hands one over', async () => {
    const A = await make('phone');
    const B = await make('pc');
    await pair(A.c, B.c);
    const bId = B.c.state().self.deviceId;
    expect(await A.c.appSend(bId, { kind: 'handoff-get' })).toMatchObject({ status: 404 });
    B.c.handoffState({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Bunny', time: 10 });
    // the extension is waiting: the phone's question gets a fresh snapshot
    const cmd = B.c.handoffNextCommand(5000);
    const ask = A.c.appSend(bId, { kind: 'handoff-get' });
    expect(await cmd).toEqual({ type: 'snapshot' });
    B.c.handoffState({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Bunny', time: 95 });
    expect(await ask).toEqual({ status: 200, body: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=95s', title: 'Bunny' } });
    expect(B.c.state().handoff).toMatchObject({ extension: true, page: { title: 'Bunny' } });
    // phone -> PC: through the extension, at the same second
    const next = B.c.handoffNextCommand(5000);
    expect(await A.c.appSend(bId, { kind: 'handoff-open', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', time: 42 })).toMatchObject({ status: 200 });
    expect(await next).toMatchObject({ type: 'open', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=42s', time: 42 });
    expect(await A.c.appSend(bId, { kind: 'handoff-open', url: 'javascript:alert(1)' })).toMatchObject({ status: 400 });
  });
});
