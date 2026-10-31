import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, expect, test } from '@playwright/test';
import { appEnv, MAIN } from './util.ts';

// Linux clipboard reads go through a helper process (src/main/cliphelper.ts) so a slow selection owner
// cannot stall the main thread. It starts on the first read (none while the shared clipboard is off),
// stays up while reads answer, and goes away with the app.
test.skip(process.platform !== 'linux', 'Linux only');

/** Child processes of `pid`, forked from any of its threads. */
const children = (pid: number): number[] => {
  try {
    return readdirSync(`/proc/${pid}/task`).flatMap((t) => readFileSync(`/proc/${pid}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
  } catch {
    return [];
  }
};
/** The helper is the one child that is a whole Electron app (Chromium's own children carry --type=). */
const isHelper = (pid: number): boolean => {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.some((a) => a.endsWith('main.cjs')) && !argv.some((a) => a.startsWith('--type='));
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('clipboard reads run in a helper process that stays up and leaves with the app', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  try {
    const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
    const win = await app.firstWindow();
    await app.evaluate(({ clipboard }) => clipboard.writeText('meshdrop clipboard e2e'));
    const main = app.process().pid!;
    // Shared clipboard off (the default): nothing polls, so no helper (a whole Chromium) runs.
    await sleep(3000);
    expect(children(main).find(isHelper)).toBeUndefined();
    // Send clipboard starts one, and reads what is really there, then finds no device to send to
    const send = () => win.evaluate(() => window.meshdrop.sendClipboard('all').then(() => 'sent', (x: Error) => x.message));
    expect(await send()).toContain('No trusted device is online.');
    let helper = 0;
    await expect.poll(() => (helper = children(main).find(isHelper) ?? 0), { timeout: 5_000 }).toBeGreaterThan(0);
    // With the shared clipboard on it polls; a read that times out kills the helper: the same one
    // still running means the polls are answered.
    await win.evaluate(() => window.meshdrop.setSettings({ clipboardSync: true }));
    await sleep(4000);
    expect(children(main).find(isHelper)).toBe(helper);
    await app.evaluate(({ clipboard }) => clipboard.clear());
    expect(await send()).toContain('The clipboard is empty.');
    await app.evaluate(({ clipboard }) => clipboard.writeText('again'));
    expect(await send()).toContain('No trusted device is online.');
    expect(children(main).find(isHelper)).toBe(helper);
    await app.close();
    await expect.poll(() => alive(helper), { timeout: 10_000 }).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a clipboard owner that never answers: the main thread keeps running, and the app still quits at once', async () => {
  // The helper gets stuck in that read instead. Stuck, it cannot see its stdin close; left running, it
  // would also hold the fds it inherited from the app.
  const owner = spawn('python3', [fileURLToPath(new URL('./silent-owner.py', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  let helper = 0;
  let app: ElectronApplication | null = null;
  try {
    await new Promise((ok, fail) => {
      owner.stdout.once('data', ok);
      owner.once('exit', (code) => fail(new Error(`silent-owner exited ${code}`)));
    });
    app = await electron.launch({ args: [MAIN], env: appEnv(home) });
    const win = await app.firstWindow();
    await win.evaluate(() => window.meshdrop.setSettings({ clipboardSync: true })); // the polls read
    const main = app.process().pid!;
    // The main thread keeps answering while the clipboard polls hit the owner: a round trip every 200 ms
    // for 8 s (reads in this thread used to block it until the owner answered: here, never).
    let worst = 0;
    for (const end = Date.now() + 8000; Date.now() < end; ) {
      const t = Date.now();
      const answered = await Promise.race([app.evaluate(() => true), sleep(3000).then(() => false)]);
      worst = Math.max(worst, Date.now() - t);
      if (!answered) break;
      await sleep(200);
    }
    expect(worst, 'slowest main-thread round trip (ms)').toBeLessThan(1000);
    await expect.poll(() => (helper = children(main).find(isHelper) ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
    const t0 = Date.now();
    const closed = await Promise.race([app.close().then(() => true), sleep(15_000).then(() => false)]);
    expect(closed, 'app.close() returned').toBe(true);
    app = null;
    expect(Date.now() - t0).toBeLessThan(15_000);
    await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
  } finally {
    if (helper && alive(helper)) process.kill(helper, 'SIGKILL');
    app?.process().kill('SIGKILL');
    owner.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});
