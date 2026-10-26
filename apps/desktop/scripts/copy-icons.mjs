// Copies the window and tray icons next to the built main process (dist/icons), on any OS.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist/icons'), { recursive: true });
for (const f of ['icon.png', 'tray.png']) copyFileSync(join(root, 'build', f), join(root, 'dist/icons', f));
