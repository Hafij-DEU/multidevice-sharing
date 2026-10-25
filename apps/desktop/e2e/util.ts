import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAIN = fileURLToPath(new URL('../dist/main/main.cjs', import.meta.url));

/** Environment for a test instance: its own config home and inbox, hidden windows, ephemeral port. */
export function appEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    ...env,
    MESHDROP_HOME: join(home, 'config'),
    MESHDROP_INBOX: join(home, 'inbox'),
    MESHDROP_PORT: '0',
    MESHDROP_TEST: '1',
    // Ephemeral hub ingress and LAN guest ports: a real MeshDrop on this PC keeps the defaults.
    MESHDROP_INGRESS_PORT: '0',
    MESHDROP_GUEST_PORT: '0',
    // Remote input goes to a file, never to this desktop (the portal would ask on screen).
    MESHDROP_TEST_INPUT_LOG: join(home, 'input.log'),
    ...extra,
  };
}

/** The app opens on Home: switch to the Send page. */
export async function openSend(win: import('@playwright/test').Page): Promise<void> {
  const { expect } = await import('@playwright/test');
  await win.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(win.getByRole('heading', { name: 'Send to' })).toBeVisible();
}
