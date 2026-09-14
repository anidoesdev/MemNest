import { scopeOf, type Job } from '@memnest/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, type RouteId } from '../src/index';
import { STORE_KINDS, createHarness, errorOf, readEvents, type Harness } from './harness';

const ALPHA = 'team:alpha';
const BRAVO = 'team:bravo';
const enc = encodeURIComponent;

interface Seeded {
  documentId: string;
  memoryId: string;
  supersededId: string;
  forgottenId: string;
  /** Every id in the container: memories, sources, runs, documents, chunks. */
  ids: string[];
}

/** Populates both containers with the same shapes, each marked with its uppercase marker. */
async function populate(h: Harness): Promise<{ a: Seeded; b: Seeded }> {
  const seeded: Record<string, Seeded> = {};
  for (const [tag, marker] of [
    [ALPHA, 'ALPHA'],
    [BRAVO, 'BRAVO'],
  ] as const) {
    const scope = scopeOf(tag);
    const { documentId } = await h.memnest.add({
      containerTag: tag,
      customId: 'shared-custom-id',
      extraction: 'none',
      content: [
        { role: 'user', content: `${marker} I am building a payments service on Postgres.` },
        { role: 'assistant', content: `${marker} Noted, payments on Postgres.` },
      ],
    });
    const [postgres] = await h.memnest.addMemories({
      containerTag: tag,
      memories: [{ content: `${marker} The user prefers Postgres for the payments service.`, kind: 'preference' }],
    });
    const [mysql] = await h.memnest.addMemories({
      containerTag: tag,
      memories: [{ content: `${marker} The user moved the payments service to MySQL.`, supersedes: postgres!.id }],
    });
    const [extra] = await h.memnest.addMemories({
      containerTag: tag,
      memories: [{ content: `${marker} The payments team has six engineers.`, extendsIds: [mysql!.id] }],
    });
    await h.memnest.forget(scope, extra!.id);
    await h.memnest.rebuildProfile(scope);
    const memories = await h.memnest.listMemories(scope, { limit: 1000 }, { includeForgotten: true });
    const chunks = (await h.memnest.getDocument(scope, documentId))!.chunks;
    seeded[marker] = {
      documentId,
      memoryId: mysql!.id,
      supersededId: postgres!.id,
      forgottenId: extra!.id,
      ids: [...memories.flatMap((m) => [m.id, ...m.sourceDocumentIds, m.extractionRunId]), documentId, ...chunks.map((c) => c.id)],
    };
  }
  return { a: seeded.ALPHA!, b: seeded.BRAVO! };
}

async function bravoState(h: Harness): Promise<string> {
  const scope = scopeOf(BRAVO);
  return JSON.stringify({
    memories: await h.memnest.listMemories(scope, { limit: 1000 }, { includeForgotten: true }),
    documents: await h.store.findDocuments(scope, {}),
    profile: await h.store.getProfile(scope),
    graph: await h.memnest.graph(scope, { includeForgotten: true }),
    runs: await h.memnest.listExtractionRuns(scope, { limit: 1000 }),
  });
}

type Send = (method: string, path: string, json?: unknown) => Promise<Response>;

const bravoJob = (documentId: string): Job => ({
  id: 'job_bravo',
  type: 'extract',
  containerTag: BRAVO,
  documentId,
  mode: 'instant',
  runAt: '2026-03-01T09:00:00.000Z',
});

// Keyed by every route: adding a route to the table without a probe here fails typecheck.
const probes: { [K in RouteId]: (send: Send, f: { a: Seeded; b: Seeded }, h: Harness, alphaKey: string) => Promise<Response[]> } = {
  health: async (send) => [await send('GET', '/healthz')],
  createSession: async (send, _f, _h, alphaKey) => [await send('POST', '/v1/session', { apiKey: alphaKey })],
  getSession: async (send) => [await send('GET', '/v1/session')],
  deleteSession: async (send) => [await send('DELETE', '/v1/session')],

  addDocument: async (send) => [
    await send('POST', '/v1/documents', { containerTag: BRAVO, content: 'Written into the other container?' }),
    // The other container's exact customId and content: a dedupe that crossed containers would return its document id.
    await send('POST', '/v1/documents', {
      customId: 'shared-custom-id',
      extraction: 'none',
      content: [
        { role: 'user', content: 'BRAVO I am building a payments service on Postgres.' },
        { role: 'assistant', content: 'BRAVO Noted, payments on Postgres.' },
      ],
    }),
  ],
  getDocument: async (send, f) => [
    await send('GET', `/v1/documents/${f.b.documentId}`),
    await send('GET', `/v1/documents/${f.b.documentId}?containerTag=${enc(BRAVO)}`),
  ],
  deleteDocument: async (send, f) => [
    await send('DELETE', `/v1/documents/${f.b.documentId}`),
    await send('DELETE', `/v1/documents/${f.b.documentId}?containerTag=${enc(BRAVO)}`),
  ],

  search: async (send) => [
    await send('POST', '/v1/search', { query: 'payments Postgres MySQL engineers', options: { tokenBudget: 100_000 } }),
    await send('POST', '/v1/search', { query: 'payments', include: ['memories'] }),
    await send('POST', '/v1/search', { query: 'payments', include: ['chunks'] }),
    await send('POST', '/v1/search', { containerTag: BRAVO, query: 'payments' }),
  ],
  profile: async (send) => [await send('GET', `/v1/profile/${enc(ALPHA)}`), await send('GET', `/v1/profile/${enc(BRAVO)}`)],
  rebuildProfile: async (send) => [
    await send('POST', `/v1/profile/${enc(ALPHA)}/rebuild`),
    await send('POST', `/v1/profile/${enc(BRAVO)}/rebuild`),
  ],

  listMemories: async (send, f) => [
    await send('GET', '/v1/memories?limit=1000&includeForgotten=true'),
    await send('GET', `/v1/memories?after=${f.b.memoryId}`),
    await send('GET', `/v1/memories?containerTag=${enc(BRAVO)}`),
  ],
  addMemories: async (send, f) => [
    await send('POST', '/v1/memories', { memories: [{ content: 'Replaces the other container’s fact.', supersedes: f.b.memoryId }] }),
    await send('POST', '/v1/memories', { memories: [{ content: 'Extends the other container’s fact.', extendsIds: [f.b.memoryId] }] }),
    await send('POST', '/v1/memories', { containerTag: BRAVO, memories: [{ content: 'Written into the other container?' }] }),
  ],
  getMemory: async (send, f) => [
    await send('GET', `/v1/memories/${f.b.memoryId}`),
    await send('GET', `/v1/memories/${f.b.forgottenId}?containerTag=${enc(BRAVO)}`),
  ],
  getLineage: async (send, f) => [
    await send('GET', `/v1/memories/${f.b.memoryId}/lineage`),
    await send('GET', `/v1/memories/${f.a.memoryId}/lineage`),
    await send('GET', `/v1/memories/${f.b.memoryId}/lineage?containerTag=${enc(BRAVO)}`),
  ],
  forget: async (send, f) => [
    await send('POST', `/v1/memories/${f.b.memoryId}/forget`),
    await send('POST', `/v1/memories/${f.b.memoryId}/forget?containerTag=${enc(BRAVO)}`),
  ],

  graph: async (send) => [
    await send('GET', `/v1/graph/${enc(ALPHA)}?includeForgotten=true`),
    await send('GET', `/v1/graph/${enc(BRAVO)}`),
  ],
  deleteContainer: async (send) => [
    await send('DELETE', `/v1/containers/${enc(BRAVO)}`),
    await send('DELETE', `/v1/containers/${enc(ALPHA)}`),
    await send('GET', '/v1/memories?includeForgotten=true'),
  ],
  listRuns: async (send, f) => [
    await send('GET', '/v1/runs?limit=1000'),
    await send('GET', `/v1/runs?documentId=${f.b.documentId}`),
    await send('GET', `/v1/runs?containerTag=${enc(BRAVO)}`),
  ],
  events: async (send, f, h) => {
    const denied = await send('GET', `/v1/events?containerTag=${enc(BRAVO)}`);
    const stream = await send('GET', '/v1/events');
    const alphaJob: Job = { ...bravoJob(f.a.documentId), id: 'job_alpha', containerTag: ALPHA };
    const read = readEvents(stream, { until: (events) => events.some((e) => e.data.includes('job_alpha')), timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.server.events.publish({ type: 'failed', job: bravoJob(f.b.documentId), attempt: 1, error: 'BRAVO extraction failed' });
    h.server.events.publish({ type: 'failed', job: alphaJob, attempt: 1, error: 'extraction failed' });
    const events = await read;
    // The stream works: the caller's own event arrives. The other container's never does.
    expect(events.some((e) => e.data.includes('job_alpha'))).toBe(true);
    return [denied, new Response(JSON.stringify(events))];
  },
};

describe.each(STORE_KINDS)('server leakage (%s store)', (kind) => {
  let h: Harness;
  let keys: { admin: string; alpha: string; bravo: string };

  beforeEach(async () => {
    h = await createHarness(kind);
    keys = {
      admin: (await h.server.keyring.issue({ name: 'admin' })).key,
      alpha: (await h.server.keyring.issue({ name: 'alpha', containerTag: ALPHA })).key,
      bravo: (await h.server.keyring.issue({ name: 'bravo', containerTag: BRAVO })).key,
    };
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('registers exactly the routes in the route table', () => {
    const registered = new Set(h.server.app.routes.map((r) => `${r.method} ${r.path}`));
    const table = new Set(Object.values(ROUTES).map((r) => `${r.method} ${r.path}`));
    expect([...registered].sort()).toEqual([...table].sort());
  });

  it.each(Object.entries(ROUTES).filter(([, r]) => r.auth))('%s refuses requests without credentials', async (_id, def) => {
    const path = def.path.replace(':containerTag', enc(ALPHA)).replace(':id', 'mem_0001');
    const response = await h.request(def.method, path, def.method === 'POST' ? { json: { containerTag: ALPHA } } : {});
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('unauthorized');
  });

  for (const via of ['key', 'session'] as const) {
    it.each(Object.keys(probes) as RouteId[])(`%s never crosses containers (${via})`, async (id) => {
      const fixture = await populate(h);
      const before = await bravoState(h);

      let cookie: string | undefined;
      if (via === 'session') {
        const created = await h.request('POST', '/v1/session', { json: { apiKey: keys.alpha } });
        expect(created.status).toBe(201);
        cookie = created.headers.get('set-cookie')!.split(';')[0]!;
      }
      const send: Send = (method, path, json) =>
        h.request(method, path, { ...(via === 'key' ? { key: keys.alpha } : { cookie: cookie! }), ...(json !== undefined ? { json } : {}) });

      const responses = await probes[id](send, fixture, h, keys.alpha);
      const bodies: string[] = [];
      for (const response of responses) {
        expect([200, 201, 202, 204, 400, 403, 404], `${id} answered ${response.status}`).toContain(response.status);
        bodies.push(await response.text());
      }
      const text = bodies.join('\n');
      expect(text).not.toContain('BRAVO');
      for (const bravoId of fixture.b.ids) expect(text).not.toContain(`"${bravoId}"`);
      expect(await bravoState(h)).toBe(before);
    });
  }

  it('an unscoped key reaches both containers, naming each explicitly', async () => {
    await populate(h);
    const alpha = await h.request('GET', `/v1/memories?containerTag=${enc(ALPHA)}`, { key: keys.admin });
    const bravo = await h.request('GET', `/v1/memories?containerTag=${enc(BRAVO)}`, { key: keys.admin });
    expect(await alpha.text()).toContain('ALPHA');
    expect(await bravo.text()).toContain('BRAVO');
    const unnamed = await h.request('GET', '/v1/memories', { key: keys.admin });
    expect(unnamed.status).toBe(400);
  });

  it('a scoped key names its own container or none, and is refused any other', async () => {
    await populate(h);
    const implicit = await h.request('GET', '/v1/memories', { key: keys.bravo });
    const explicit = await h.request('GET', `/v1/memories?containerTag=${enc(BRAVO)}`, { key: keys.bravo });
    expect(await implicit.text()).toContain('BRAVO');
    expect(await explicit.text()).toBe(await (await h.request('GET', '/v1/memories', { key: keys.bravo })).text());
    const other = await h.request('GET', `/v1/memories?containerTag=${enc(ALPHA)}`, { key: keys.bravo });
    expect(other.status).toBe(403);
    expect((await errorOf(other)).code).toBe('scope_violation');
  });
});
