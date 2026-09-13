import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  createInMemoryJobQueue,
  createLlmResolver,
  createMemnest,
  scopeOf,
  type CompletionRequest,
  type Memory,
} from '../src/index';
import { createInMemoryStore, fixedClock, scriptedCompletion, scriptedModel, sequentialIds, type ScriptedModelScript } from '../src/testing/index';

const NOW = '2026-03-10T09:00:00.000Z';
const DAY = 24 * 60 * 60_000;
const user = scopeOf('user:123');
const c = (content: string, kind = 'fact') => ({ content, kind, confidence: 0.9, validUntil: null });

const memory = (id: string, content: string, extra: Partial<Memory> = {}): Memory => ({
  id,
  containerTag: user.containerTag,
  content,
  kind: 'fact',
  confidence: 0.9,
  isLatest: true,
  version: 1,
  extendsIds: [],
  sourceDocumentIds: ['doc_1'],
  extractionRunId: 'run_1',
  validFrom: '2026-01-05T00:00:00.000Z',
  reinforcementCount: 1,
  createdAt: '2026-01-05T00:00:00.000Z',
  ...extra,
});

const candidate = { content: 'The user migrated the payments service to MySQL.', kind: 'fact' as const, confidence: 0.9 };
const neighbors = [
  memory('mem_pg', "The user's payments service runs on Postgres."),
  memory('mem_pref', 'The user prefers Postgres over MongoDB.', { kind: 'preference' }),
];

describe('createLlmResolver', () => {
  it('skips the model when nothing is similar or the text matches exactly', async () => {
    const completion = scriptedCompletion([]);
    const resolver = createLlmResolver({ completion });
    expect(await resolver.resolve({ candidate, neighbors: [], referenceDate: NOW })).toMatchObject({ relation: 'new', via: 'no-neighbors', calls: 0 });
    expect(
      await resolver.resolve({ candidate: { ...candidate, content: "the user's payments service runs on postgres" }, neighbors, referenceDate: NOW }),
    ).toMatchObject({ relation: 'duplicate', memoryId: 'mem_pg', via: 'exact', calls: 0 });
    expect(completion.calls).toHaveLength(0);
  });

  it('labels neighbors compactly, maps the label back to the real id, and records the reason', async () => {
    const completion = scriptedCompletion([{ relation: 'updates', memoryId: 'm1', reason: 'Database changed to MySQL.' }]);
    const result = await createLlmResolver({ completion }).resolve({ candidate, neighbors, referenceDate: NOW });

    expect(result).toMatchObject({ relation: 'updates', memoryId: 'mem_pg', via: 'model', calls: 1, reason: 'Database changed to MySQL.' });
    const request = completion.calls[0]!;
    expect(request.schemaName).toBe('memnest_resolution');
    expect(request.messages[0]!.content).toBe(
      [
        'Existing:',
        "m1 [fact, since 2026-01-05] The user's payments service runs on Postgres.",
        'm2 [preference, since 2026-01-05] The user prefers Postgres over MongoDB.',
        '',
        'Candidate [fact, as of 2026-03-10]: The user migrated the payments service to MySQL.',
      ].join('\n'),
    );
    expect(request.messages[0]!.content).not.toContain('mem_pg');
  });

  it('tolerates label formatting and answers "new" without a target', async () => {
    const completion = scriptedCompletion([
      { relation: 'extends', memoryId: ' M2 ', reason: 'x' },
      { relation: 'duplicate', memoryId: '1', reason: 'x' },
      { relation: 'new', memoryId: 'm1', reason: 'unrelated' },
    ]);
    const resolver = createLlmResolver({ completion });
    const input = { candidate, neighbors, referenceDate: NOW };
    expect(await resolver.resolve(input)).toMatchObject({ relation: 'extends', memoryId: 'mem_pref' });
    expect(await resolver.resolve(input)).toMatchObject({ relation: 'duplicate', memoryId: 'mem_pg' });
    const fresh = await resolver.resolve(input);
    expect(fresh).toMatchObject({ relation: 'new', via: 'model' });
    expect(fresh.memoryId).toBeUndefined();
  });

  it('retries invalid output once, then falls back to new', async () => {
    const hallucinated = scriptedCompletion([{ relation: 'updates', memoryId: 'm7', reason: 'x' }, { relation: 'updates', memoryId: 'm1', reason: 'ok' }]);
    expect(await createLlmResolver({ completion: hallucinated }).resolve({ candidate, neighbors, referenceDate: NOW })).toMatchObject({
      relation: 'updates',
      memoryId: 'mem_pg',
      calls: 2,
    });

    const garbage = scriptedCompletion([{ verdict: 'same' }, { relation: 'replaces', memoryId: 'm1' }]);
    expect(await createLlmResolver({ completion: garbage }).resolve({ candidate, neighbors, referenceDate: NOW })).toMatchObject({
      relation: 'new',
      via: 'fallback',
      calls: 2,
    });
  });

  it('lets provider failures propagate so the job retries, and redacts reasons', async () => {
    const down = scriptedCompletion([new ProviderError('p', 'HTTP 503', { retryable: true })]);
    await expect(createLlmResolver({ completion: down }).resolve({ candidate, neighbors, referenceDate: NOW })).rejects.toBeInstanceOf(ProviderError);

    const leaky = scriptedCompletion([{ relation: 'new', memoryId: null, reason: 'unrelated to token=abc123secret' }]);
    const result = await createLlmResolver({ completion: leaky }).resolve({ candidate, neighbors, referenceDate: NOW });
    expect(result.reason).not.toContain('abc123secret');
  });
});

describe('resolution in the extraction job', () => {
  function setup(script: ScriptedModelScript) {
    const clock = fixedClock(NOW);
    const store = createInMemoryStore();
    const completion = scriptedModel(script);
    const memnest = createMemnest({ store, clock, completion, ids: sequentialIds(), queue: createInMemoryJobQueue({ clock, backoffBaseMs: 1000 }) });
    const ingest = async (text: string) => {
      await memnest.add({ containerTag: user.containerTag, content: [{ role: 'user', content: text }], extraction: 'instant' });
      return memnest.processDueJobs();
    };
    return { clock, store, completion, memnest, ingest };
  }

  it('supersedes a contradicted memory, versions it, and serves only the new fact', async () => {
    const { memnest, ingest, clock, completion } = setup({
      extraction: [{ candidates: [c('The payments service of the user runs on Postgres.')] }, { candidates: [c('The payments service of the user runs on MySQL.')] }],
      resolution: [{ relation: 'updates', memoryId: 'm1', reason: 'Database changed.' }],
    });
    await ingest('Our payments service runs on Postgres.');
    expect(completion.resolutionCalls).toHaveLength(0);
    clock.advance(7 * DAY);
    await ingest('We moved the payments service to MySQL.');

    expect(completion.resolutionCalls).toHaveLength(1);
    const [postgres, mysql] = await memnest.listMemories(user);
    expect(postgres).toMatchObject({ isLatest: false, version: 1 });
    expect(mysql).toMatchObject({ isLatest: true, version: 2, supersedes: postgres!.id, validFrom: '2026-03-17T09:00:00.000Z' });

    const [run] = await memnest.listExtractionRuns(user);
    expect(run!.stats).toMatchObject({
      resolutionCalls: 1,
      updated: 1,
      created: 0,
      decisions: [{ relation: 'updates', memoryId: postgres!.id, via: 'model', reason: 'Database changed.', resultId: mysql!.id }],
    });

    const { memories, trace } = await memnest.search('which database does the payments service use', user, { tokenBudget: 200 });
    expect(memories.map((m) => m.memory.id)).toEqual([mysql!.id]);
    expect(trace.candidates).toContainEqual(expect.objectContaining({ memoryId: postgres!.id, excludedReason: 'not-latest' }));
    expect((await memnest.getLineage(user, mysql!.id))!.edges).toContainEqual({ from: mysql!.id, to: postgres!.id, relation: 'updates' });
  });

  it('reinforces a rephrased duplicate and records its new source', async () => {
    const { memnest, ingest } = setup({
      extraction: [{ candidates: [c('The user prefers dark mode.', 'preference')] }, { candidates: [c('The user prefers dark mode in every editor.', 'preference')] }],
      resolution: [{ relation: 'duplicate', memoryId: 'm1', reason: 'Same preference.' }],
    });
    await ingest('I always use dark mode.');
    await ingest('Dark mode is my preference in every editor.');

    const memories = await memnest.listMemories(user);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ content: 'The user prefers dark mode.', reinforcementCount: 2 });
    expect(memories[0]!.sourceDocumentIds).toHaveLength(2);
  });

  it('extends without invalidating', async () => {
    const { memnest, ingest } = setup({
      extraction: [{ candidates: [c('The user is a product manager at Stripe.')] }, { candidates: [c('The user manages a team of six engineers at Stripe.')] }],
      resolution: [{ relation: 'extends', memoryId: 'm1', reason: 'Adds team size.' }],
    });
    await ingest('I am a PM at Stripe.');
    await ingest('At Stripe I manage six engineers.');
    const [role, team] = await memnest.listMemories(user);
    expect(role).toMatchObject({ isLatest: true });
    expect(team).toMatchObject({ isLatest: true, extendsIds: [role!.id], version: 1 });
  });

  it('resolves candidates against memories planned earlier in the same run', async () => {
    const { memnest, ingest, completion } = setup({
      extraction: [
        {
          candidates: [
            c('The user lives in Portland.'),
            c('The user lives in Seattle after moving from Portland in February 2026.'),
            c('The user lives in Seattle now.'),
          ],
        },
      ],
      resolution: [
        { relation: 'updates', memoryId: 'm1', reason: 'Corrected in the same conversation.' },
        { relation: 'duplicate', memoryId: 'm1', reason: 'Same as the Seattle memory.' },
      ],
    });
    await ingest('I live in Portland. Actually no, I moved to Seattle in February. Seattle now.');

    // The third candidate sees the Seattle memory but not the superseded Portland one.
    expect(completion.resolutionCalls[1]!.messages[0]!.content).toMatch(/m1 \[fact, since [\d-]+\] The user lives in Seattle after/);
    expect(completion.resolutionCalls[1]!.messages[0]!.content).not.toContain('The user lives in Portland.');

    const all = await memnest.listMemories(user);
    expect(all.map((m) => [m.content, m.isLatest])).toEqual([
      ['The user lives in Portland.', false],
      ['The user lives in Seattle after moving from Portland in February 2026.', true],
    ]);
    const stats = (await memnest.listExtractionRuns(user))[0]!.stats!;
    expect(stats).toMatchObject({ created: 1, updated: 1, reinforced: 0 });
    expect(stats.decisions.map((d) => d.relation)).toEqual(['new', 'updates', 'duplicate']);
  });

  it('does not hold the write lock during model calls, and downgrades plans the graph no longer allows', async () => {
    let memnestRef: ReturnType<typeof createMemnest> | undefined;
    const { memnest, ingest } = setup({
      extraction: [{ candidates: [c('The payments service of the user runs on Postgres.')] }, { candidates: [c('The payments service of the user runs on MySQL.')] }],
      resolution: async (request: CompletionRequest) => {
        // While the model "thinks", other work proceeds: a search, and a user forgetting the target.
        const [target] = await memnestRef!.listMemories(user);
        await memnestRef!.search('payments service', user);
        await memnestRef!.forget(user, target!.id);
        expect(request.messages[0]!.content).toContain('m1');
        return { relation: 'updates', memoryId: 'm1', reason: 'Database changed.' };
      },
    });
    memnestRef = memnest;
    await ingest('Our payments service runs on Postgres.');
    expect(await ingest('We moved the payments service to MySQL.')).toMatchObject({ succeeded: 1 });

    const all = await memnest.listMemories(user, { limit: 10 }, { includeForgotten: true });
    const mysql = all.find((m) => m.content.includes('MySQL'))!;
    expect(mysql).toMatchObject({ isLatest: true, version: 1 });
    expect(mysql.supersedes).toBeUndefined();
    const decision = (await memnest.listExtractionRuns(user))[0]!.stats!.decisions[0];
    expect(decision).toMatchObject({ relation: 'new', via: 'conflict', resultId: mysql.id });
  });

  it('writes nothing when a resolution call fails, and succeeds on retry', async () => {
    let fail = true;
    const { memnest, ingest, clock } = setup({
      extraction: () => ({ candidates: [c('The payments service of the user runs on MySQL.')] }),
      resolution: () => {
        if (fail) return new ProviderError('p', 'HTTP 503', { retryable: true });
        return { relation: 'updates', memoryId: 'm1', reason: 'changed' };
      },
    });
    await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The payments service of the user runs on Postgres.' }] });
    expect(await ingest('We moved the payments service to MySQL.')).toMatchObject({ retried: 1 });
    expect(await memnest.listMemories(user)).toHaveLength(1);

    fail = false;
    clock.advance(1000);
    expect(await memnest.processDueJobs()).toMatchObject({ succeeded: 1 });
    const [postgres, mysql] = await memnest.listMemories(user);
    expect(postgres!.isLatest).toBe(false);
    expect(mysql!.supersedes).toBe(postgres!.id);
  });
});
