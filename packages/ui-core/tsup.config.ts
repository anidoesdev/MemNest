import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'layout-worker': 'src/layout-worker.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // d3-force and d3-quadtree are ESM-only: bundling them keeps the CommonJS build working everywhere.
  noExternal: [/^d3-/],
});
