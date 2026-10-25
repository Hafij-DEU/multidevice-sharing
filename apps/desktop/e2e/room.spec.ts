import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { AppState } from '../src/shared/api.ts';
import { appEnv, MAIN, openSend } from './util.ts';

test('room mode: open a room, a guest posts a photo, the PC saves it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'md-e2e-room-'));
  const app = await electron.launch({ args: [MAIN], env: appEnv(home) });
  try {
    const win = await app.firstWindow();
    await openSend(win);
    await win.getByRole('button', { name: 'More', exact: true }).click();
    await win.getByRole('button', { name: /^Guests/ }).click();
    await win.getByLabel('Room name').fill('Party');
    await win.getByRole('button', { name: 'Open a room' }).click();
    await expect(win.getByAltText('Room QR code')).toBeVisible();
    const st = (await win.evaluate(() => window.meshdrop.getState())) as AppState;
    const url = st.room!.url!.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${new URL(st.room!.url!).port}`);
    const api = url.replace('/r/', '/r/api/') + '/posts';
    const r = await fetch(`${api}?name=cake.jpg&by=Ann`, { method: 'POST', headers: { 'x-room': '1' }, body: 'jpeg' });
    expect(r.status).toBe(201);
    await expect(win.getByText('cake.jpg')).toBeVisible();
    await win.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => ((await win.evaluate(() => window.meshdrop.getState())) as AppState).received.length).toBe(0); // saved files are not "received" records
    await win.getByRole('button', { name: 'End room' }).click();
    await expect(win.getByRole('button', { name: 'Open a room' })).toBeVisible();
    expect((await fetch(api)).status).toBe(404);
    await win.screenshot({ path: join('test-results', 'room.png') }); // last: a hidden window stops painting after it
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
