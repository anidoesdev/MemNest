#!/usr/bin/env node
// End-to-end check of the dashboard in a real browser against `memnest serve`:
//   the Definition of Done story (graph → lineage → timeline → forget → trace), and
//   M8's acceptance criterion: usable at 10,000 memories.
// Needs `pnpm build` (packages and dashboard). Browser: PLAYWRIGHT_CHANNEL=chrome uses installed Chrome;
// otherwise Playwright's Chromium (`npx playwright install chromium`).
// Screenshots go to E2E_OUT (default apps/dashboard/e2e/out).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedMemories } from '@memnest/cli';
import { createMemnest } from '@memnest/core';
import { createSqliteStore } from '@memnest/store-sqlite';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const cli = join(root, 'packages/cli/dist/cli.js');
const dashboard = resolve(here, '../dist');
const out = resolve(process.env.E2E_OUT ?? join(here, 'out'));
mkdirSync(out, { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'memnest-e2e-'));
const db = join(work, 'memnest.db');
const results = {};
let server;
let browser;

const step = async (name, fn) => {
  const started = performance.now();
  process.stdout.write(`• ${name} … `);
  const value = await fn();
  const ms = Math.round(performance.now() - started);
  results[name] = ms;
  console.log(`ok (${ms}ms)`);
  return value;
};

const run = (args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--db', db], { cwd: work });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => (code === 0 ? resolvePromise(stdout) : reject(new Error(`memnest ${args.join(' ')} exited ${code}: ${stderr}`))));
  });

try {
  await step('migrate and seed', async () => {
    await run(['migrate']);
    const store = createSqliteStore({ filename: db });
    const memnest = createMemnest({ store });
    const tag = 'user:123';
    const [postgres] = await memnest.addMemories({
      containerTag: tag,
      memories: [{ content: 'The user prefers Postgres over MongoDB as the database for the payments service.', kind: 'preference', validFrom: '2026-03-01T09:00:00.000Z' }],
    });
    await memnest.addMemories({ containerTag: tag, memories: [{ content: 'The user dislikes every database ever made.', validFrom: '2026-03-02T09:00:00.000Z' }] });
    const [mysql] = await memnest.addMemories({
      containerTag: tag,
      memories: [{ content: 'The user moved the payments service database to MySQL.', supersedes: postgres.id, validFrom: '2026-03-08T09:00:00.000Z' }],
    });
    await memnest.addMemories({ containerTag: tag, memories: [{ content: 'The payments team runs MySQL with two replicas.', extendsIds: [mysql.id], kind: 'episode' }] });
    await seedMemories(memnest, { containerTag: 'fixture:10k', count: 10_000 });
    await memnest.close();
    results.mysqlId = mysql.id;
  });

  const key = await step('create a key', async () => JSON.parse(await run(['keys', 'create', '--name', 'e2e', '--json'])).key);

  const url = await step('start memnest serve with the dashboard', () =>
    new Promise((resolvePromise, reject) => {
      server = spawn(process.execPath, [cli, 'serve', '--db', db, '--port', '0', '--dashboard', dashboard], {
        cwd: work,
        env: { ...process.env, MEMNEST_COOKIE_SECURE: 'false', MEMNEST_WORKER: 'off' },
      });
      let log = '';
      server.stderr.on('data', (d) => {
        log += d;
        const match = /listening on (http:\/\/\S+)/.exec(log);
        if (match) resolvePromise(match[1]);
      });
      server.on('exit', (code) => reject(new Error(`server exited ${code}: ${log}`)));
    }),
  );

  const channel = process.env.PLAYWRIGHT_CHANNEL;
  browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });

  await step('sign in and open user:123', async () => {
    await page.goto(url);
    await page.getByLabel('API key').fill(key);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Container').fill('user:123');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('4 of 4 memories').waitFor();
  });
  // Before sign-in the app asks for the current session, and the browser logs that expected 401.
  // Everything after sign-in must be clean; CSP violations and page errors count from the start.
  problems.splice(0, problems.length, ...problems.filter((p) => !p.includes('status of 401')));
  await page.screenshot({ path: join(out, '1-graph.png') });

  await step('find the MySQL memory in the global graph and click it', async () => {
    await page.getByLabel('Filter the graph').fill(results.mysqlId);
    await page.getByText('1 of 4 memories').waitFor();
    await page.waitForFunction(() => !document.querySelector('.canvas-wrap.refreshing'));
    const canvas = page.getByRole('img', { name: 'Memory graph of user:123' });
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole('complementary', { name: 'Memory detail' }).locator('.detail-content', { hasText: 'The user moved the payments service database to MySQL.' }).waitFor();
  });

  await step('see its lineage: it supersedes the Postgres memory, drawn as a ghost', async () => {
    await page.getByRole('complementary', { name: 'Memory detail' }).getByRole('button', { name: 'Lineage', exact: true }).click();
    const lineage = page.getByRole('img', { name: 'Lineage graph' });
    await lineage.getByRole('button', { name: /^Preference: The user prefers Postgres.*\(Superseded\)$/ }).waitFor();
    // Drawn as a ghost, as in the graph: a faint body with a rim in its kind's colour.
    const ghost = await lineage.locator('.lineage-node.superseded .kind-fill').evaluate((el) => getComputedStyle(el).fillOpacity);
    assert.equal(ghost, '0.22');
  });
  await page.screenshot({ path: join(out, '2-lineage.png') });

  await step('the temporal view shows the switch with a date', async () => {
    await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
    await page.getByLabel('Topic').fill('payments database');
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await page.locator('.switch-date', { hasText: 'Mar 8, 2026' }).waitFor();
  });
  await page.screenshot({ path: join(out, '3-timeline.png') });

  await step('forget the wrong memory; the trace excludes it as forgotten', async () => {
    await page.getByLabel('Search memories').fill('dislikes');
    await page.getByRole('complementary', { name: 'Memories' }).getByText('The user dislikes every database ever made.').click();
    const detail = page.getByRole('complementary', { name: 'Memory detail' });
    await detail.getByRole('button', { name: 'Forget…', exact: true }).click();
    await page.screenshot({ path: join(out, '4-forget-confirm.png') });
    await detail.getByRole('button', { name: 'Forget memory', exact: true }).click();
    await detail.getByText(/It is no longer recalled/).waitFor();
    await page.getByRole('tab', { name: 'Retrieval trace', exact: true }).click();
    await page.getByLabel('Query').fill('what database does this user use?');
    await page.getByRole('spinbutton').fill('200');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const row = page.locator('tr', { hasText: 'The user dislikes every database ever made.' });
    await row.getByText('Forgotten').waitFor();
    await page.locator('tr', { hasText: 'prefers Postgres' }).getByText('Superseded').waitFor();
    await page.locator('tr', { hasText: 'moved the payments service database to MySQL' }).getByText('Included').waitFor();
  });
  await page.screenshot({ path: join(out, '5-trace.png') });

  // ---- M8: 10,000 memories ----
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByLabel('Container').fill('fixture:10k');
  await page.getByRole('tab', { name: 'Graph', exact: true }).click().catch(() => undefined);
  const opened = await step('open 10,000 memories: clustered and drawn', async () => {
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('tab', { name: 'Graph', exact: true }).click();
    await page.getByText(/of 10,000 memories · \d+ topics/).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector('.canvas-wrap.refreshing'), null, { timeout: 30_000 });
    return page.getByText(/of 10,000 memories/).textContent();
  });
  results.summary10k = opened;
  await page.screenshot({ path: join(out, '6-graph-10k-clusters.png') });

  // Long tasks block input; measure them across every interaction that follows.
  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => window.__longTasks.push(...list.getEntries().map((e) => Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
  });

  await step('hover finds a topic, clicking expands it', async () => {
    const canvas = page.getByRole('img', { name: 'Memory graph of fixture:10k' });
    const box = await canvas.boundingBox();
    let found = false;
    for (let y = 0.15; y < 0.9 && !found; y += 0.05) {
      for (let x = 0.1; x < 0.95 && !found; x += 0.04) {
        await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
        if (await page.getByRole('tooltip').getByText('Click to expand').isVisible().catch(() => false)) {
          await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
          found = true;
        }
      }
    }
    assert.ok(found, 'no expandable topic under the pointer');
    await page.waitForFunction(() => !document.querySelector('.canvas-wrap.refreshing') && !/laying out/.test(document.querySelector('.summary')?.textContent ?? ''), null, { timeout: 30_000 });
  });
  results.expanded = await page.locator('.summary').textContent();
  await page.screenshot({ path: join(out, '7-graph-10k-expanded.png') });

  await step('pan and zoom stay responsive', async () => {
    const canvas = page.getByRole('img', { name: 'Memory graph of fixture:10k' });
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const frames = await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = (now) => {
        window.__frames.push(now - last);
        last = now;
        if (window.__frames.length < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    });
    assert.ok(frames);
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, i % 2 ? 240 : -240);
    }
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 30; i++) await page.mouse.move(cx + i * 8, cy + i * 4);
    await page.mouse.up();
    const stats = await page.evaluate(() => {
      const f = window.__frames.slice(1).sort((a, b) => a - b);
      return { frames: f.length, p95: Math.round(f[Math.floor(f.length * 0.95)] ?? 0), longTasks: window.__longTasks };
    });
    results.frames = stats;
    assert.ok(stats.p95 < 100, `p95 frame ${stats.p95}ms`);
    assert.ok(stats.longTasks.every((d) => d < 250), `long tasks: ${stats.longTasks.join(', ')}`);
  });

  await step('filter to one kind at 10,000 memories', async () => {
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await page.getByRole('group', { name: 'Kinds' }).getByRole('button', { name: 'Episode', exact: true }).click();
    await page.getByRole('group', { name: 'Kinds' }).getByRole('button', { name: 'Preference', exact: true }).click();
    await page.getByText(/of 10,000 memories/).waitFor();
    await page.waitForFunction(() => !document.querySelector('.canvas-wrap.refreshing'), null, { timeout: 30_000 });
  });
  await page.screenshot({ path: join(out, '8-graph-10k-facts.png') });

  const longTasks = await page.evaluate(() => window.__longTasks);
  results.longTasks = longTasks;
  assert.deepEqual(problems, [], problems.join('\n'));
  console.log(`\ne2e passed. Screenshots in ${out}\n${JSON.stringify(results, null, 2)}`);
} catch (error) {
  console.error(`\ne2e FAILED: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(work, { recursive: true, force: true });
}
