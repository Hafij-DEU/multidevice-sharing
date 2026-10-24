import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { AppState } from '../src/shared/api.ts';
import { appEnv, MAIN } from './util.ts';

type G = typeof globalThis & { __meshdropTest: { setPicked(paths: string[]): void } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('a guest browser sends after the owner accepts, and downloads what the owner offers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-guest-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home, { MESHDROP_GUEST_PORT: '0' }) });
  try {
    const win = await app.firstWindow();
    await expect(win.getByText('Starting…')).toHaveCount(0);
    await win.getByRole('button', { name: 'More', exact: true }).click();
    await win.getByRole('button', { name: 'Guests' }).click();
    await win.getByRole('button', { name: 'Show a guest QR code' }).click();
    await expect(win.getByAltText('Guest QR code')).toBeVisible();
    const url = await win.getByLabel('Guest link').inputValue();
    expect(url).toMatch(/^http:\/\/[^/]+\/g\/[A-Za-z0-9_-]{22}$/);

    // The guest's browser: another Chromium window of the same Electron, on the guest URL.
    const opened = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, u) => {
      const w = new BrowserWindow({ show: false });
      void w.loadURL(u);
    }, url);
    const guest = await opened;
    await expect(guest.getByText('Sharing with')).toBeVisible();
    await expect(win.getByText('Opened by a guest')).toBeVisible({ timeout: 15_000 });

    const big = join(home, 'from-guest.bin');
    const data = randomBytes(9 * 1024 * 1024 + 7);
    writeFileSync(big, data);
    // The first slice upload dies mid-way (the phone lost Wi-Fi): the page must resume, not start over.
    let cut = false;
    await guest.route('**/g/api/offers/*/0?offset=*', async (route) => {
      if (!cut && route.request().method() === 'PUT') {
        cut = true;
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await guest.locator('#files').setInputFiles(big);
    await guest.locator('#text').fill('hello from the guest');
    await guest.getByRole('button', { name: 'Send' }).click();
    await expect(guest.getByText('Waiting for the owner to accept')).toBeVisible();

    const prompt = win.getByRole('dialog', { name: 'A guest wants to send' });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText('from-guest.bin')).toBeVisible();
    await expect(prompt.getByText('hello from the guest')).toBeVisible();
    await prompt.getByRole('button', { name: 'Accept' }).click();
    await expect(guest.getByText('Sent.')).toBeVisible({ timeout: 60_000 });
    expect(cut).toBe(true);
    expect(sha(readFileSync(join(home, 'inbox', 'from-guest.bin')))).toBe(sha(data));
    const st = (await win.evaluate(() => window.meshdrop.getState())) as AppState;
    expect(st.received.find((r) => r.from === 'guest')).toMatchObject({ text: 'hello from the guest' });

    const gift = join(home, 'gift.bin');
    const giftData = randomBytes(200_000);
    writeFileSync(gift, giftData);
    await app.evaluate((_e, p) => (globalThis as G).__meshdropTest.setPicked(p), [gift]);
    await win.getByRole('button', { name: 'Offer files…' }).click();
    await expect(win.locator('[data-shared="gift.bin"]')).toBeVisible();
    const link = guest.getByRole('link', { name: 'gift.bin' });
    await expect(link).toBeVisible({ timeout: 15_000 });
    const href = (await link.getAttribute('href'))!;
    const b64 = await guest.evaluate(async (h) => {
      const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, href);
    expect(sha(Buffer.from(b64, 'base64'))).toBe(sha(giftData));

    await win.getByRole('button', { name: 'End', exact: true }).click();
    await expect(win.getByRole('button', { name: 'Show a guest QR code' })).toBeVisible();
    await guest.reload();
    await expect(guest.getByText('link has expired')).toBeVisible();
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
