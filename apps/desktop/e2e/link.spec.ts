import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { appEnv, MAIN } from './util.ts';

test('an internet link opens in a browser, decrypts with the key from its fragment, and stops after removal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-link-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home, { MESHDROP_GUEST_PORT: '0' }) });
  try {
    const win = await app.firstWindow();
    await expect(win.getByText('Starting…')).toHaveCount(0);
    await win.evaluate(() => window.meshdrop.hubInit([]));
    const gift = join(home, 'gift for you.txt');
    writeFileSync(gift, 'hello over the internet');
    const l = await win.evaluate((f) => window.meshdrop.linkCreate({ files: [f], days: 1, allowUploads: false }), gift);
    await win.getByRole('button', { name: 'Guests' }).click();
    await expect(win.locator(`[data-link="${l.id}"]`)).toBeVisible();

    const opened = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, u) => void new BrowserWindow({ show: false }).loadURL(u), l.url);
    const page = await opened;
    await expect(page.getByText('gift for you.txt')).toBeVisible({ timeout: 15_000 });
    const text = await page.evaluate(async () => {
      // The page's own decrypt path, driven through its Download button, ends in a blob: URL.
      const made: string[] = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b: Blob) => {
        void b.text().then((t) => made.push(t));
        return orig.call(URL, b);
      };
      HTMLAnchorElement.prototype.click = function () {}; // no real download (it would end this test window)
      (document.querySelector('#list button') as HTMLButtonElement).click();
      for (let i = 0; i < 100 && made.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      return made[0];
    });
    expect(text).toBe('hello over the internet');

    const broken = l.url.replace(/#k=.*/, '#k=' + 'A'.repeat(43));
    await page.goto('about:blank');
    await page.goto(broken);
    await expect(page.getByText('its key is wrong')).toBeVisible();

    await win.locator(`[data-link="${l.id}"]`).getByRole('button', { name: 'Remove' }).click();
    await page.goto('about:blank');
    await page.goto(l.url);
    await expect(page.getByText('removed or never existed')).toBeVisible();
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
