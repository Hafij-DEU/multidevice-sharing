import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { appEnv, MAIN } from './util.ts';

test('the app starts with its window and the Devices page', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  try {
    const win = await app.firstWindow();
    await expect(win).toHaveTitle('MeshDrop');
    await expect(win.getByRole('heading', { name: 'Send to' })).toBeVisible();
    for (const tab of ['Send', 'Received', 'More']) await expect(win.getByRole('navigation').getByRole('button', { name: tab, exact: true })).toBeVisible();
    await win.getByRole('button', { name: 'More', exact: true }).click();
    for (const page of ['Transfers', 'Mesh', 'Settings']) await expect(win.getByRole('button', { name: page })).toBeVisible();
    // Android's back button: a More page → More → Send → not handled (the app goes to the background).
    await win.getByRole('button', { name: /^Settings/ }).click();
    const back = () => win.evaluate(() => (window as unknown as { __mdBack: () => boolean }).__mdBack());
    expect(await back()).toBe(true);
    await expect(win.getByRole('button', { name: /^Settings/ })).toBeVisible();
    expect(await back()).toBe(true);
    await expect(win.getByRole('heading', { name: 'Send to' })).toBeVisible();
    expect(await back()).toBe(false);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
