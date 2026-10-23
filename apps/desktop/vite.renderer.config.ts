// The UI: plain React in the browser context (no Node, no Electron): it only talks to window.meshdrop.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome140', sourcemap: true },
});
