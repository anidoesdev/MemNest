/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const core = (path: string) => fileURLToPath(new URL(`../../packages/core/src/${path}`, import.meta.url));

// The preview bundles @memnest/core from source: the site deploys without building the rest of
// the monorepo, and always runs the engine as it is in this commit.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@memnest\/core\/testing$/, replacement: core('testing/index.ts') },
      { find: /^@memnest\/core$/, replacement: core('index.ts') },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { input: { main: 'index.html', guide: 'guide.html' } },
  },
});
