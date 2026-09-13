import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ProviderError,
  createInMemoryJobQueue,
  createMemnest,
  defaultRedactor,
  scopeOf,
  screenCandidates,
  unresolvedPronouns,
  type Memnest,
} from '../src/index';
import { createInMemoryStore, fixedClock, scriptedModel, sequentialIds, type ScriptedModel } from '../src/testing/index';

const NOW = '2026-03-10T09:00:00.000Z';
const user = scopeOf('user:123');
const c = (content: string, extra: Record<string, unknown> = {}) => ({ content, kind: 'fact', confidence: 0.9, validUntil: null, ...extra });

function setup(extractionScript: NonNullable<Parameters<typeof scriptedModel>[0]['extraction']>, extraction = {}) {
  const clock = fixedClock(NOW);
  const store = createInMemoryStore();
  const queue = createInMemoryJobQueue({ clock, backoffBaseMs: 1000 });
  const completion: ScriptedModel = scriptedModel({ extraction: extractionScript });
  // Profiles build inline here, so job counts reflect extraction alone (profile jobs are covered in profile.test.ts).
  const memnest: Memnest = createMemnest({ store, queue, clock, completion, ids: sequentialIds(), extraction, profile: { builder: 'deterministic' } });
  return { clock, store, queue, completion, memnest };
}

const session = [
  { role: 'user', content: 'I just started at Stripe as a PM. My manager Dana wants me to own the payments dashboard.' },
  { role: 'assistant', content: 'Congratulations! Where will you start?' },
];

describe('screenCandidates', () => {
  const screen = (candidates: unknown[]) =>
    screenCandidates({ candidates }, { provider: 'p', now: NOW, redactor: defaultRedactor, minConfidence: 0.5, maxChars: 120 });

  it('accepts clean candidates and normalizes them', () => {
    const { accepted, rejected } = screen([
      c('  Alex works   at Stripe.  ', { confidence: 1.4 }),
      c('The user has a dentist appointment on 2026-03-10.', { kind: 'episode', validUntil: '2026-03-10T23:59:59Z' }),
    ]);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      { content: 'Alex works at Stripe.', kind: 'fact', confidence: 1 },
      { content: 'The user has a dentist appointment on 2026-03-10.', kind: 'episode', confidence: 0.9, validUntil: '2026-03-10T23:59:59.000Z' },
    ]);
  });

  it.each([
    [c('He moved there in March.'), 'unresolved-pronoun'],
    [c('The user said my key is sk-proj-abcdefghijklmnopqrstu.'), 'secret'],
    [c('The user password is [REDACTED].'), 'secret'],
    [c('The user said thanks for the help.', { confidence: 0.2 }), 'low-confidence'],
    [c('The user had a meeting yesterday morning.', { validUntil: '2026-03-09T12:00:00Z' }), 'already-expired'],
    [c('Thanks!'), 'empty'],
    [c(`The user likes ${'very '.repeat(40)}long sentences.`), 'too-long'],
    [c('The user likes tea.', { kind: 'opinion' }), 'malformed'],
    [{ content: 42 }, 'malformed'],
    [c('The user likes tea.', { validUntil: 'soon' }), 'malformed'],
  ])('rejects %j as %s', (candidate, reason) => {
    const { accepted, rejected } = screen([candidate]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([expect.objectContaining({ reason })]);
  });

  it('never stores a rejected secret verbatim and drops in-batch duplicates', () => {
    const { rejected, accepted } = screen([
      c('Key: sk-proj-abcdefghijklmnopqrstu belongs to the user.'),
      c('The user likes tea.'),
      c('the user likes tea'),
    ]);
    expect(JSON.stringify(rejected)).not.toContain('sk-proj-abcdefghijklmnopqrstu');
    expect(accepted).toHaveLength(1);
    expect(rejected.map((r) => r.reason)).toEqual(['secret', 'duplicate-in-batch']);
  });

  it('throws a retryable provider error when the output is not the schema', () => {
    expect(() => screenCandidates({ memories: [] }, { provider: 'p', now: NOW, redactor: defaultRedactor, minConfidence: 0.5, maxChars: 400 })).toThrow(ProviderError);
  });
});

describe('unresolvedPronouns', () => {
  it('flags first, second and personal third person pronouns only', () => {
    expect(unresolvedPronouns('He told her that they would visit.')).toEqual(['he', 'her', 'they']);
    expect(unresolvedPronouns("I'm moving; our team agrees")).toEqual(['i', 'our']);
    expect(unresolvedPronouns('The user lives in the US and Stripe raised its prices. It is expensive.')).toEqual([]);
  });
});

describe('extraction job', () => {
  it('extracts instantly, with provenance, and marks the document extracted', async () => {
    const { memnest, completion, store } = setup([
      { candidates: [c('The user works at Stripe as a product manager.'), c('Dana is the manager of the user at Stripe.'), c('He owns it.')] },
    ]);
    const { documentId } = await memnest.add({ containerTag: user.containerTag, content: session, extraction: 'instant' });

    expect(await memnest.processDueJobs()).toMatchObject({ succeeded: 1 });

    expect(completion.extractionCalls).toHaveLength(1);
    const prompt = completion.extractionCalls[0]!.messages[0]!.content;
    expect(prompt).toContain('Reference date: 2026-03-10T09:00:00.000Z');
    expect(prompt).toContain('user: I just started at Stripe');
    expect(completion.extractionCalls[0]!.jsonSchema).toMatchObject({ required: ['candidates'] });

    const memories = await memnest.listMemories(user);
    expect(memories.map((m) => m.content)).toEqual([
      'The user works at Stripe as a product manager.',
      'Dana is the manager of the user at Stripe.',
    ]);
    const [run] = await memnest.listExtractionRuns(user, { documentId });
    expect(run).toMatchObject({
      method: 'llm',
      status: 'succeeded',
      model: 'scripted',
      documentIds: [documentId],
      promptVersion: 'extract-v1+llm-resolve-v1',
      stats: { calls: 1, candidates: 3, accepted: 2, created: 2, rejected: [{ content: 'He owns it.', reason: 'unresolved-pronoun' }] },
    });
    for (const m of memories) {
      expect(m).toMatchObject({ sourceDocumentIds: [documentId], extractionRunId: run!.id, validFrom: NOW, isLatest: true });
    }
    expect((await store.getDocument(user, documentId))?.status).toBe('extracted');
  });

  it('waits for a batched session to go quiet, then extracts it once from the newest version', async () => {
    const { memnest, clock, completion } = setup([{ candidates: [c('The user works at Stripe as a product manager.')] }]);
    const turn3 = { role: 'user', content: 'Also, I prefer Postgres over MongoDB.' };
    const v1 = await memnest.add({ containerTag: user.containerTag, customId: 'session-1', content: session.slice(0, 1) });
    clock.advance(20_000);
    const v2 = await memnest.add({ containerTag: user.containerTag, customId: 'session-1', content: session });
    clock.advance(20_000);
    const v3 = await memnest.add({ containerTag: user.containerTag, customId: 'session-1', content: [...session, turn3] });

    // v1's job is due (30s after v1) but the session is still active: defer.
    clock.advance(15_000);
    expect(await memnest.processDueJobs()).toMatchObject({ processed: 2, deferred: 2 });
    expect(completion.extractionCalls).toHaveLength(0);

    clock.advance(30_000);
    const summary = await memnest.processDueJobs();
    expect(summary).toMatchObject({ succeeded: 3 });
    expect(completion.extractionCalls).toHaveLength(1);
    const prompt = completion.extractionCalls[0]!.messages[0]!.content;
    expect(prompt.match(/I just started at Stripe/g)).toHaveLength(1);
    expect(prompt).toContain('I prefer Postgres over MongoDB');

    const [memory] = await memnest.listMemories(user);
    expect(memory!.sourceDocumentIds).toEqual([v1.documentId, v2.documentId, v3.documentId]);
    expect(memory!.validFrom).toBe('2026-03-10T09:00:40.000Z');
  });

  it('extracts only the new part of a session that grew after extraction', async () => {
    const { memnest, clock, completion } = setup([
      { candidates: [c('The user works at Stripe as a product manager.')] },
      { candidates: [c('The user prefers Postgres over MongoDB.', { kind: 'preference' })] },
    ]);
    await memnest.add({ containerTag: user.containerTag, customId: 's', content: session });
    clock.advance(31_000);
    await memnest.processDueJobs();

    clock.advance(60 * 60_000);
    await memnest.add({
      containerTag: user.containerTag,
      customId: 's',
      content: [...session, { role: 'user', content: 'For the dashboard I prefer Postgres over MongoDB.' }],
    });
    clock.advance(31_000);
    await memnest.processDueJobs();

    const second = completion.extractionCalls[1]!.messages[0]!.content;
    expect(second).toMatch(/<already_processed>[\s\S]*I just started at Stripe[\s\S]*<\/already_processed>/);
    expect(second.split('<transcript>')[1]).not.toContain('I just started at Stripe');
    expect(second.split('<transcript>')[1]).toContain('I prefer Postgres over MongoDB');
    expect(await memnest.listMemories(user)).toHaveLength(2);
  });

  it('extracts a never-quiet session once the maximum batch delay is reached', async () => {
    const { memnest, clock, completion } = setup(() => ({ candidates: [] }));
    const turns = [...session];
    for (let i = 0; i < 40; i++) {
      turns.push({ role: 'user', content: `Update number ${i} about the dashboard.` });
      await memnest.add({ containerTag: user.containerTag, customId: 'busy', content: [...turns] });
      clock.advance(20_000);
      await memnest.processDueJobs();
      if (completion.extractionCalls.length > 0) break;
    }
    expect(completion.extractionCalls).toHaveLength(1);
    expect(Date.parse(clock.now()) - Date.parse(NOW)).toBeLessThanOrEqual(10 * 60_000 + 20_000);
  });

  it('reinforces exact duplicates instead of storing them twice', async () => {
    const { memnest } = setup([{ candidates: [c('the user prefers postgres over mongodb', { kind: 'preference' })] }]);
    const [existing] = await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [{ content: 'The user prefers Postgres over MongoDB.', kind: 'preference' }],
    });
    const { documentId } = await memnest.add({ containerTag: user.containerTag, content: 'I prefer Postgres over MongoDB.', extraction: 'instant' });
    await memnest.processDueJobs();

    const memories = await memnest.listMemories(user);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ id: existing!.id, reinforcementCount: 2 });
    expect(memories[0]!.sourceDocumentIds).toContain(documentId);
  });

  it('retries transient provider failures while chunks stay searchable', async () => {
    const { memnest, clock, store, queue } = setup([
      new ProviderError('scripted', 'HTTP 503', { status: 503, retryable: true }),
      { candidates: [c('The user works at Stripe as a product manager.')] },
    ]);
    const { documentId } = await memnest.add({ containerTag: user.containerTag, content: session, extraction: 'instant' });

    expect(await memnest.processDueJobs()).toMatchObject({ retried: 1 });
    expect((await store.getDocument(user, documentId))?.status).toBe('failed');
    expect(await memnest.searchDocuments('Stripe dashboard', user)).toHaveLength(1);
    expect((await memnest.listExtractionRuns(user))[0]).toMatchObject({ status: 'failed', error: 'scripted: HTTP 503' });

    clock.advance(1000);
    expect(await memnest.processDueJobs()).toMatchObject({ succeeded: 1 });
    expect((await store.getDocument(user, documentId))?.status).toBe('extracted');
    expect(await memnest.listMemories(user)).toHaveLength(1);
    expect(queue.list(user)[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('fails permanently on non-retryable errors and writes nothing', async () => {
    const { memnest, queue } = setup([new ProviderError('scripted', 'model refused', { retryable: false })]);
    await memnest.add({ containerTag: user.containerTag, content: session, extraction: 'instant' });
    expect(await memnest.processDueJobs()).toMatchObject({ failed: 1 });
    expect(queue.list()[0]).toMatchObject({ status: 'failed', lastError: 'scripted: model refused' });
    expect(await memnest.listMemories(user)).toEqual([]);
  });

  it('rolls back every memory when a write fails mid-run', async () => {
    const { memnest, store } = setup([{ candidates: [c('The user works at Stripe as a product manager.'), c('Dana manages the payments team.')] }]);
    const { documentId } = await memnest.add({ containerTag: user.containerTag, content: session, extraction: 'instant' });
    let writes = 0;
    // Break the second memory write inside the transaction.
    const original = store.transaction.bind(store);
    store.transaction = (fn) =>
      original((tx) =>
        fn({
          ...tx,
          putMemories: async (scope, memories) => {
            if (++writes === 2) throw new Error('disk full');
            return tx.putMemories(scope, memories);
          },
        }),
      );
    await memnest.processDueJobs();
    store.transaction = original;
    expect(await memnest.listMemories(user)).toEqual([]);
    expect((await store.getDocument(user, documentId))?.status).toBe('failed');
  });

  it('skips documents deleted before extraction', async () => {
    const { memnest, completion } = setup([]);
    const { documentId } = await memnest.add({ containerTag: user.containerTag, content: session, extraction: 'instant' });
    await memnest.deleteDocument(user, documentId);
    expect(await memnest.processDueJobs()).toMatchObject({ succeeded: 1 });
    expect(completion.extractionCalls).toHaveLength(0);
  });

  it('splits long transcripts into windows', async () => {
    const { memnest, completion } = setup(() => ({ candidates: [] }), { windowTokens: 60 });
    const turns = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `Paragraph ${i} describes the payments dashboard in some detail.` }));
    await memnest.add({ containerTag: user.containerTag, content: turns, extraction: 'instant' });
    await memnest.processDueJobs();
    expect(completion.extractionCalls.length).toBeGreaterThan(1);
    const all = completion.extractionCalls.map((call) => call.messages[0]!.content).join('\n');
    for (let i = 0; i < 12; i++) expect(all).toContain(`Paragraph ${i} `);
  });

  it('requires a completion provider to process jobs', async () => {
    const memnest = createMemnest({ store: createInMemoryStore() });
    expect(() => memnest.startWorker()).toThrow(ConfigurationError);
    await expect(memnest.processDueJobs()).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('processes in the background with startWorker and stops on close', async () => {
    const store = createInMemoryStore();
    const completion = scriptedModel({ extraction: [{ candidates: [c('The user works at Stripe as a product manager.')] }] });
    const memnest = createMemnest({ store, completion, queue: createInMemoryJobQueue({ pollIntervalMs: 5 }) });
    memnest.startWorker();
    await memnest.add({ containerTag: user.containerTag, content: session, extraction: 'instant' });
    for (let i = 0; i < 200 && (await memnest.listMemories(user)).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await memnest.listMemories(user)).toHaveLength(1);
    await memnest.close();
  });
});
