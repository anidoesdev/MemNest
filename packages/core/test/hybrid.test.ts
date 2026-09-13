import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  EmbeddingProviderMismatchError,
  RRF_K,
  createInMemoryJobQueue,
  createMemnest,
  fuseRrf,
  scopeOf,
  type EmbeddingProvider,
  type Memnest,
  type MemnestOptions,
  type Scored,
} from '../src/index';
import { createInMemoryStore, fixedClock, hashEmbedder, scriptedModel, sequentialIds } from '../src/testing/index';

const user = scopeOf('user:123');
const NOW = '2026-03-10T09:00:00.000Z';

/** A hash embedder that also maps a few words to shared concepts, standing in for semantic similarity. */
function conceptEmbedder(concepts: Record<string, string>, id = 'concept:512'): EmbeddingProvider & { calls: string[][] } {
  const inner = hashEmbedder({ id });
  const calls: string[][] = [];
  return {
    id,
    dimensions: inner.dimensions,
    calls,
    embed: (texts) => {
      calls.push(texts);
      return inner.embed(texts.map((t) => t.replace(/[A-Za-z]+/g, (w) => concepts[w.toLowerCase()] ?? w)));
    },
  };
}

function engine(overrides: Partial<MemnestOptions> = {}): { memnest: Memnest; store: ReturnType<typeof createInMemoryStore> } {
  const store = createInMemoryStore({ vector: true });
  const clock = fixedClock(NOW);
  const memnest = createMemnest({ store, clock, ids: sequentialIds(), queue: createInMemoryJobQueue({ clock }), profile: { builder: 'deterministic' }, ...overrides });
  return { memnest, store };
}

describe('fuseRrf', () => {
  const row = (id: string) => ({ id });
  const list = (...ids: string[]): Scored<{ id: string }>[] => ids.map((id, i) => ({ row: row(id), score: 10 - i, rank: i + 1 }));

  it('sums 1/(k + rank) across lists and keeps each retriever’s rank and score', () => {
    const fused = fuseRrf(list('a', 'b', 'c'), list('c', 'a'));
    expect(fused.map((h) => h.row.id)).toEqual(['a', 'c', 'b']);
    const [a, c, b] = fused;
    expect(a!.rrfScore).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 12);
    expect(c!.rrfScore).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 1), 12);
    expect(b).toEqual({ row: { id: 'b' }, rrfScore: 1 / (RRF_K + 2), lexicalRank: 2, lexicalScore: 9 });
    expect(c).toMatchObject({ lexicalRank: 3, vectorRank: 1, vectorScore: 10 });
  });

  it('breaks ties deterministically by best rank, then id', () => {
    expect(fuseRrf(list('x', 'y'), list('y', 'x')).map((h) => h.row.id)).toEqual(['x', 'y']);
    expect(fuseRrf(list('b'), list('a')).map((h) => h.row.id)).toEqual(['a', 'b']);
  });
});

describe('hybrid recall', () => {
  it('fuses lexical and vector candidates into a complete, internally consistent trace', async () => {
    const { memnest } = engine({ embedder: hashEmbedder() });
    await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [
        { content: 'The user prefers Postgres over MongoDB for the payments database.' },
        { content: 'The payments service database moved to MySQL.' },
        { content: 'The user drinks espresso every morning.' },
        { content: 'Dana manages the payments team.' },
      ],
    });
    const { memories, trace } = await memnest.search('payments database', user, { tokenBudget: 25 });

    expect(trace.degraded).toBeUndefined();
    expect(trace.timings).toMatchObject({ embed: expect.any(Number), lexicalMemories: expect.any(Number), vectorMemories: expect.any(Number) });
    const ids = trace.candidates.map((c) => c.memoryId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(trace.candidates.some((c) => c.lexicalRank !== undefined && c.vectorRank !== undefined)).toBe(true);
    for (const c of trace.candidates) {
      const expected = (c.lexicalRank ? 1 / (RRF_K + c.lexicalRank) : 0) + (c.vectorRank ? 1 / (RRF_K + c.vectorRank) : 0);
      expect(c.rrfScore).toBeCloseTo(expected, 12);
      expect(c.included).toBe(c.excludedReason === undefined);
      expect(c.tokens).toBeGreaterThan(0);
    }
    const scores = trace.candidates.map((c) => c.rrfScore);
    expect(scores).toEqual([...scores].sort((a, z) => z - a));
    expect(trace.budget.used).toBe(trace.candidates.filter((c) => c.included).reduce((s, c) => s + c.tokens, 0));
    expect(trace.budget.used).toBeLessThanOrEqual(25);
    expect(trace.candidates.some((c) => c.excludedReason === 'budget')).toBe(true);
    expect(memories.map((m) => m.memory.id)).toEqual(trace.candidates.filter((c) => c.included).map((c) => c.memoryId));
  });

  it('recalls a memory that shares no words with the query through the vector retriever', async () => {
    const { memnest } = engine({ embedder: conceptEmbedder({ employed: 'work', works: 'work' }) });
    const [employed] = await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [{ content: 'Employed by Figma since 2024.' }, { content: 'The garden shed holds a red kettle.' }],
    });
    const lexicalOnly = engine();
    await lexicalOnly.memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'Employed by Figma since 2024.' }] });
    expect((await lexicalOnly.memnest.searchMemories('Where do they work?', user))).toEqual([]);

    const { memories, trace } = await memnest.search('Where do they work?', user, { minVectorScore: 0.1 });
    expect(memories.map((m) => m.memory.id)).toEqual([employed!.id]);
    expect(trace.candidates[0]).toMatchObject({ memoryId: employed!.id, vectorRank: 1, included: true });
    expect(trace.candidates[0]!.lexicalRank).toBeUndefined();
  });

  it('says exactly why it degraded, and still answers', async () => {
    const noEmbedder = engine();
    await noEmbedder.memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user likes tea.' }] });
    expect((await noEmbedder.memnest.search('tea', user)).trace.degraded).toBe('lexical-only: no embedding provider configured');

    const fresh = engine({ embedder: hashEmbedder() });
    expect((await fresh.memnest.search('tea', user)).trace.degraded).toBe('lexical-only: container has no embeddings yet');

    let broken = false;
    const flaky = hashEmbedder();
    const unreliable: EmbeddingProvider = { id: flaky.id, dimensions: flaky.dimensions, embed: (t) => (broken ? Promise.reject(new Error('timeout')) : flaky.embed(t)) };
    const e = engine({ embedder: unreliable });
    await e.memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user likes tea.' }] });
    broken = true;
    const { memories, trace } = await e.memnest.search('tea', user);
    expect(trace.degraded).toBe('lexical-only: query embedding failed (timeout)');
    expect(memories).toHaveLength(1);

    const sqliteLike = createMemnest({ store: createInMemoryStore(), embedder: hashEmbedder() });
    await sqliteLike.add({ containerTag: user.containerTag, content: 'Tea notes.', extraction: 'none' });
    expect((await sqliteLike.search('tea', user)).trace.degraded).toBe('lexical-only');
  });

  it('locks a container to its first embedding provider and refuses another, naming both', async () => {
    const store = createInMemoryStore({ vector: true });
    const first = createMemnest({ store, embedder: hashEmbedder({ dimensions: 512 }) });
    await first.add({ containerTag: user.containerTag, content: 'Notes about tea.', extraction: 'none' });
    expect(await store.getContainer(user)).toMatchObject({ embeddingProviderId: 'hash:512', embeddingDimensions: 512 });

    const second = createMemnest({ store, embedder: hashEmbedder({ dimensions: 256 }) });
    const write = second.add({ containerTag: user.containerTag, content: 'More notes.', extraction: 'none' });
    await expect(write).rejects.toBeInstanceOf(EmbeddingProviderMismatchError);
    await expect(write).rejects.toThrow(/locked to embedding provider hash:512 \(512 dims\); refusing hash:256 \(256 dims\)/);
    await expect(second.search('tea', user)).rejects.toBeInstanceOf(EmbeddingProviderMismatchError);

    // Other containers are unaffected.
    await second.add({ containerTag: 'user:other', content: 'Other notes.', extraction: 'none' });
  });

  it('embeds chunks at add, and re-embeds them with a document summary after extraction', async () => {
    const embedder = hashEmbedder();
    const completion = scriptedModel({
      extraction: [{ candidates: [{ content: 'The user works at Stripe as a product manager.', kind: 'fact', confidence: 0.9, validUntil: null }] }],
      context: () => ({ summary: 'An onboarding chat in which the user describes a new product role at Stripe.' }),
    });
    const { memnest, store } = engine({ embedder, completion });
    const { documentId } = await memnest.add({
      containerTag: user.containerTag,
      content: [{ role: 'user', content: 'I just started at Stripe as a PM.' }],
      extraction: 'instant',
    });
    expect(embedder.calls[0]).toEqual(['user: I just started at Stripe as a PM.']);
    expect(await store.vectorSearch((await embedder.embed(['Stripe']))[0]!, user, { target: 'chunks', k: 5 })).toHaveLength(1);

    await memnest.processDueJobs();
    expect(completion.contextCalls).toHaveLength(1);
    const [chunk] = await store.getChunks(user, documentId);
    expect(chunk!.context).toBe('An onboarding chat in which the user describes a new product role at Stripe.');
    expect(embedder.calls.at(-1)).toEqual([`${chunk!.context}\n\nuser: I just started at Stripe as a PM.`]);
    const [run] = await memnest.listExtractionRuns(user);
    expect(run!.stats).toMatchObject({ contextualizedChunks: 1, created: 1 });
    expect(await store.vectorSearch((await embedder.embed(['Stripe product manager']))[0]!, user, { target: 'memories', k: 5 })).toHaveLength(1);
  });

  it('never fails extraction because contextual chunking failed', async () => {
    const completion = scriptedModel({
      extraction: [{ candidates: [{ content: 'The user works at Stripe as a product manager.', kind: 'fact', confidence: 0.9, validUntil: null }] }],
      context: () => new Error('context model down'),
    });
    const { memnest } = engine({ embedder: hashEmbedder(), completion });
    await memnest.add({ containerTag: user.containerTag, content: 'I work at Stripe as a PM.', extraction: 'instant' });
    expect(await memnest.processDueJobs()).toMatchObject({ succeeded: 1 });
    const [run] = await memnest.listExtractionRuns(user);
    expect(run!.stats).toMatchObject({ created: 1, contextualizedChunks: 0, contextError: 'context model down' });
  });

  it('finds resolution neighbors by meaning, not only shared words', async () => {
    const completion = scriptedModel({
      extraction: [{ candidates: [{ content: 'Employed by Figma now, after leaving Stripe.', kind: 'fact', confidence: 0.9, validUntil: null }] }],
      resolution: [{ relation: 'updates', memoryId: 'm1', reason: 'New employer.' }],
    });
    const { memnest } = engine({ embedder: conceptEmbedder({ employed: 'work', works: 'work' }), completion, extraction: { contextualChunks: false, minNeighborSimilarity: 0.1 } });
    const [old] = await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'Works for a payments company.' }] });
    await memnest.add({ containerTag: user.containerTag, content: 'Update on my job.', extraction: 'instant' });
    await memnest.processDueJobs();

    expect(completion.resolutionCalls).toHaveLength(1);
    expect(completion.resolutionCalls[0]!.messages[0]!.content).toContain('m1 [fact, since 2026-03-10] Works for a payments company.');
    const latest = await memnest.listMemories(user, { limit: 10 }, { latestOnly: true });
    expect(latest.map((m) => m.supersedes)).toEqual([old!.id]);
  });

  it('reranks eligible candidates, records rerank scores, and excludes the irrelevant', async () => {
    const completion = scriptedModel({
      extraction: [],
      rerank: (request) => {
        const lines = request.messages[0]!.content.split('\n').filter((l) => /^m\d+:/.test(l));
        return { scores: lines.map((line) => ({ label: line.split(':')[0], score: line.includes('MySQL') ? 9 : line.includes('espresso') ? 0 : 4 })) };
      },
    });
    const { memnest } = engine({ embedder: hashEmbedder(), completion });
    await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [
        { content: 'The payments database of the user runs on Postgres replicas.' },
        { content: 'The payments database moved to MySQL.' },
        { content: 'The user drinks espresso while debugging the payments database.' },
      ],
    });
    const { memories, trace } = await memnest.search('payments database', user, { rerank: true });
    expect(completion.rerankCalls).toHaveLength(1);
    expect(memories.map((m) => m.memory.content)).toEqual(['The payments database moved to MySQL.', 'The payments database of the user runs on Postgres replicas.']);
    expect(memories[0]!.score).toBe(0.9);
    expect(trace.candidates.map((c) => [c.rerankScore, c.excludedReason])).toEqual([[0.9, undefined], [0.4, undefined], [0, 'rerank']]);
    expect(trace.timings.rerank).toBeGreaterThanOrEqual(0);
  });

  it('keeps the fused order and says so when rerank fails', async () => {
    const completion = scriptedModel({ extraction: [], rerank: () => ({ nonsense: true }) });
    const { memnest } = engine({ completion });
    await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user likes tea.' }, { content: 'Tea is served at noon.' }] });
    const { memories, trace } = await memnest.search('tea', user, { rerank: true });
    expect(memories).toHaveLength(2);
    expect(trace.degraded).toContain('rerank failed (unusable output); fused order kept');
    await expect(engine().memnest.search('tea', user, { rerank: true })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('keeps the relevant memory in the top 5 among 1,000 irrelevant ones', async () => {
    const { memnest } = engine({ embedder: hashEmbedder() });
    const noise = Array.from({ length: 1000 }, (_, i) => ({
      content: `Note ${i}: the ${['red', 'blue', 'green', 'amber', 'violet'][i % 5]} ${['kettle', 'bicycle', 'lantern', 'notebook', 'umbrella', 'guitar'][i % 6]} is kept in the ${['garage', 'attic', 'hallway', 'basement', 'garden shed'][i % 5]}.`,
    }));
    await memnest.addMemories({ containerTag: user.containerTag, memories: noise.slice(0, 600) });
    const [relevant] = await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'Alex works at Stripe as a product manager.' }] });
    await memnest.addMemories({ containerTag: user.containerTag, memories: noise.slice(600) });

    const { trace } = await memnest.search('Which company does Alex work at?', user);
    const position = trace.candidates.findIndex((c) => c.memoryId === relevant!.id);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(5);
    expect(trace.candidates[position]).toMatchObject({ lexicalRank: 1, vectorRank: 1 });
  });
});
