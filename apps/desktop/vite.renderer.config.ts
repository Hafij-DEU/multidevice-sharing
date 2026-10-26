// The UI: plain React in the browser context (no Node, no Electron): it only talks to window.meshdrop.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: 'src/renderer',
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome140', sourcemap: true },
});
