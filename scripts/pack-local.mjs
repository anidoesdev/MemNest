#!/usr/bin/env node
// Builds tarballs of every publishable package, installs them into a throwaway
// consumer outside the workspace, and exercises every entry point via ESM, CJS,
// TypeScript (node16 + bundler resolution) and the `memnest` bin.
// Run before every release: `pnpm pack:local`.

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = join(root, '.pack-local');
const tarballs = join(work, 'tarballs');
const consumer = join(work, 'consumer');
const skipBuild = process.argv.includes('--skip-build');

const sh = (cmd, cwd = root) => {
  console.log(`\n$ ${cmd}${cwd === root ? '' : `   (in ${cwd})`}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

rmSync(work, { recursive: true, force: true });
mkdirSync(tarballs, { recursive: true });
mkdirSync(consumer, { recursive: true });

if (!skipBuild) sh('pnpm build');

const packages = readdirSync(join(root, 'packages'))
  .map((dir) => ({ dir: join(root, 'packages', dir), pkg: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => !pkg.private);

const specs = {};
for (const { dir, pkg } of packages) {
  sh(`pnpm pack --pack-destination "${tarballs}"`, dir);
  const file = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
  specs[pkg.name] = `file:../tarballs/${file}`;
}

writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify(
    {
      name: 'memnest-pack-local-consumer',
      private: true,
      dependencies: specs,
      // Internal dependencies must resolve to the local tarballs, not the registry.
      overrides: Object.fromEntries(Object.keys(specs).map((name) => [name, `$${name}`])),
    },
    null,
    2,
  ),
);

writeFileSync(
  join(consumer, 'smoke.mjs'),
  `import { createMemnest, scopeOf } from '@memnest/core';
import { createInMemoryStore, fixedClock } from '@memnest/core/testing';
import { createSqliteStore } from '@memnest/store-sqlite';
import { run } from '@memnest/cli';
import { EVAL_CASES, runEvals } from '@memnest/evals';
import { createPostgresStore, PG_MIGRATIONS } from '@memnest/store-postgres';
import { ollamaCompletion, openAICompatibleEmbeddings, providersFromEnv } from '@memnest/providers';

if (ollamaCompletion({ model: 'm' }).id !== 'ollama:m' || openAICompatibleEmbeddings({ baseURL: 'http://x', model: 'e', dimensions: 3 }).dimensions !== 3) throw new Error('ESM smoke: providers');
if (providersFromEnv({}).completion) throw new Error('ESM smoke: providersFromEnv');
const scope = scopeOf('user:123');
for (const store of [createInMemoryStore(), createSqliteStore({ autoMigrate: true })]) {
  const memnest = createMemnest({ store, clock: fixedClock() });
  const [pg] = await memnest.addMemories({ containerTag: 'user:123', memories: [{ content: 'The user prefers Postgres for the payments database.' }] });
  const [my] = await memnest.addMemories({ containerTag: 'user:123', memories: [{ content: 'The user moved the payments database to MySQL.', supersedes: pg.id }] });
  const { memories, trace } = await memnest.search('what database does this user use?', scope, { tokenBudget: 200 });
  if (memories.length !== 1 || memories[0].memory.id !== my.id) throw new Error('ESM smoke: wrong recall');
  if (!trace.candidates.some((c) => c.memoryId === pg.id && c.excludedReason === 'not-latest')) throw new Error('ESM smoke: bad trace');
  await memnest.close();
}
if (typeof run !== 'function') throw new Error('ESM smoke: cli export missing');
if (typeof createPostgresStore !== 'function' || !PG_MIGRATIONS.length) throw new Error('ESM smoke: store-postgres exports');
const evalReport = await runEvals({ mode: 'mock', filter: 'real-transcript' });
if (evalReport.passed !== 1 || !EVAL_CASES.length) throw new Error('ESM smoke: evals');
console.log('ESM smoke ok');
`,
);

writeFileSync(
  join(consumer, 'smoke.cjs'),
  `const { createMemnest, scopeOf } = require('@memnest/core');
const { createInMemoryStore } = require('@memnest/core/testing');
const { createSqliteStore, MIGRATIONS } = require('@memnest/store-sqlite');
const { run } = require('@memnest/cli');
const { ollamaEmbeddings } = require('@memnest/providers');
const { createPostgresStore } = require('@memnest/store-postgres');
if (typeof createPostgresStore !== 'function') throw new Error('CJS smoke: store-postgres');
if (ollamaEmbeddings({ model: 'nomic-embed-text' }).dimensions !== 768) throw new Error('CJS smoke: providers');
(async () => {
  const store = createSqliteStore({ autoMigrate: true });
  const memnest = createMemnest({ store });
  await memnest.add({ containerTag: 'user:1', content: 'CommonJS consumers can recall this sentence.', extraction: 'none' });
  const chunks = await memnest.searchDocuments('CommonJS recall', scopeOf('user:1'));
  if (chunks.length !== 1) throw new Error('CJS smoke: no chunks');
  if (!createInMemoryStore || !MIGRATIONS.length || typeof run !== 'function') throw new Error('CJS smoke: missing exports');
  await memnest.close();
  console.log('CJS smoke ok');
})().catch((e) => { console.error(e); process.exit(1); });
`,
);

writeFileSync(
  join(consumer, 'smoke.ts'),
  `import { createMemnest, scopeOf, type Memory, type Memnest, type SearchResponse } from '@memnest/core';
import { createInMemoryStore } from '@memnest/core/testing';
import { createSqliteStore, type SqliteStore } from '@memnest/store-sqlite';
import { run } from '@memnest/cli';
import { openAICompatibleCompletion, type ConfiguredProviders } from '@memnest/providers';
import { createPostgresStore, type PostgresStore } from '@memnest/store-postgres';
const pgStore: Promise<PostgresStore> = createPostgresStore({ connectionString: 'postgres://localhost/none' });

const configured: ConfiguredProviders = { summary: [], completion: openAICompatibleCompletion({ model: 'm', baseURL: 'http://x' }) };
const store: SqliteStore = createSqliteStore({ autoMigrate: true });
const memnest: Memnest = createMemnest({ store });
const response: Promise<SearchResponse> = memnest.search('q', scopeOf('user:1'));
const memories: Promise<Memory[]> = memnest.listMemories(scopeOf('user:1'));
const pragma: unknown = store.db.pragma('journal_mode');
export { createInMemoryStore, run, response, memories, pragma, configured, pgStore };
`,
);

const tsc = `node "${join(root, 'node_modules', 'typescript', 'bin', 'tsc')}"`;
const tsconfig = (resolution) =>
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      module: resolution === 'node16' ? 'Node16' : 'ESNext',
      moduleResolution: resolution === 'node16' ? 'Node16' : 'Bundler',
      types: [],
    },
    files: ['smoke.ts'],
  });

sh('npm install --no-audit --no-fund', consumer);
sh('node smoke.mjs', consumer);
sh('node smoke.cjs', consumer);
for (const resolution of ['node16', 'bundler']) {
  writeFileSync(join(consumer, `tsconfig.${resolution}.json`), tsconfig(resolution));
  sh(`${tsc} -p tsconfig.${resolution}.json`, consumer);
}
sh('npm exec -- memnest migrate --db smoke.db', consumer);
sh('npm exec -- memnest seed --container user:smoke --count 50 --db smoke.db', consumer);
sh('npm exec -- memnest search "Stripe Postgres" --container user:smoke --budget 120 --db smoke.db', consumer);
sh('npm exec -- memnest eval --store sqlite', consumer);

console.log('\npack:local passed: tarballs install and every entry point works outside the workspace.');
