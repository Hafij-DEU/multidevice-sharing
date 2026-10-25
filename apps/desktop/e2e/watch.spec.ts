import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { AppState } from '../src/shared/api.ts';
import { appEnv, MAIN } from './util.ts';

test('watch party: start a room from Home, the player opens as host, a code joins it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-watch-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  try {
    const win = await app.firstWindow();
    await win.locator('[data-tile="watch"]').click();
    await win.getByLabel('Room name').fill('Movie night');
    const player = app.waitForEvent('window');
    await win.getByRole('button', { name: 'Start a room' }).click();
    const code = (await win.getByLabel('Room code', { exact: true }).innerText()).trim();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    const p = await player;
    await expect(p.locator('#status')).toContainText('You are the host');
    expect(p.url()).toMatch(new RegExp(`/w/${code}$`)); // the host key left the address bar
    await expect(p.locator('#roomname')).toHaveText('Movie night');
    // a viewer in the same room (another window) sees the host
    const st = (await win.evaluate(() => window.meshdrop.getState())) as AppState;
    expect(st.watch).toEqual([expect.objectContaining({ code, name: 'Movie night' })]);
    await win.getByLabel('Room code to join').fill(code.toLowerCase());
    const second = app.waitForEvent('window');
    await win.getByRole('button', { name: 'Join', exact: true }).click();
    const v = await second;
    await expect(v.locator('#members li')).toHaveCount(2);
    await win.getByRole('button', { name: 'End', exact: true }).click();
    await expect(v.getByText('The watch party has ended.')).toBeVisible();
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
