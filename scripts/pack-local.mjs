#!/usr/bin/env node
// Builds tarballs of every publishable package, installs them into a throwaway
// consumer outside the workspace, and exercises every entry point via ESM, CJS,
// TypeScript (node16 + bundler resolution) and the `memnest` bin.
// Run before every release: `pnpm pack:local`.

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      // ui-react's peer dependency, and its types for the TypeScript check.
      dependencies: { ...specs, react: '^19.3.0', '@types/react': '^19.3.0' },
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
import { createServer, ROUTES } from '@memnest/server';
import { createMemnestClient, MemnestHttpError } from '@memnest/client';
import { createInMemoryAuthStore } from '@memnest/core';
import { computeLayout, createWorkspace, clusterNodes } from '@memnest/ui-core';
import { useController, GraphCanvas } from '@memnest/ui-react';
import { createMemnestMcpServer, PROFILE_RESOURCE_URI } from '@memnest/mcp';
import { serveMemnestStdio } from '@memnest/mcp/stdio';

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
{
  const server = createServer({ memnest: createMemnest({ store: createInMemoryStore() }), auth: createInMemoryAuthStore() });
  const { key } = await server.keyring.issue({ name: 'smoke', containerTag: 'user:123' });
  const client = createMemnestClient({ baseUrl: 'http://smoke.test', apiKey: key, fetch: async (input, init) => server.app.request(input, init) });
  await client.addMemories({ containerTag: 'user:123', memories: [{ content: 'The user prefers Postgres.' }] });
  const found = await client.searchMemories('Postgres', scope);
  if (found.length !== 1 || !ROUTES.search) throw new Error('ESM smoke: server + client round trip');
  const denied = await client.listMemories(scopeOf('user:other')).catch((e) => e);
  if (!(denied instanceof MemnestHttpError) || denied.code !== 'scope_violation') throw new Error('ESM smoke: scoped key');

  // ui-core over the same client, with its bundled (ESM-only) d3 layouts.
  const workspace = createWorkspace({ client, containerTag: 'user:123' });
  workspace.trace.setQuery('Postgres');
  await workspace.trace.run();
  if (workspace.trace.getState().rows.length !== 1) throw new Error('ESM smoke: ui-core trace');
  const positions = computeLayout([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b' }], { algorithm: 'force' });
  if (positions.size !== 2 || clusterNodes([], []).clusters.length !== 0) throw new Error('ESM smoke: ui-core layout');
  if (typeof useController !== 'function' || typeof GraphCanvas !== 'function') throw new Error('ESM smoke: ui-react exports');
  workspace.dispose();
}
if (typeof createPostgresStore !== 'function' || !PG_MIGRATIONS.length) throw new Error('ESM smoke: store-postgres exports');
const mcpServer = createMemnestMcpServer({ memnest: createMemnest({ store: createInMemoryStore() }), containerTag: 'user:1' });
if (typeof mcpServer.connect !== 'function' || PROFILE_RESOURCE_URI !== 'memnest://profile' || typeof serveMemnestStdio !== 'function') throw new Error('ESM smoke: mcp');
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
const { createServer, createKeyring } = require('@memnest/server');
const { createMemnestClient } = require('@memnest/client');
const { forceLayout, layeredLayout } = require('@memnest/ui-core');
const { useController } = require('@memnest/ui-react');
const { createMemnestMcpServer } = require('@memnest/mcp');
const { serveMemnestStdio } = require('@memnest/mcp/stdio');
if (typeof createMemnestMcpServer !== 'function' || typeof serveMemnestStdio !== 'function') throw new Error('CJS smoke: mcp');
if (forceLayout([{ id: 'a' }], []).size !== 1 || layeredLayout([{ id: 'a' }], []).size !== 1 || typeof useController !== 'function') throw new Error('CJS smoke: ui-core/ui-react');
if (typeof createServer !== 'function' || typeof createKeyring !== 'function' || typeof createMemnestClient !== 'function') throw new Error('CJS smoke: server/client');
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
import { createServer, type MemnestServer, type RouteId } from '@memnest/server';
import { createMemnestClient, type MemnestClient } from '@memnest/client';
import { createInMemoryAuthStore, type MemnestApi } from '@memnest/core';
import { createGraphController, type GraphState, type Workspace } from '@memnest/ui-core';
import { useController, type GraphCanvasProps } from '@memnest/ui-react';
import { createMemnestMcpServer, type MemnestMcpOptions } from '@memnest/mcp';
import { serveMemnestStdio, type MemnestStdioHandle, type ServeMemnestStdioOptions } from '@memnest/mcp/stdio';
const graphController = createGraphController({ client: createMemnest({ store: createInMemoryStore() }), containerTag: 'user:1', autoload: false });
const graphState: GraphState = graphController.getState();
type CanvasProps = GraphCanvasProps;
const hook: typeof useController<GraphState> = useController;
const server: MemnestServer = createServer({ memnest: createMemnest({ store: createInMemoryStore() }), auth: createInMemoryAuthStore() });
const route: RouteId = 'search';
const client: MemnestClient = createMemnestClient({ baseUrl: 'http://localhost:8787', apiKey: 'mnk_x' });
// D2: embedded and remote are interchangeable where the API is expected.
const apis: MemnestApi[] = [client, createMemnest({ store: createInMemoryStore() })];
const mcpOptions: MemnestMcpOptions = { memnest: client, containerTag: 'user:1', readOnly: true };
const mcpServer = createMemnestMcpServer(mcpOptions);
const serveStdio: (options: ServeMemnestStdioOptions) => MemnestStdioHandle = serveMemnestStdio;
const pgStore: Promise<PostgresStore> = createPostgresStore({ connectionString: 'postgres://localhost/none' });

const configured: ConfiguredProviders = { summary: [], completion: openAICompatibleCompletion({ model: 'm', baseURL: 'http://x' }) };
const store: SqliteStore = createSqliteStore({ autoMigrate: true });
const memnest: Memnest = createMemnest({ store });
const response: Promise<SearchResponse> = memnest.search('q', scopeOf('user:1'));
const memories: Promise<Memory[]> = memnest.listMemories(scopeOf('user:1'));
const pragma: unknown = store.db.pragma('journal_mode');
export { createInMemoryStore, mcpServer, serveStdio, run, response, memories, pragma, configured, pgStore, server, route, apis, graphState, hook };
export type { CanvasProps, Workspace };
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

copyFileSync(join(root, 'scripts', 'mcp-smoke.mjs'), join(consumer, 'mcp-smoke.mjs'));

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
sh('npm exec -- memnest keys create --name smoke --container user:smoke --db smoke.db', consumer);
sh('npm exec -- memnest keys list --db smoke.db', consumer);
sh('npm exec -- memnest eval --store sqlite', consumer);
// `memnest mcp` answers a client over stdio and exits when the client closes stdin.
sh('node mcp-smoke.mjs', consumer);

console.log('\npack:local passed: tarballs install and every entry point works outside the workspace.');
