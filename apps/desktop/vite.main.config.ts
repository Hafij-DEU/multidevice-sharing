// Electron main + preload, bundled to CommonJS (Electron loads plain JS; the core is TS source).
// Everything but electron and Node built-ins is inlined, so the package ships no node_modules.
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
      // ws's optional native helpers: required inside try/catch, absent is fine.
      external: ['electron', 'bufferutil', 'utf-8-validate', ...builtins],
    },
  },
  ssr: { noExternal: true },
});
