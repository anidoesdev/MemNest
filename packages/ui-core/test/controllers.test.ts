import { createMemnest, scopeOf, type Memnest, type SearchResponse } from '@memnest/core';
import { createInMemoryStore, fixedClock, sequentialIds, type FixedClock } from '@memnest/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTimeline, buildTraceRows, createWorkspace, versionChain, type Observable, type Workspace } from '../src/index';

const USER = 'user:123';
const DAY = 86_400_000;

/** Resolves once the observable's state satisfies the predicate. */
function until<S>(observable: Observable<S>, predicate: (state: S) => boolean, timeoutMs = 5000): Promise<S> {
  return new Promise((resolve, reject) => {
    if (predicate(observable.getState())) return resolve(observable.getState());
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out; last state: ${JSON.stringify(observable.getState()).slice(0, 300)}`));
    }, timeoutMs);
    const unsubscribe = observable.subscribe(() => {
      if (!predicate(observable.getState())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(observable.getState());
    });
  });
}

/** The Definition of Done story, via direct writes. */
async function seedDoD(memnest: Memnest, clock: FixedClock) {
  const [postgres] = await memnest.addMemories({
    containerTag: USER,
    memories: [{ content: 'The user prefers Postgres over MongoDB as the database for the payments service.', kind: 'preference' }],
  });
  const [wrong] = await memnest.addMemories({ containerTag: USER, memories: [{ content: 'The user dislikes every database.' }] });
  clock.advance(7 * DAY);
  const [mysql] = await memnest.addMemories({
    containerTag: USER,
    memories: [{ content: 'The user moved the payments service database to MySQL.', supersedes: postgres!.id }],
  });
  const [team] = await memnest.addMemories({ containerTag: USER, memories: [{ content: 'The payments team runs MySQL with two replicas.', extendsIds: [mysql!.id] }] });
  return { postgres: postgres!, mysql: mysql!, wrong: wrong!, team: team! };
}

describe('pure view models', () => {
  it('draws the budget line above the first candidate the budget cut', () => {
    const memory = (id: string) => ({ id, content: `content of ${id}`, kind: 'fact' }) as never;
    const response = {
      memories: [],
      chunks: [],
      trace: {
        query: 'q',
        budget: { limit: 30, used: 25 },
        timings: {},
        candidates: [
          { memoryId: 'm1', rrfScore: 0.03, included: true, tokens: 10 },
          { memoryId: 'm2', rrfScore: 0.02, included: false, excludedReason: 'not-latest', tokens: 50 },
          { memoryId: 'm3', rrfScore: 0.02, included: true, tokens: 15 },
          { memoryId: 'm4', rrfScore: 0.01, included: false, excludedReason: 'budget', tokens: 40 },
          { memoryId: 'm5', rrfScore: 0.01, included: false, excludedReason: 'budget', tokens: 12 },
        ],
      },
    } as unknown as SearchResponse;
    const { rows, budgetLine } = buildTraceRows(response, new Map(['m1', 'm2', 'm3', 'm4'].map((id) => [id, memory(id)])));
    expect(budgetLine).toBe(3);
    expect(rows.map((r) => r.cumulativeTokens)).toEqual([10, 10, 25, 25, 25]);
    expect(rows[0]!.content).toBe('content of m1');
    expect(rows[4]!.content).toBeNull();
    expect(buildTraceRows({ ...response, trace: { ...response.trace, candidates: response.trace.candidates.slice(0, 3) } }, new Map()).budgetLine).toBeNull();
  });

  it('builds a timeline where a superseded fact ends when its replacement begins', () => {
    const base = { containerTag: USER, confidence: 1, extendsIds: [], sourceDocumentIds: ['d'], extractionRunId: 'r', reinforcementCount: 1 };
    const google = { ...base, id: 'g', content: 'Alex works at Google.', kind: 'fact', isLatest: false, version: 1, validFrom: '2025-06-01T00:00:00.000Z', createdAt: '2025-06-01T00:00:00.000Z' };
    const stripe = { ...base, id: 's', content: 'Alex works at Stripe.', kind: 'fact', isLatest: true, version: 2, supersedes: 'g', validFrom: '2026-03-01T00:00:00.000Z', createdAt: '2026-03-02T00:00:00.000Z' };
    const meeting = { ...base, id: 'm', content: 'Standup at 3pm.', kind: 'episode', isLatest: true, version: 1, validFrom: '2026-03-05T09:00:00.000Z', validUntil: '2026-03-05T15:00:00.000Z', createdAt: '2026-03-05T09:00:00.000Z' };
    const oldTea = { ...base, id: 't', content: 'Alex drinks tea.', kind: 'preference', isLatest: true, version: 1, validFrom: '2026-01-01T00:00:00.000Z', forgottenAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };
    const timeline = buildTimeline([stripe, google, meeting, oldTea] as never, '2026-04-01T00:00:00.000Z');

    const job = timeline.lanes.find((l) => l.items.some((i) => i.memory.id === 'g'))!;
    expect(job.label).toBe('Alex works at Stripe.');
    expect(job.items.map((i) => [i.memory.id, i.status, i.start, i.end])).toEqual([
      ['g', 'superseded', '2025-06-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
      ['s', 'current', '2026-03-01T00:00:00.000Z', null],
    ]);
    expect(job.items[0]!.supersededBy).toBe('s');
    expect(timeline.lanes.flatMap((l) => l.items).find((i) => i.memory.id === 'm')).toMatchObject({ status: 'expired', end: '2026-03-05T15:00:00.000Z' });
    expect(timeline.lanes.flatMap((l) => l.items).find((i) => i.memory.id === 't')).toMatchObject({ status: 'forgotten', end: '2026-02-01T00:00:00.000Z' });
    expect(timeline.lanes[0]!.items[0]!.memory.id).toBe('g');
    expect(timeline.range!.start < '2025-06-01T00:00:00.000Z').toBe(true);
    expect(timeline.ticks).toHaveLength(6);
    expect(timeline.ticks[0]!.label).toMatch(/2025/);
  });

  it('orders a version chain oldest first from any member', () => {
    const m = (id: string, supersedes?: string, version = 1) => ({ id, supersedes, version }) as never;
    const graph = { rootId: 'b', memories: [m('c', 'b', 3), m('a'), m('b', 'a', 2)], documents: [], edges: [] };
    expect(versionChain(graph, 'b').map((x: { id: string }) => x.id)).toEqual(['a', 'b', 'c']);
    expect(versionChain(graph, 'c').map((x: { id: string }) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('workspace over the engine', () => {
  let memnest: Memnest;
  let clock: FixedClock;
  let ws: Workspace;
  let seeded: Awaited<ReturnType<typeof seedDoD>>;

  beforeEach(async () => {
    clock = fixedClock('2026-03-01T09:00:00.000Z');
    memnest = createMemnest({ store: createInMemoryStore(), clock, ids: sequentialIds(), profile: { builder: 'deterministic' } });
    seeded = await seedDoD(memnest, clock);
    ws = createWorkspace({ client: memnest, containerTag: USER, now: clock.now });
  });

  afterEach(() => ws.dispose());

  it('finds a wrong memory, shows its detail, forgets it after confirmation, and every view follows', async () => {
    await until(ws.graph, (s) => s.status === 'ready');
    expect(ws.graph.getState().nodes).toHaveLength(4);

    ws.trace.setQuery('database');
    ws.trace.setTokenBudget(2000);
    await ws.trace.run();
    ws.finder.setQuery('database');
    await ws.finder.run();
    expect(ws.finder.getState().items.map((m) => m.id)).toContain(seeded.wrong.id);

    ws.select(seeded.wrong.id);
    const detail = await until(ws.detail, (s) => s.status === 'ready');
    expect(detail.memory!.content).toBe('The user dislikes every database.');
    expect(detail.sources).toHaveLength(1);
    expect(ws.graph.getState().selectedId).toBe(seeded.wrong.id);

    // Two steps: nothing is forgotten until confirmed.
    ws.detail.requestForget();
    expect(ws.detail.getState().forget).toBe('confirming');
    ws.detail.cancelForget();
    expect((await memnest.getMemory(scopeOf(USER), seeded.wrong.id))!.forgottenAt).toBeUndefined();

    ws.detail.requestForget();
    await ws.detail.confirmForget();
    expect(ws.detail.getState().memory!.forgottenAt).toBeDefined();

    await until(ws.trace, (s) => s.rows.some((r) => r.memoryId === seeded.wrong.id && r.excludedReason === 'forgotten'));
    await until(ws.finder, (s) => s.status === 'ready' && !s.items.some((m) => m.id === seeded.wrong.id));
    await until(ws.graph, (s) => s.status === 'ready' && !s.nodes.some((n) => n.id === seeded.wrong.id));
    ws.graph.setFilter({ includeForgotten: true });
    const withForgotten = await until(ws.graph, (s) => s.status === 'ready' && s.nodes.some((n) => n.id === seeded.wrong.id));
    expect(withForgotten.nodes.find((n) => n.id === seeded.wrong.id)!.forgotten).toBe(true);
  });

  it('shows the MySQL memory’s lineage: it supersedes Postgres, and both trace back to documents', async () => {
    ws.select(seeded.mysql.id);
    const lineage = await until(ws.lineage, (s) => s.status === 'ready');
    const ids = lineage.graph!.memories.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([seeded.mysql.id, seeded.postgres.id, seeded.team.id]));
    expect(lineage.graph!.edges).toContainEqual({ from: seeded.mysql.id, to: seeded.postgres.id, relation: 'updates' });
    expect(lineage.positions.get(seeded.postgres.id)!.x).toBeGreaterThan(lineage.positions.get(seeded.mysql.id)!.x);
    expect(lineage.graph!.documents).toHaveLength(3);

    const detail = await until(ws.detail, (s) => s.status === 'ready');
    expect(detail.versions.map((v) => v.id)).toEqual([seeded.postgres.id, seeded.mysql.id]);
    expect(detail.extendedBy.map((m) => m.id)).toEqual([seeded.team.id]);
    await ws.detail.loadSource(detail.sources[0]!.document.id);
    // A direct write's source document holds the text itself; it has no chunks.
    expect(ws.detail.getState().sources[0]).toMatchObject({ content: seeded.mysql.content, chunks: [], loading: false });

    await ws.graph.expandLineage(seeded.mysql.id);
    expect([...ws.graph.getState().lineage!.memoryIds].sort()).toEqual([seeded.mysql.id, seeded.postgres.id, seeded.team.id].sort());
  });

  it('shows the database switch on the timeline, with the date it happened', async () => {
    ws.timeline.setTopic('payments database');
    await ws.timeline.run();
    const { lanes } = ws.timeline.getState();
    const lane = lanes.find((l) => l.items.some((i) => i.memory.id === seeded.mysql.id))!;
    expect(lane.items.map((i) => [i.memory.id, i.status])).toEqual([
      [seeded.postgres.id, 'superseded'],
      [seeded.mysql.id, 'current'],
    ]);
    expect(lane.items[0]!.end).toBe('2026-03-08T09:00:00.000Z');
    expect(lane.items[1]!.start).toBe('2026-03-08T09:00:00.000Z');
  });

  it('explains a 200-token recall: MySQL included, Postgres excluded as not-latest', async () => {
    ws.trace.setQuery('what database does this user use?');
    ws.trace.setTokenBudget(200);
    await ws.trace.run();
    const { rows, response } = ws.trace.getState();
    expect(response!.trace.budget.limit).toBe(200);
    expect(rows.find((r) => r.memoryId === seeded.mysql.id)).toMatchObject({ included: true, content: seeded.mysql.content });
    expect(rows.find((r) => r.memoryId === seeded.postgres.id)).toMatchObject({ included: false, excludedReason: 'not-latest', content: seeded.postgres.content });
  });

  it('ignores responses that arrive after a newer request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { ...memnest, getLineage: async (...args: Parameters<Memnest['getLineage']>) => (await gate, memnest.getLineage(...args)) };
    const slowWs = createWorkspace({ client: slow, containerTag: USER, graph: { autoload: false } });
    const first = slowWs.lineage.load(seeded.postgres.id);
    const second = slowWs.lineage.load(seeded.team.id);
    release();
    await Promise.all([first, second]);
    expect(slowWs.lineage.getState().rootId).toBe(seeded.team.id);
    expect(slowWs.lineage.getState().graph!.rootId).toBe(seeded.team.id);
    slowWs.dispose();
  });
});
