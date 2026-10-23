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
    await expect(win.getByRole('heading', { name: 'Devices' })).toBeVisible();
    for (const page of ['Transfers', 'Inbox', 'Mesh', 'Settings']) await expect(win.getByRole('button', { name: page })).toBeVisible();
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
