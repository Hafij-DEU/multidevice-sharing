import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { AppState } from '../src/shared/api.ts';
import { appEnv, MAIN, openSend } from './util.ts';

async function launch(home: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  const win = await app.firstWindow();
  await openSend(win);
  return { app, win };
}
const stateOf = (win: Page) => win.evaluate(() => window.meshdrop.getState()) as Promise<AppState>;

test('a device allowed on the PC types and clicks there from the Remote page', async () => {
  const homes = [mkdtempSync(join(tmpdir(), 'md-e2e-a-')), mkdtempSync(join(tmpdir(), 'md-e2e-b-'))];
  const A = await launch(homes[0]!);
  const B = await launch(homes[1]!);
  try {
    const a = await stateOf(A.win);
    const b = await stateOf(B.win);
    await A.win.evaluate(async ([p, id]) => window.meshdrop.addByAddress('127.0.0.1', p!, 'bee', id), [b.self.port, b.self.deviceId] as const);
    await B.win.evaluate(async ([p, id]) => window.meshdrop.addByAddress('127.0.0.1', p!, 'ay', id), [a.self.port, a.self.deviceId] as const);

    // B lets A control it
    await B.win.getByRole('button', { name: 'More', exact: true }).click();
    await B.win.getByRole('button', { name: /^Remote/ }).click();
    await expect(B.win.getByRole('heading', { name: 'Devices that may control this PC' })).toBeVisible();
    await B.win.locator('label.toggle', { hasText: 'ay' }).getByRole('checkbox').click();
    await expect.poll(async () => (await stateOf(B.win)).settings.remoteFrom).toEqual([a.self.deviceId]);

    // A types on B
    await A.win.getByRole('button', { name: 'More', exact: true }).click();
    await A.win.getByRole('button', { name: /^Remote/ }).click();
    await A.win.getByRole('tab', { name: 'Keyboard' }).click();
    await A.win.getByLabel('Type on the device').fill('hi');
    const log = join(homes[1]!, 'input.log');
    const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    await expect.poll(logged).toContain('"keysym":105');
    await A.win.getByRole('tab', { name: 'Touchpad' }).click();
    // a slow CI runner can re-lay out the page under the pointer: click until one lands
    await expect(async () => {
      if (!logged().includes('"button":272')) await A.win.getByRole('button', { name: 'Left click' }).click();
      expect(logged()).toContain('"button":272');
    }).toPass({ timeout: 20_000, intervals: [1000] });
    const keys = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { t: string; keysym?: number; down?: boolean }).filter((x) => x.t === 'key' && x.down).map((x) => x.keysym);
    expect(keys).toEqual([0x68, 0x69]);
    await A.win.screenshot({ path: join('test-results', 'remote-page.png') });
  } finally {
    await A.app.close();
    await B.app.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});
