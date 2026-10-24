import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appEnv, MAIN } from './util.ts';

async function launch(home: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(home, extra) });
  const win = await app.firstWindow();
  await expect(win.getByText('Starting…')).toHaveCount(0);
  await win.getByRole('button', { name: 'More', exact: true }).click();
  await win.getByRole('button', { name: 'Mesh' }).click();
  return { app, win };
}

test('create a mesh, invite by QR, join, revoke', async () => {
  const homes = [mkdtempSync(join(tmpdir(), 'md-e2e-a-')), mkdtempSync(join(tmpdir(), 'md-e2e-b-'))];
  const A = await launch(homes[0]!);
  const B = await launch(homes[1]!);
  try {
    await expect(A.win.getByText('Not in a mesh')).toBeVisible();
    await A.win.getByRole('button', { name: 'Create a mesh on this PC (make it the hub)' }).click();
    await A.win.getByRole('button', { name: 'Invite a device' }).click();
    const qr = A.win.getByRole('img', { name: 'Invite QR code' });
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    const uri = await A.win.getByLabel('Invite link').inputValue();
    expect(uri).toMatch(/^meshdrop:\/\/join\?/);

    await B.win.getByLabel('Invite to join').fill(uri);
    await B.win.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(A.win.locator('.member')).toHaveCount(2, { timeout: 10_000 });
    await expect(B.win.locator('.member')).toHaveCount(2, { timeout: 10_000 });

    const bId = (await B.win.evaluate(() => window.meshdrop.getState())).self.deviceId;
    await A.win.locator(`.member[data-device="${bId}"]`).getByRole('button', { name: 'Revoke' }).click();
    const dialog = A.win.getByRole('dialog');
    await expect(dialog).toContainText(bId.slice(0, 8));
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(B.win.getByText('Not in a mesh')).toBeVisible({ timeout: 10_000 });
    await expect(A.win.locator('.member')).toHaveCount(1);
  } finally {
    await A.app.close();
    await B.app.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});

test('an expired invite greys out and offers a new one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-'));
  const A = await launch(home, { MESHDROP_TEST_INVITE_TTL_MS: '500' });
  try {
    await A.win.getByRole('button', { name: 'Create a mesh on this PC (make it the hub)' }).click();
    await A.win.getByRole('button', { name: 'Invite a device' }).click();
    await expect(A.win.getByText('0:00')).toBeVisible({ timeout: 5_000 });
    await expect(A.win.getByRole('button', { name: 'New invite' })).toBeVisible();
    await expect(A.win.locator('.qr.expired')).toBeVisible();
  } finally {
    await A.app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('one QR on the Send page adds several devices (this PC becomes the hub)', async () => {
  const homes = [0, 1, 2].map((k) => mkdtempSync(join(tmpdir(), `md-e2e-g${k}-`)));
  const apps = await Promise.all(homes.map(async (h) => {
    const app = await electron.launch({ args: [MAIN], env: appEnv(h) });
    const win = await app.firstWindow();
    await expect(win.getByText('Starting…')).toHaveCount(0);
    return { app, win };
  }));
  const [A, B, C] = apps as [(typeof apps)[0], (typeof apps)[0], (typeof apps)[0]];
  try {
    await A.win.getByRole('button', { name: 'Show one QR for all my devices' }).click();
    await expect(A.win.getByRole('img', { name: 'Invite QR code' })).toBeVisible();
    const uri = await A.win.getByLabel('Invite link').inputValue();
    for (const d of [B, C]) expect(await d.win.evaluate((u) => window.meshdrop.join(u), uri)).toBe('member');
    await expect.poll(() => A.win.evaluate(() => window.meshdrop.getState().then((s) => s.members.length)), { timeout: 15_000 }).toBe(3);
  } finally {
    for (const a of apps) await a.app.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});
