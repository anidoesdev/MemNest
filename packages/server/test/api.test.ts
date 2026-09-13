import type { AddResult, GraphSnapshot, JobStatusEvent, LineageGraph, Memory, Profile, SearchResponse } from '@memnest/core';
import { afterEach, describe, expect, it } from 'vitest';
import { STORE_KINDS, createHarness, errorOf, readEvents, type Harness } from './harness';

const DAY = 24 * 60 * 60 * 1000;
const USER = 'user:123';

const candidate = (content: string, kind = 'fact') => ({ content, kind, confidence: 0.9, validUntil: null });

describe.each(STORE_KINDS)('server api (%s store)', (kind) => {
  let h: Harness;

  afterEach(async () => {
    await h?.cleanup();
  });

  it('runs the definition-of-done story over HTTP', async () => {
    h = await createHarness(kind, {
      script: {
        extraction: [
          { candidates: [candidate('The user prefers Postgres over MongoDB as the database for the payments service.', 'preference'), candidate('The user is working on a payments service.')] },
          { candidates: [candidate('The user moved the payments service database to MySQL.')] },
        ],
        resolution: (request) => {
          const content = request.messages[0]!.content;
          if (content.includes('MySQL') && content.includes('Postgres over MongoDB')) {
            const label = /^(m\d+) .*Postgres over MongoDB/m.exec(content)![1];
            return { relation: 'updates', memoryId: label, reason: 'the database changed' };
          }
          return { relation: 'new', memoryId: null, reason: 'unrelated' };
        },
      },
    });
    const { key } = await h.server.keyring.issue({ name: 'user 123', containerTag: USER });
    const call = async <T>(method: string, path: string, json?: unknown, status = 200): Promise<T> => {
      const response = await h.request(method, path, { key, ...(json !== undefined ? { json } : {}) });
      expect(response.status, await response.clone().text()).toBe(status);
      return (response.status === 204 ? undefined : await response.json()) as T;
    };

    const stream = await h.request('GET', '/v1/events', { key });
    const events = readEvents(stream, { until: (e) => e.filter((x) => x.event === 'job' && x.data.includes('"succeeded"')).length >= 2, timeoutMs: 3000 });

    const first = await call<AddResult>('POST', '/v1/documents', {
      customId: 'session-1',
      extraction: 'instant',
      content: [
        { role: 'user', content: 'I prefer Postgres over MongoDB. I am working on a payments service.' },
        { role: 'assistant', content: 'Noted.' },
      ],
    }, 202);
    expect(first).toMatchObject({ status: 'indexed', deduplicated: false, jobId: expect.any(String) });
    await h.memnest.processDueJobs();

    h.clock.advance(7 * DAY);
    await call<AddResult>('POST', '/v1/documents', {
      customId: 'session-2',
      extraction: 'instant',
      content: [{ role: 'user', content: 'We moved the payments service to MySQL. Thanks!' }],
    }, 202);
    await h.memnest.processDueJobs();

    const received = (await events).filter((e) => e.event === 'job').map((e) => JSON.parse(e.data) as JobStatusEvent);
    expect(received.map((e) => e.type)).toEqual(['started', 'succeeded', 'started', 'succeeded']);
    expect(received[0]).toMatchObject({ jobType: 'extract', containerTag: USER, documentId: first.documentId, attempt: 1 });

    const search = await call<SearchResponse>('POST', '/v1/search', { query: 'what database does this user use?', options: { tokenBudget: 200 } });
    expect(search.memories.map((m) => m.memory.content)).toContain('The user moved the payments service database to MySQL.');
    expect(search.memories.map((m) => m.memory.content)).not.toContain('The user prefers Postgres over MongoDB as the database for the payments service.');
    expect(search.trace.budget).toMatchObject({ limit: 200 });
    expect(search.trace.budget.used).toBeLessThanOrEqual(200);
    const mysql = search.memories.find((m) => m.memory.content.includes('MySQL'))!.memory;
    expect(search.trace.candidates).toContainEqual(expect.objectContaining({ memoryId: mysql.supersedes, excludedReason: 'not-latest' }));

    const lineage = await call<LineageGraph>('GET', `/v1/memories/${mysql.id}/lineage`);
    expect(lineage.edges).toContainEqual({ from: mysql.id, to: mysql.supersedes, relation: 'updates' });
    expect(lineage.edges.filter((e) => e.relation === 'source')).toHaveLength(2);

    const wrong = (await call<Memory[]>('GET', '/v1/memories?latestOnly=true')).find((m) => m.content.includes('working on'))!;
    const forgotten = await call<Memory>('POST', `/v1/memories/${wrong.id}/forget`);
    expect(forgotten.forgottenAt).toBeDefined();
    const after = await call<SearchResponse>('POST', '/v1/search', { query: 'payments service', options: { tokenBudget: 200 } });
    expect(after.memories.map((m) => m.memory.id)).not.toContain(wrong.id);
    expect(after.trace.candidates).toContainEqual(expect.objectContaining({ memoryId: wrong.id, excludedReason: 'forgotten' }));

    const profile = await call<Profile>('GET', `/v1/profile/${encodeURIComponent(USER)}`);
    expect(profile.text).toContain('MySQL');
    expect(profile.text).not.toContain('working on a payments service');

    const graph = await call<GraphSnapshot>('GET', `/v1/graph/${encodeURIComponent(USER)}?includeForgotten=true`);
    expect(graph.edges).toContainEqual({ from: mysql.id, to: mysql.supersedes, relation: 'updates' });
    const runs = await call<Array<{ method: string }>>('GET', `/v1/runs?limit=10`);
    expect(runs.filter((r) => r.method === 'llm')).toHaveLength(2);
  });

  it('serves every read and write the API offers', async () => {
    h = await createHarness(kind);
    const { key } = await h.server.keyring.issue({ name: 'admin' });
    const tag = 'org:acme/team-1';
    const path = encodeURIComponent(tag);
    const send = (method: string, url: string, json?: unknown) => h.request(method, url, { key, ...(json !== undefined ? { json } : {}) });

    const added = await send('POST', '/v1/documents', { containerTag: tag, content: '# Notes\n\nThe team ships on Fridays.', extraction: 'none' });
    expect(added.status).toBe(202);
    const { documentId } = (await added.json()) as AddResult;
    const again = await send('POST', '/v1/documents', { containerTag: tag, content: '# Notes\n\nThe team ships on Fridays.', extraction: 'none' });
    expect(await again.json()).toMatchObject({ documentId, deduplicated: true });

    const doc = await send('GET', `/v1/documents/${documentId}?containerTag=${path}`);
    expect(await doc.json()).toMatchObject({ document: { id: documentId, kind: 'markdown' }, chunks: [expect.objectContaining({ documentId })] });

    const written = await send('POST', '/v1/memories', { containerTag: tag, memories: [{ content: 'The team ships on Fridays.', kind: 'fact' }] });
    expect(written.status).toBe(201);
    const [memory] = (await written.json()) as Memory[];
    expect((await send('GET', `/v1/memories/${memory!.id}?containerTag=${path}`)).status).toBe(200);
    expect((await (await send('GET', `/v1/memories?containerTag=${path}&kind=fact&limit=1`)).json()) as Memory[]).toHaveLength(1);

    const memoriesOnly = (await (await send('POST', '/v1/search', { containerTag: tag, query: 'ships Fridays', include: ['memories'] })).json()) as object;
    expect(Object.keys(memoriesOnly)).toEqual(['memories']);
    const chunksOnly = (await (await send('POST', '/v1/search', { containerTag: tag, query: 'ships Fridays', include: ['chunks'] })).json()) as object;
    expect(Object.keys(chunksOnly)).toEqual(['chunks']);

    expect((await send('POST', `/v1/profile/${path}/rebuild`)).status).toBe(200);
    expect((await send('DELETE', `/v1/documents/${documentId}?containerTag=${path}`)).status).toBe(204);
    expect(await (await send('GET', `/v1/documents/${documentId}?containerTag=${path}`)).json()).toMatchObject({
      document: { deletedAt: expect.any(String), content: '' },
      chunks: [],
    });

    expect((await send('DELETE', `/v1/containers/${path}`)).status).toBe(204);
    expect(await (await send('GET', `/v1/memories?containerTag=${path}&includeForgotten=true`)).json()).toEqual([]);
    expect((await send('GET', `/healthz`)).status).toBe(200);
  });

  it('maps errors to status codes without leaking internals', async () => {
    h = await createHarness(kind);
    const { key } = await h.server.keyring.issue({ name: 'scoped', containerTag: USER });
    const send = (method: string, url: string, init: RequestInit & { json?: unknown } = {}) => h.request(method, url, { key, ...init });
    const expectError = async (response: Response, status: number, code: string) => {
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    };

    await expectError(await send('GET', '/v1/memories/mem_missing'), 404, 'not_found');
    await expectError(await send('GET', '/v1/memories/mem_missing/lineage'), 404, 'not_found');
    await expectError(await send('GET', '/v1/documents/doc_missing'), 404, 'not_found');
    await expectError(await send('GET', '/v1/memories?limit=abc'), 400, 'validation');
    await expectError(await send('GET', '/v1/memories?latestOnly=yes'), 400, 'validation');
    await expectError(await send('POST', '/v1/search', { json: { query: 42 } }), 400, 'validation');
    await expectError(await send('POST', '/v1/search', { json: { query: 'x', include: ['everything'] } }), 400, 'validation');
    await expectError(await send('POST', '/v1/memories', { json: { memories: [] } }), 400, 'validation');
    await expectError(await send('POST', '/v1/memories', { body: 'not json', headers: { 'content-type': 'application/json' } }), 400, 'validation');
    await expectError(await send('POST', '/v1/memories', { json: [1, 2] }), 400, 'validation');
    await expectError(await send('GET', '/v1/nowhere'), 404, 'not_found');

    const huge = await send('POST', '/v1/documents', { json: { content: 'x'.repeat(6 * 1024 * 1024) } });
    await expectError(huge, 413, 'validation');

    const failing = { ...h.memnest, listMemories: async () => { throw new Error('SELECT secret FROM memnest_memories failed'); } };
    const { createServer } = await import('../src/index');
    const broken = createServer({ memnest: failing, auth: h.auth, keyring: { argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } } });
    const response = await broken.app.request('http://memnest.test/v1/memories', { headers: { authorization: `Bearer ${key}` } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'internal', message: 'internal server error' } });
  });

  it('streams only the key’s container, sends a ready event, and keeps the stream alive', async () => {
    h = await createHarness(kind);
    const { key } = await h.server.keyring.issue({ name: 'scoped', containerTag: USER });
    const stream = await h.request('GET', '/v1/events', { key });
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    const read = readEvents(stream, { until: (e) => e.some((x) => x.event === 'ping') && e.some((x) => x.event === 'job'), timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const job = { id: 'job_1', type: 'profile' as const, containerTag: USER, runAt: '2026-03-01T09:00:00.000Z' };
    h.server.events.publish({ type: 'retrying', job, attempt: 2, at: '2026-03-01T09:00:10.000Z', error: 'failed with Bearer abcdefghijklmnopqrstuvwxyz' });
    h.server.events.publish({ type: 'error', error: 'queue broke' });
    const events = await read;

    expect(events[0]).toEqual({ event: 'ready', data: JSON.stringify({ containerTag: USER }) });
    const jobs = events.filter((e) => e.event === 'job').map((e) => JSON.parse(e.data));
    expect(jobs).toEqual([
      {
        type: 'retrying',
        jobId: 'job_1',
        jobType: 'profile',
        containerTag: USER,
        attempt: 2,
        at: '2026-03-01T09:00:10.000Z',
        error: 'failed with Bearer [REDACTED:bearer]',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.server.events.size).toBe(0);
  });
});
