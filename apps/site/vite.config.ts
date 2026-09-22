/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { buildDocs } from './scripts/build-docs.mjs';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const core = (path: string) => local(`../../packages/core/src/${path}`);

// The docs pages are generated from src/docs/*.html and the structure in scripts/pages.mjs,
// here rather than in a script, so `vite dev` and `vite build` always see the same set.
const docs = buildDocs();

// The preview bundles @memnest/core and @memnest/ui-core from source: the site deploys without
// building the rest of the monorepo, and always runs the engine as it is in this commit.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@memnest\/core\/testing$/, replacement: core('testing/index.ts') },
      { find: /^@memnest\/core$/, replacement: core('index.ts') },
      { find: /^@memnest\/ui-core$/, replacement: local('../../packages/ui-core/src/index.ts') },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: local('index.html'),
        plugins: local('plugins.html'),
        ...docs,
      },
    },
  },
});
