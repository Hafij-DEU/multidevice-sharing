import { homedir } from 'node:os';
import { join } from 'node:path';

/** $MESHDROP_HOME, else $XDG_CONFIG_HOME/meshdrop, else ~/.config/meshdrop. */
export function configDir(): string {
  const home = process.env.MESHDROP_HOME;
  if (home) return home;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'meshdrop');
  return join(homedir(), '.config', 'meshdrop');
}
