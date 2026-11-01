// The add-on, bundled to one CommonJS file that MeshDrop's main process requires.
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node24',
    minify: true,
    rollupOptions: {
      input: { index: 'src/index.ts' },
      output: { format: 'cjs', entryFileNames: '[name].cjs', exports: 'named' },
      external: builtins,
    },
  },
  ssr: { noExternal: true },
});
