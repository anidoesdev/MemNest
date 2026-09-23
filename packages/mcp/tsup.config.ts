import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', stdio: 'src/stdio.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // The graph app is private and built alongside: its HTML ships inside this package.
  noExternal: ['@memnest/mcp-app'],
});
