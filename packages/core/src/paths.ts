import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * $MESHDROP_HOME, else $XDG_CONFIG_HOME/meshdrop, else ~/.config/meshdrop; on Windows
 * %LOCALAPPDATA%\MeshDrop (local, not roaming: a device's keys never follow the user to another PC).
 */
export function configDir(): string {
  const home = process.env.MESHDROP_HOME;
  if (home) return home;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'meshdrop');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'MeshDrop');
  return join(homedir(), '.config', 'meshdrop');
}
