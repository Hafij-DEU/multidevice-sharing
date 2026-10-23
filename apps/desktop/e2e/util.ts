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
    ...extra,
  };
}
