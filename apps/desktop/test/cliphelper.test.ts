import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, clipboard: {} }));
const { ClipReader } = await import('../src/main/cliphelper.ts');

// Stands in for the Electron helper: same line protocol. Format 'hang' blocks it for good (a clipboard
// owner that does not reply), 'die' exits; the helper's pid is the answer to 'text'.
const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let stuck = false;
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (stuck || (req.op === 'buffer' && req.format === 'hang')) return void (stuck = true);
  if (req.op === 'buffer' && req.format === 'die') process.exit(3);
  const ok = req.op === 'text' ? String(process.pid) : req.op === 'buffer' ? Buffer.from(req.format).toString('base64') : req.op === 'image' ? 'k1' : req.key === 'k1' ? Buffer.from('PNG').toString('base64') : null;
  process.stdout.write('chromium says hi\\n' + JSON.stringify({ id: req.id, ok }) + '\\n');
});
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('clipboard reads in a helper process', () => {
  const dirs: string[] = [];
  const readers: InstanceType<typeof ClipReader>[] = [];
  afterEach(() => {
    for (const r of readers.splice(0)) r.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function reader(timeoutMs = 400, backoffMs = 300): InstanceType<typeof ClipReader> {
    const d = mkdtempSync(join(tmpdir(), 'md-clip-'));
    dirs.push(d);
    writeFileSync(join(d, 'fake.cjs'), FAKE);
    const r = new ClipReader({ exe: process.execPath, args: [join(d, 'fake.cjs')], profile: d }, timeoutMs, backoffMs);
    readers.push(r);
    return r;
  }

  it('answers reads through one long-lived helper', async () => {
    const r = reader();
    const pid = await r.text();
    expect(Number(pid)).toBe(r.pid);
    expect((await r.buffer('text/uri-list')).toString()).toBe('text/uri-list');
    expect(await r.image()).toBe('k1');
    expect((await r.png('k1')).toString()).toBe('PNG');
    await expect(r.png('other')).rejects.toThrow('changed');
    expect(await r.text()).toBe(pid); // same helper
  });

  it('a read the owner never answers: this thread keeps running, the read fails in time, the helper is killed', async () => {
    const r = reader(400);
    const pid = Number(await r.text());
    // timer lag on this (the "main") thread while the helper is stuck
    let worst = 0;
    let last = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last - 20);
      last = now;
    }, 20);
    const t0 = Date.now();
    const hung = r.buffer('hang');
    const other = r.text(); // queued behind the stuck read: fails with it, never hangs
    await expect(hung).rejects.toThrow('timed out after 400 ms');
    await expect(other).rejects.toThrow('timed out');
    const took = Date.now() - t0;
    clearInterval(tick);
    expect(took).toBeGreaterThanOrEqual(390);
    expect(took).toBeLessThan(1500);
    expect(worst).toBeLessThan(200);
    await sleep(100);
    expect(alive(pid)).toBe(false);
    expect(r.pid).toBeUndefined();
  });

  it('backs off after a stuck read, then starts a fresh helper', async () => {
    const r = reader(300, 500);
    const first = await r.text();
    await expect(r.buffer('hang')).rejects.toThrow('timed out');
    await expect(r.text()).rejects.toThrow('backing off'); // no respawn storm against a stuck owner
    await sleep(600);
    const second = await r.text();
    expect(second).not.toBe(first);
  });

  it('a helper that dies fails its reads at once, and the next read starts a new one', async () => {
    const r = reader(5000, 0);
    const first = await r.text();
    const t0 = Date.now();
    await expect(r.buffer('die')).rejects.toThrow('exited');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await r.text()).not.toBe(first);
  });

  it('a helper that exits backs off too, instead of a respawn every poll', async () => {
    const r = reader(5000, 500);
    await r.text();
    await expect(r.buffer('die')).rejects.toThrow('exited');
    await expect(r.text()).rejects.toThrow('backing off');
    await sleep(600);
    expect(Number(await r.text())).toBe(r.pid);
  });

  it('a helper that never answers after 3 starts is given up: unusable, so the caller reads in-process', async () => {
    const d = mkdtempSync(join(tmpdir(), 'md-clip-'));
    dirs.push(d);
    writeFileSync(join(d, 'bad.cjs'), 'process.exit(1)');
    const r = new ClipReader({ exe: process.execPath, args: [join(d, 'bad.cjs')], profile: d }, 2000, 0);
    readers.push(r);
    for (let i = 0; i < 3; i++) {
      expect(r.usable).toBe(true);
      await expect(r.text()).rejects.toThrow('exited');
    }
    expect(r.usable).toBe(false);
    await expect(r.text()).rejects.toThrow('unusable');
    // one that answered once stays usable through later deaths
    const ok = reader(5000, 0);
    await ok.text();
    for (let i = 0; i < 3; i++) await expect(ok.buffer('die')).rejects.toThrow('exited');
    expect(ok.usable).toBe(true);
  });

  it('the helper never touches the keyring: each start would otherwise D-Bus-activate the secret service', () => {
    const argv = process.argv;
    process.argv = ['/opt/MeshDrop/meshdrop', '--ozone-platform=x11', '--password-store=gnome-libsecret', '--other'];
    try {
      const { args } = ClipReader.self('/p');
      expect(args).toContain('--password-store=basic');
      expect(args).toContain('--ozone-platform=x11');
      expect(args).not.toContain('--password-store=gnome-libsecret');
      expect(args).not.toContain('--other');
    } finally {
      process.argv = argv;
    }
  });

  it('a helper that cannot start fails reads instead of hanging', async () => {
    const r = new ClipReader({ exe: '/nonexistent/meshdrop', args: [], profile: tmpdir() }, 2000, 0);
    readers.push(r);
    await expect(r.text()).rejects.toThrow(/could not start|exited/);
  });
});
