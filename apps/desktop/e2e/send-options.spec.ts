import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { appEnv, MAIN, openSend } from './util.ts';

test('Send page has voice notes and the burn / print / send later options', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-o-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  try {
    const win = await app.firstWindow();
    await openSend(win);
    await expect(win.getByRole('button', { name: /Voice note/ })).toBeVisible();
    await win.getByRole('button', { name: /Options/ }).click();
    await expect(win.getByText('Burn after reading')).toBeVisible();
    await expect(win.getByText('Print on the PC')).toBeVisible();
    await expect(win.getByLabel('Send at')).toBeVisible();
    await win.screenshot({ path: join('test-results', 'send-options.png') });
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
