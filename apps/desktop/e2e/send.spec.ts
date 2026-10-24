import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { AppState, ReceivedRecord } from '../src/shared/api.ts';
import { appEnv, MAIN } from './util.ts';

interface TestHooks {
  setPicked(paths: string[]): void;
  seedHistory(r: ReceivedRecord): void;
}
type G = typeof globalThis & { __meshdropTest: TestHooks };

async function launch(home: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  const win = await app.firstWindow();
  await expect(win.getByRole('heading', { name: 'Devices' })).toBeVisible();
  await expect(win.getByText('Starting…')).toHaveCount(0);
  return { app, win };
}
const stateOf = (win: Page) => win.evaluate(() => window.meshdrop.getState()) as Promise<AppState>;

test('a nearby device pairs with one click on its card', async () => {
  const homes = [mkdtempSync(join(tmpdir(), 'md-e2e-a-')), mkdtempSync(join(tmpdir(), 'md-e2e-b-'))];
  const A = await launch(homes[0]!);
  const B = await launch(homes[1]!);
  try {
    const b = await stateOf(B.win);
    // A finds B (as discovery or Scan network would): B is "Nearby" with its address.
    await A.app.evaluate(async (_e, port) => (globalThis as unknown as { __meshdropTest: { addNearby(h: string, p: number): Promise<void> } }).__meshdropTest.addNearby('127.0.0.1', port), b.self.port);
    const card = A.win.locator(`.device-card[data-device="${b.self.deviceId}"]`);
    await expect(card.getByRole('button', { name: 'Pair' })).toBeVisible();
    await card.getByRole('button', { name: 'Pair' }).click();
    await expect(A.win.getByText(/Paired with/)).toBeVisible();
    await expect(card.getByRole('checkbox')).toBeVisible();
  } finally {
    await A.app.close();
    await B.app.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});

test('pair two apps by address, send a file, see it in the other inbox', async () => {
  const homes = [mkdtempSync(join(tmpdir(), 'md-e2e-a-')), mkdtempSync(join(tmpdir(), 'md-e2e-b-'))];
  const A = await launch(homes[0]!);
  const B = await launch(homes[1]!);
  try {
    const a = await stateOf(A.win);
    const b = await stateOf(B.win);
    const evil = '<b>x</b>‮';

    await A.win.getByLabel('Address').fill(`127.0.0.1:${b.self.port}`);
    await A.win.getByLabel('Name').fill(evil);
    await A.win.getByRole('button', { name: 'Add by address' }).click();
    await B.win.getByLabel('Address').fill(`127.0.0.1:${a.self.port}`);
    await B.win.getByLabel('Name').fill('ay');
    await B.win.getByRole('button', { name: 'Add by address' }).click();

    const card = A.win.locator(`.device-card[data-device="${b.self.deviceId}"]`);
    await expect(card).toBeVisible();
    expect(await card.innerText()).toContain('<b>x</b>');
    expect(await A.win.locator('.device-card b').count()).toBe(0);
    await expect(B.win.locator(`.device-card[data-device="${a.self.deviceId}"]`)).toBeVisible();

    const file = join(homes[0]!, 'big.bin');
    writeFileSync(file, randomBytes(3 * 1024 * 1024));
    await A.app.evaluate((_e, p) => (globalThis as G).__meshdropTest.setPicked(p), [file]);
    await card.getByRole('checkbox').check();
    await A.win.getByRole('button', { name: 'Add files' }).click();
    await expect(A.win.getByText('big.bin')).toBeVisible();
    await A.win.getByRole('button', { name: 'Send', exact: true }).click();

    await A.win.getByRole('button', { name: 'Transfers' }).click();
    await expect(A.win.locator('.progress-row .status', { hasText: 'Done' })).toBeVisible({ timeout: 30_000 });
    await B.win.getByRole('button', { name: 'Inbox' }).click();
    await expect(B.win.getByText('big.bin')).toBeVisible({ timeout: 30_000 });

    const files = Array.from({ length: 2000 }, (_, i) => join(homes[1]!, 'inbox', `seed-${i}.txt`));
    await B.app.evaluate((_e, r) => (globalThis as G).__meshdropTest.seedHistory(r), { at: Date.now(), from: 'ab'.repeat(32), alias: 'seed', files });
    await expect(B.win.getByText('and 1995 more')).toBeVisible();
    expect(await B.win.locator('.record').first().locator('.files > li').count()).toBe(6);
  } finally {
    await A.app.close();
    await B.app.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});
