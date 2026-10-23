// The core command line as one self-contained CommonJS file (resources/cli.cjs in the .deb), run
// by the bundled Electron with ELECTRON_RUN_AS_NODE=1. Everything but Node built-ins is inlined.
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist/cli',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: {
      input: { cli: '../../packages/core/src/cli.ts' },
      output: { format: 'cjs', entryFileNames: '[name].cjs' },
      // ws's optional native helpers: required inside try/catch, absent is fine.
      external: ['bufferutil', 'utf-8-validate', ...builtins],
    },
  },
  ssr: { noExternal: true },
});
