import { MemnestError, createInMemoryAuthStore, createInMemoryJobQueue, createMemnest, scopeOf, type Job, type JobStatusEvent, type MemnestApi } from '@memnest/core';
import { createInMemoryStore, fixedClock, hashEmbedder, sequentialIds } from '@memnest/core/testing';
import { createServer, listen, type MemnestServer } from '@memnest/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MemnestHttpError, createMemnestClient, type MemnestClient } from '../src/index';

const FAST_ARGON2 = { algorithm: 2 as const, memoryCost: 1024, timeCost: 1, parallelism: 1 };
const USER = 'user:123';

function engine() {
  const clock = fixedClock('2026-03-01T09:00:00.000Z');
  return createMemnest({
    store: createInMemoryStore({ vector: true }),
    queue: createInMemoryJobQueue({ clock }),
    clock,
    ids: sequentialIds(),
    embedder: hashEmbedder(),
    profile: { builder: 'deterministic' },
  });
}

async function remote(options: { containerTag?: string } = {}): Promise<{ client: MemnestClient; server: MemnestServer; key: string }> {
  const server = createServer({ memnest: engine(), auth: createInMemoryAuthStore(), keyring: { argon2: FAST_ARGON2 } });
  const { key } = await server.keyring.issue({ name: 'client', ...options });
  const client = createMemnestClient({
    baseUrl: 'http://memnest.test/',
    apiKey: key,
    fetch: async (input, init) => server.app.request(input, init),
  });
  return { client, server, key };
}

/** The same sequence of calls, recorded. Errors are recorded by code and message. */
async function exercise(api: MemnestApi): Promise<unknown[]> {
  const scope = scopeOf(USER);
  const log: unknown[] = [];
  const record = async (label: string, fn: () => Promise<unknown>) => {
    try {
      log.push([label, await fn()]);
    } catch (error) {
      if (!(error instanceof MemnestError)) throw error;
      log.push([label, { error: error.code, message: error.message }]);
    }
  };

  const added = await api.add({ containerTag: USER, content: 'I prefer Postgres over MongoDB for the payments service.', extraction: 'none' });
  log.push(['add', added]);
  const [postgres] = await api.addMemories({
    containerTag: USER,
    memories: [{ content: 'The user prefers Postgres over MongoDB as the database for the payments service.', kind: 'preference' }],
  });
  const [mysql] = await api.addMemories({ containerTag: USER, memories: [{ content: 'The user moved the payments service database to MySQL.', supersedes: postgres!.id }] });
  const [team] = await api.addMemories({ containerTag: USER, memories: [{ content: 'The payments team has six engineers.', extendsIds: [mysql!.id] }] });
  log.push(['addMemories', postgres, mysql, team]);

  await record('getDocument', () => api.getDocument(scope, added.documentId));
  await record('getDocument missing', () => api.getDocument(scope, 'doc_missing'));
  await record('getMemory', () => api.getMemory(scope, mysql!.id));
  await record('getMemory missing', () => api.getMemory(scope, 'mem_missing'));
  await record('getLineage', () => api.getLineage(scope, mysql!.id));
  await record('getLineage missing', () => api.getLineage(scope, 'mem_missing'));
  await record('listMemories', () => api.listMemories(scope));
  await record('listMemories page', () => api.listMemories(scope, { limit: 1, after: postgres!.id }, { latestOnly: true, kind: 'fact' }));
  await record('forget', () => api.forget(scope, team!.id));
  await record('forget missing', () => api.forget(scope, 'mem_missing'));
  await record('graph', () => api.graph(scope, { includeForgotten: true, limit: 10 }));
  const strip = <T extends { trace?: { timings: unknown } }>(response: T) => ({ ...response, trace: { ...response.trace, timings: {} } });
  await record('search', async () => strip(await api.search('what database does this user use?', scope, { tokenBudget: 200 })));
  await record('searchMemories', () => api.searchMemories('payments database', scope, { tokenBudget: 50 }));
  await record('searchDocuments', () => api.searchDocuments('Postgres MongoDB', scope));
  await record('search invalid', () => api.search('x', scope, { tokenBudget: -1 }));
  await record('profile', () => api.profile(scope));
  await record('rebuildProfile', () => api.rebuildProfile(scope));
  await record('listExtractionRuns', () => api.listExtractionRuns(scope, { limit: 2 }));
  await record('addMemories invalid', () => api.addMemories({ containerTag: USER, memories: [] }));
  await record('add invalid tag', () => api.add({ containerTag: 'not a tag', content: 'x' }));
  await record('deleteDocument', () => api.deleteDocument(scope, added.documentId));
  await record('getDocument deleted', () => api.getDocument(scope, added.documentId));
  await record('deleteContainer', () => api.deleteContainer(scope));
  await record('listMemories after delete', () => api.listMemories(scope, { limit: 10 }, { includeForgotten: true }));
  return log;
}

describe('@memnest/client', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('returns exactly what the embedded engine returns (D2)', async () => {
    const embedded = engine();
    const { client } = await remote();
    const direct = await exercise(embedded);
    const overHttp = await exercise(client);
    expect(overHttp).toEqual(direct);
    // The sequence covered every error path it meant to.
    expect(JSON.stringify(direct)).toContain('"error":"not_found"');
    expect(JSON.stringify(direct)).toContain('"error":"validation"');
  });

  it('rebuilds server errors with their code and HTTP status', async () => {
    const { client, server } = await remote({ containerTag: USER });
    const error = await client.listMemories(scopeOf('user:other')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemnestHttpError);
    expect(error).toBeInstanceOf(MemnestError);
    expect(error).toMatchObject({ code: 'scope_violation', status: 403 });

    const anonymous = createMemnestClient({ baseUrl: 'http://memnest.test', fetch: async (input, init) => server.app.request(input, init) });
    await expect(anonymous.profile(scopeOf(USER))).rejects.toMatchObject({ code: 'unauthorized', status: 401 });

    const gateway = createMemnestClient({ baseUrl: 'http://memnest.test', fetch: async () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    await expect(gateway.profile(scopeOf(USER))).rejects.toMatchObject({ code: 'internal', status: 502, message: 'GET /v1/profile/user%3A123 failed with HTTP 502' });
  });

  it('logs in, reports the session, and logs out', async () => {
    const { client, server, key } = await remote({ containerTag: USER });
    expect(await client.session()).toMatchObject({ containerTag: USER, via: 'key' });

    // A browser has no key in its code: it logs in once and the cookie authenticates what follows.
    let cookie = '';
    const browser = createMemnestClient({
      baseUrl: 'http://memnest.test',
      fetch: async (input, init) => {
        const headers = new Headers(init.headers);
        if (cookie) headers.set('cookie', cookie);
        const response = await server.app.request(input, { ...init, headers });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0]!;
        return response;
      },
    });
    expect(await browser.login(key)).toMatchObject({ containerTag: USER, via: 'session', name: 'client' });
    expect(await browser.session()).toMatchObject({ via: 'session' });
    await browser.addMemories({ containerTag: USER, memories: [{ content: 'The user likes tea.' }] });
    await browser.logout();
    expect(cookie).toBe('memnest_session=');
    await expect(browser.session()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('streams job events over a real socket until aborted', async () => {
    const memnest = engine();
    const server = createServer({ memnest, auth: createInMemoryAuthStore(), keyring: { argon2: FAST_ARGON2 }, heartbeatMs: 20 });
    const { key } = await server.keyring.issue({ name: 'events', containerTag: USER });
    const http = await listen(server, { port: 0 });
    closers.push(() => http.close());
    const client = createMemnestClient({ baseUrl: http.url, apiKey: key });

    // Over real HTTP too, the client matches the engine.
    await client.addMemories({ containerTag: USER, memories: [{ content: 'The user likes tea.' }] });
    expect((await client.listMemories(scopeOf(USER))).map((m) => m.content)).toEqual(['The user likes tea.']);

    const controller = new AbortController();
    const received: JobStatusEvent[] = [];
    const job: Job = { id: 'job_1', type: 'extract', containerTag: USER, documentId: 'doc_1', mode: 'instant', runAt: '2026-03-01T09:00:00.000Z' };
    const consume = (async () => {
      for await (const event of client.events({ signal: controller.signal })) {
        received.push(event);
        if (received.length === 2) controller.abort();
      }
    })();
    while (server.events.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    server.events.publish({ type: 'started', job, attempt: 1 });
    server.events.publish({ type: 'started', job: { ...job, id: 'job_other', containerTag: 'user:other' }, attempt: 1 });
    server.events.publish({ type: 'succeeded', job, attempt: 1 });
    await consume;

    expect(received.map((e) => [e.type, e.jobId])).toEqual([
      ['started', 'job_1'],
      ['succeeded', 'job_1'],
    ]);
    const deadline = Date.now() + 1000;
    while (server.events.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.events.size).toBe(0);
  });

  it('close() ends open event streams', async () => {
    const memnest = engine();
    const server = createServer({ memnest, auth: createInMemoryAuthStore(), keyring: { argon2: FAST_ARGON2 }, heartbeatMs: 20 });
    const { key } = await server.keyring.issue({ name: 'events' });
    const http = await listen(server, { port: 0 });
    closers.push(() => http.close());
    const client = createMemnestClient({ baseUrl: http.url, apiKey: key });
    const consume = (async () => {
      for await (const _ of client.events()) {
        // No events are published.
      }
    })();
    while (server.events.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await client.close();
    await expect(consume).resolves.toBeUndefined();
  });
});
