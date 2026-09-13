import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ProviderError,
  createInMemoryJobQueue,
  createMemnest,
  nextProfileState,
  scopeOf,
  type MemnestOptions,
  type ProfilePolicy,
} from '../src/index';
import { createInMemoryStore, fixedClock, hashEmbedder, scriptedModel, sequentialIds, type ScriptedModelScript } from '../src/testing/index';

const user = scopeOf('user:123');
const HOUR = 60 * 60_000;

function setup(overrides: Partial<MemnestOptions> = {}) {
  const store = createInMemoryStore({ vector: true });
  const clock = fixedClock('2026-03-10T09:00:00.000Z');
  const queue = createInMemoryJobQueue({ clock });
  let listCalls = 0;
  const listMemories = store.listMemories;
  store.listMemories = (...args) => {
    listCalls++;
    return listMemories(...args);
  };
  const memnest = createMemnest({ store, clock, queue, ids: sequentialIds(), ...overrides });
  const write = (...contents: string[]) =>
    memnest.addMemories({ containerTag: user.containerTag, memories: contents.map((content) => ({ content, kind: 'fact' as const })) });
  return { store, clock, queue, memnest, write, listCalls: () => listCalls };
}

describe('nextProfileState', () => {
  const policy = (now: string): ProfilePolicy => ({ threshold: 3, staleAfterMs: 24 * HOUR, requeueAfterMs: HOUR / 6, now });

  it('claims a first build, then waits for the threshold or staleness, never claiming twice', () => {
    const t0 = '2026-03-10T09:00:00.000Z';
    const first = nextProfileState(null, 1, policy(t0));
    expect(first).toEqual({ due: true, state: { changesSinceBuild: 1, rebuildQueuedAt: t0 } });
    expect(nextProfileState(first.state, 1, policy(t0)).due).toBe(false);
    // A claim older than requeueAfterMs is assumed lost.
    expect(nextProfileState(first.state, 0, policy('2026-03-10T09:11:00.000Z')).due).toBe(true);

    const built = { changesSinceBuild: 0, builtAt: t0 };
    expect(nextProfileState(built, 2, policy(t0)).due).toBe(false);
    expect(nextProfileState({ ...built, changesSinceBuild: 2 }, 1, policy(t0)).due).toBe(true);
    expect(nextProfileState(built, 0, policy('2026-03-11T09:00:00.000Z')).due).toBe(true);
  });
});

describe('profiles (deterministic builder)', () => {
  it('builds on first use and renders a prompt-ready profile with provenance', async () => {
    const { memnest } = setup();
    // One write: the first change builds the profile, and later changes wait for the threshold.
    const [stripe, dana] = await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [
        { content: 'The user works at Stripe as a product manager.' },
        { content: 'Dana is the manager of the user.' },
        { content: 'The user has a dentist appointment on 2026-03-11.', kind: 'episode', validUntil: '2026-03-11T23:59:59.000Z' },
      ],
    });

    const profile = await memnest.profile(user);
    expect(profile).toMatchObject({ builder: 'deterministic', memoryCount: 3, stale: false, builtAt: '2026-03-10T09:00:00.000Z' });
    expect(profile.stable.map((i) => [i.text, i.memoryIds])).toEqual([
      ['The user works at Stripe as a product manager.', [stripe!.id]],
      ['Dana is the manager of the user.', [dana!.id]],
    ]);
    expect(profile.recent).toEqual([
      { text: 'The user has a dentist appointment on 2026-03-11.', memoryIds: [expect.any(String)], expiresAt: '2026-03-11T23:59:59.000Z' },
    ]);
    expect(profile.text).toBe(
      [
        'About the user:',
        '- The user works at Stripe as a product manager.',
        '- Dana is the manager of the user.',
        '',
        'Recent activity:',
        '- The user has a dentist appointment on 2026-03-11.',
      ].join('\n'),
    );
    expect(profile.tokens).toBeGreaterThan(0);
  });

  it('serves from cache, and rebuilds only after the change threshold or when stale', async () => {
    const { memnest, write, clock, listCalls } = setup({ profile: { rebuildAfterChanges: 5 } });
    await write('The user likes tea.');
    const built = await memnest.profile(user);
    const reads = listCalls();

    for (let i = 0; i < 20; i++) expect((await memnest.profile(user)).builtAt).toBe(built.builtAt);
    expect(listCalls()).toBe(reads);

    clock.advance(HOUR);
    await write('One.', 'Two.', 'Three.', 'Four.');
    expect((await memnest.profile(user)).builtAt).toBe(built.builtAt);
    await write('The user likes coffee too.');
    const rebuilt = await memnest.profile(user);
    expect(rebuilt.builtAt).toBe('2026-03-10T10:00:00.000Z');
    expect(rebuilt.memoryCount).toBe(6);

    clock.advance(25 * HOUR);
    const stale = await memnest.profile(user);
    expect(stale.builtAt).toBe('2026-03-11T11:00:00.000Z');
    expect(stale.stale).toBe(false);
  });

  it('never serves a forgotten or superseded fact, even before the next rebuild', async () => {
    const { memnest, write } = setup({ profile: { rebuildAfterChanges: 100 } });
    const [postgres, wrong] = await write('The payments service of the user runs on Postgres.', 'The user is allergic to databases.');
    expect((await memnest.profile(user)).stable).toHaveLength(2);

    await memnest.forget(user, wrong!.id);
    let profile = await memnest.profile(user);
    expect(profile.text).not.toContain('allergic');
    expect(profile.stable.map((i) => i.memoryIds)).toEqual([[postgres!.id]]);

    await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [{ content: 'The payments service of the user runs on MySQL.', supersedes: postgres!.id }],
    });
    profile = await memnest.profile(user);
    expect(profile.text).not.toContain('Postgres');
    expect(profile.stale).toBe(false);
    expect((await memnest.rebuildProfile(user)).text).toContain('MySQL');
  });

  it('hides expired items at read time without rebuilding', async () => {
    const { memnest, clock, listCalls } = setup({ profile: { staleAfterMs: 30 * 24 * HOUR } });
    await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [
        { content: 'The user is on vacation until Friday.', kind: 'episode', validUntil: '2026-03-13T23:59:59.000Z' },
        { content: 'The user lives in Seattle.' },
      ],
    });
    expect((await memnest.profile(user)).text).toContain('vacation');
    const reads = listCalls();
    clock.advance(4 * 24 * HOUR);
    const later = await memnest.profile(user);
    expect(later.text).not.toContain('vacation');
    expect(later.text).toContain('Seattle');
    expect(listCalls()).toBe(reads);
  });

  it('respects the token budget and item caps', async () => {
    const { memnest, write } = setup({ profile: { maxTokens: 40, maxStable: 3 } });
    await write(...Array.from({ length: 10 }, (_, i) => `The user fact number ${i} is a moderately long sentence.`));
    const profile = await memnest.rebuildProfile(user);
    expect(profile.stable.length).toBeLessThanOrEqual(3);
    expect(profile.tokens).toBeLessThanOrEqual(40 + 10);
  });

  it('is deleted with its container', async () => {
    const { memnest, write, store } = setup();
    await write('The user likes tea.');
    await memnest.profile(user);
    await memnest.deleteContainer(user);
    expect(await store.getProfile(user)).toBeNull();
    expect(await memnest.profile(user)).toMatchObject({ builtAt: expect.any(String), stable: [], memoryCount: 0 });
  });
});

describe('profiles (LLM builder)', () => {
  const llm = (script: ScriptedModelScript = {}) => {
    const completion = scriptedModel({ extraction: [], ...script });
    return { completion, ...setup({ completion }) };
  };

  it('queues the rebuild for the worker instead of calling the model on a write', async () => {
    const { memnest, write, queue, completion } = llm();
    const [tea] = await write('The user likes green tea.', 'The user lives in Seattle.');
    await write('The user runs on weekends.');

    expect(completion.profileCalls).toHaveLength(0);
    expect(queue.list(user).filter((r) => r.job.type === 'profile')).toHaveLength(1);
    expect(await memnest.profile(user)).toMatchObject({ builtAt: null, builder: 'none', stale: true, text: '' });
    expect(queue.list(user).filter((r) => r.job.type === 'profile')).toHaveLength(1);

    expect(await memnest.processDueJobs()).toMatchObject({ succeeded: 1 });
    expect(completion.profileCalls).toHaveLength(1);
    expect(completion.profileCalls[0]!.messages[0]!.content).toMatch(/^m1 \[fact, since 2026-03-10\] The user likes green tea\.$/m);
    const profile = await memnest.profile(user);
    expect(profile).toMatchObject({ builder: 'llm', memoryCount: 3, stale: false });
    expect(profile.stable[0]).toEqual({ text: 'The user likes green tea.', memoryIds: [tea!.id] });
  });

  it('drops items without valid citations, with pronouns or secrets, and keeps the rest', async () => {
    const { memnest, write } = llm({
      profile: () => ({
        stable: [
          { text: 'The user likes green tea and lives in Seattle.', memoryIds: ['m1', 'M2', '99'] },
          { text: 'The user has a cat named Mochi.', memoryIds: [] },
          { text: 'She loves the rain there.', memoryIds: ['m2'] },
          { text: 'The user password is hunter2 for the staging box.', memoryIds: ['m1'] },
        ],
        recent: [{ text: 'The user started running on weekends.', memoryIds: ['m3'] }],
      }),
    });
    const [tea, seattle, running] = await write('The user likes green tea.', 'The user lives in Seattle.', 'The user runs on weekends.');
    const profile = await memnest.rebuildProfile(user);
    expect(profile.stable).toEqual([{ text: 'The user likes green tea and lives in Seattle.', memoryIds: [tea!.id, seattle!.id] }]);
    expect(profile.recent).toEqual([{ text: 'The user started running on weekends.', memoryIds: [running!.id] }]);
  });

  it('falls back to the deterministic builder when the model fails or says nothing usable', async () => {
    for (const reply of [() => new ProviderError('p', 'HTTP 503', { retryable: true }), () => ({ stable: [{ text: 'He is nice.', memoryIds: ['m1'] }], recent: [] })]) {
      const { memnest, write, store } = llm({ profile: reply });
      await write('The user likes green tea.');
      const profile = await memnest.rebuildProfile(user);
      expect(profile).toMatchObject({ builder: 'deterministic', stable: [{ text: 'The user likes green tea.' }] });
      expect((await store.getProfile(user))!.buildNote).toMatch(/model build failed: p: HTTP 503|no usable profile items/);
    }
  });
});

describe('backfillEmbeddings', () => {
  it('embeds rows written before an embedder existed, once', async () => {
    const store = createInMemoryStore({ vector: true });
    const before = createMemnest({ store, profile: { builder: 'deterministic' } });
    await before.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user likes green tea.' }, { content: 'The user lives in Seattle.' }] });
    await before.add({ containerTag: user.containerTag, content: 'Notes about tea brewing.', extraction: 'none' });
    await expect(before.backfillEmbeddings(user)).rejects.toBeInstanceOf(ConfigurationError);

    const embedder = hashEmbedder();
    const after = createMemnest({ store, embedder });
    expect((await after.search('green tea', user)).trace.degraded).toBe('lexical-only: container has no embeddings yet');
    expect(await after.backfillEmbeddings(user, { batchSize: 1 })).toEqual({ memories: 2, chunks: 1 });
    expect(await after.backfillEmbeddings(user)).toEqual({ memories: 0, chunks: 0 });

    const { trace } = await after.search('green tea', user);
    expect(trace.degraded).toBeUndefined();
    expect(trace.candidates[0]).toMatchObject({ vectorRank: 1, lexicalRank: 1 });
  });
});
