import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
  },
  {
    // The bin: ESM only, shebang preserved from the source.
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'es2022',
  },
]);
