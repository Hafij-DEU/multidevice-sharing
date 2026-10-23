// Electron main + preload, bundled to CommonJS (Electron loads plain JS; the core is TS source).
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist/main',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
      output: { format: 'cjs', entryFileNames: '[name].cjs' },
      external: ['electron', 'ws', 'qrcode', ...builtins],
    },
  },
  ssr: { noExternal: ['@meshdrop/core'] },
});
