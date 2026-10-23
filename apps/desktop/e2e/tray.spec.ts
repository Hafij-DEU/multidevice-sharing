import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { AppState } from '../src/shared/api.ts';
import { appEnv, MAIN } from './util.ts';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const CLI = fileURLToPath(new URL('../../../packages/core/src/cli.ts', import.meta.url));

async function launch(home: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  const win = await app.firstWindow();
  await expect(win.getByText('Starting…')).toHaveCount(0);
  return { app, win };
}
const stateOf = (win: Page) => win.evaluate(() => window.meshdrop.getState()) as Promise<AppState>;
const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });

/** A `meshdrop listen` peer on its own home. */
async function cliPeer(home: string, port: number): Promise<ChildProcess> {
  const p = spawn(process.execPath, [CLI, 'listen', '--home', home, '--port', String(port), '--inbox', join(home, 'inbox'), '--no-discovery', '--alias', 'cli'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    p.stdout!.on('data', (d: Buffer) => {
      if (String(d).includes('listening on port')) resolve();
    });
    p.once('exit', (c) => reject(new Error(`listen exited ${c}`)));
  });
  return p;
}
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const freePort = () => 20000 + Math.floor(Math.random() * 20000);

test('a second launch with --send-clipboard opens the picker in the running app and exits 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  const A = await launch(home);
  try {
    const second = spawnSync(ELECTRON, [MAIN, '--send-clipboard'], { env: appEnv(home), timeout: 30_000 });
    expect(second.status).toBe(0);
    await expect.poll(async () => Promise.all(A.app.windows().map((w) => w.title())), { timeout: 10_000 }).toContain('Send clipboard');
  } finally {
    await A.app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('closed to the tray it keeps receiving; a send cut by Quit resumes after relaunch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  const cliHome = mkdtempSync(join(tmpdir(), 'md-e2e-cli-'));
  const cliPort = freePort();
  const peer = await cliPeer(cliHome, cliPort);
  let A = await launch(home);
  try {
    const a = await stateOf(A.win);
    await A.win.evaluate(([p]) => window.meshdrop.addByAddress('127.0.0.1', p!, 'cli'), [cliPort]);
    expect(cli(['pair', `127.0.0.1:${a.self.port}`, 'desk', '--home', cliHome]).status).toBe(0);
    const cliId = (await stateOf(A.win)).devices.find((d) => d.alias === 'cli')!.deviceId;

    // Close the window: with closeToTray (default) the app keeps running and receiving.
    await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()));
    const small = join(cliHome, 'from-cli.txt');
    writeFileSync(small, 'hello tray');
    const sent = cli(['send', a.self.deviceId.slice(0, 8), small, '--home', cliHome]);
    expect(sent.status, sent.stderr).toBe(0);
    await until(() => existsSync(join(home, 'inbox', 'from-cli.txt')), 15_000);
    expect(await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(0);

    // Quit mid-send: the send stays in the outbox and finishes on its own after a relaunch.
    const big = join(home, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 512 * 1024 * 1024);
    await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    const win = A.app.windows().find((w) => !w.url().includes('#picker')) ?? A.win;
    await win.evaluate(([id, p]) => window.meshdrop.send([id!], [{ kind: 'file', path: p! }]), [cliId, big]);
    await expect.poll(async () => (await stateOf(win)).transfers.find((t) => t.direction === 'out' && t.deviceId === cliId)?.sent ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
    const exited = new Promise((r) => A.app.process().once('exit', r));
    await A.app.evaluate(({ app }) => app.quit());
    await exited;
    expect(readdirSync(join(home, 'config', 'outbox')).filter((n) => n.endsWith('.json')).length).toBe(1);
    expect(existsSync(join(cliHome, 'inbox', 'big.bin'))).toBe(false);

    A = await launch(home);
    await until(() => existsSync(join(cliHome, 'inbox', 'big.bin')) && statSync(join(cliHome, 'inbox', 'big.bin')).size === 512 * 1024 * 1024, 90_000);
    await expect.poll(() => readdirSync(join(home, 'config', 'outbox')).filter((n) => n.endsWith('.json')).length, { timeout: 10_000 }).toBe(0);
  } finally {
    await A.app.close().catch(() => {});
    peer.kill('SIGINT');
    rmSync(home, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});
