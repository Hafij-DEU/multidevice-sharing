import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { appEnv, MAIN } from './util.ts';

test('the app starts on Home; its tiles and tabs lead to every page', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  try {
    const win = await app.firstWindow();
    await expect(win).toHaveTitle('MeshDrop');
    for (const tile of ['send', 'received', 'remote', 'find', 'watch', 'devices', 'mesh', 'settings']) await expect(win.locator(`[data-tile="${tile}"]`)).toBeVisible();
    await win.locator('[data-tile="remote"]').click();
    await expect(win.getByRole('heading', { name: 'Remote' })).toBeVisible();
    // A page opened from Home goes back to Home, not to More.
    expect(await win.evaluate(() => (window as unknown as { __mdBack: () => boolean }).__mdBack())).toBe(true);
    await expect(win.locator('[data-tile="send"]')).toBeVisible();
    await win.locator('[data-tile="send"]').click();
    await expect(win.getByRole('heading', { name: 'Send to' })).toBeVisible();
    for (const tab of ['Home', 'Send', 'Received', 'More']) await expect(win.getByRole('navigation').getByRole('button', { name: tab, exact: true })).toBeVisible();
    await win.getByRole('button', { name: 'More', exact: true }).click();
    for (const page of ['Transfers', 'Mesh', 'Settings']) await expect(win.getByRole('button', { name: page })).toBeVisible();
    // Android's back button: a More page → More → Home → not handled (the app goes to the background).
    await win.getByRole('button', { name: /^Settings/ }).click();
    const back = () => win.evaluate(() => (window as unknown as { __mdBack: () => boolean }).__mdBack());
    expect(await back()).toBe(true);
    await expect(win.getByRole('button', { name: /^Settings/ })).toBeVisible();
    expect(await back()).toBe(true);
    await expect(win.locator('[data-tile="send"]')).toBeVisible();
    expect(await back()).toBe(false);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the desktop shows the Wi-Fi page: view-only, with the networks synced from the phones', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  try {
    const win = await app.firstWindow();
    await expect(win.getByText('Starting…')).toHaveCount(0);
    await win.getByRole('button', { name: 'More', exact: true }).click();
    await win.getByRole('button', { name: /^Wi-Fi/ }).click();
    await expect(win.getByRole('heading', { name: 'Saved networks' })).toBeVisible();
    await expect(win.getByText(/Add them on your phone, then use Sync now/)).toBeVisible();
    await expect(win.getByRole('button', { name: 'Add a network' })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
