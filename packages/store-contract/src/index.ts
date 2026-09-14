import {
  ConfigurationError,
  EmbeddingProviderMismatchError,
  createInMemoryJobQueue,
  createMemnest,
  MemnestError,
  NotImplementedError,
  ProviderError,
  scopeOf,
  type Document,
  type Memory,
  type MemoryStore,
  type MemoryStoreOps,
  type Memnest,
  type Scope,
} from '@memnest/core';
import {
  CREDENTIAL_FIXTURES,
  credentialTranscript,
  fixedClock,
  hashEmbedder,
  scriptedModel,
  sequentialIds,
  type FixedClock,
} from '@memnest/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export { defineAuthStoreContract, type AuthStoreHarness } from './auth';

const EMBEDDER = hashEmbedder();

export interface StoreHarness {
  store: MemoryStore;
  /** Closes the store and returns every persisted byte, decoded as text. */
  closeAndDump(): Promise<string>;
  cleanup?(): Promise<void>;
}

const DAY = 24 * 60 * 60 * 1000;

async function expectRejectsWithin(promise: Promise<unknown>, codes: string[]): Promise<null> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'expected the operation to be rejected').toBeInstanceOf(MemnestError);
  expect(codes).toContain((error as MemnestError).code);
  return null;
}

/** The Definition of Done scenario, via direct writes (extraction arrives in M2). */
async function seedDatabaseSwitch(memnest: Memnest, clock: FixedClock, containerTag: string) {
  const [postgres] = await memnest.addMemories({
    containerTag,
    memories: [
      {
        content: 'The user prefers Postgres over MongoDB as the database for the payments service.',
        kind: 'preference',
        confidence: 0.9,
      },
    ],
  });
  clock.advance(7 * DAY);
  const [mysql] = await memnest.addMemories({
    containerTag,
    memories: [
      {
        content: 'The user moved the payments service database from Postgres to MySQL.',
        confidence: 0.95,
        supersedes: postgres!.id,
      },
    ],
  });
  return { postgres: postgres!, mysql: mysql! };
}

export function defineStoreContract(name: string, createHarness: () => Promise<StoreHarness>): void {
  describe(`MemoryStore contract: ${name}`, () => {
    let harness: StoreHarness;
    let store: MemoryStore;
    let clock: FixedClock;
    let memnest: Memnest;
    const user = scopeOf('user:123');
    /** Vector-capable stores run the whole contract with embeddings on. */
    const embedding = () => (store.capabilities().vector ? { embedder: EMBEDDER } : {});

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
      clock = fixedClock('2026-03-01T09:00:00.000Z');
      memnest = createMemnest({ store, clock, ids: sequentialIds(), ...embedding() });
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    describe('ingest', () => {
      const transcript = [
        { role: 'user', content: 'I am building a payments service and I prefer Postgres over MongoDB.' },
        { role: 'assistant', content: 'Postgres is a solid choice for payments.' },
      ];

      it('returns at indexed, enqueues extraction, and serves chunks immediately', async () => {
        const result = await memnest.add({ containerTag: user.containerTag, content: transcript });
        expect(result).toMatchObject({ status: 'indexed', version: 1, deduplicated: false });
        expect(result.jobId).toBeDefined();

        const chunks = await memnest.searchDocuments('payments service Postgres', user);
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]!.chunk.documentId).toBe(result.documentId);

        const stored = await memnest.getDocument(user, result.documentId);
        expect(stored?.document.kind).toBe('conversation');
        expect(stored?.chunks.map((c) => c.index)).toEqual(stored?.chunks.map((_, i) => i));
      });

      it("enqueues nothing with extraction 'none'", async () => {
        const result = await memnest.add({ containerTag: user.containerTag, content: 'Plain note.', extraction: 'none' });
        expect(result.jobId).toBeUndefined();
      });

      it('treats the same customId and content as a no-op', async () => {
        const first = await memnest.add({ containerTag: user.containerTag, customId: 'session-1', content: transcript });
        const second = await memnest.add({ containerTag: user.containerTag, customId: 'session-1', content: transcript });
        expect(second).toMatchObject({ documentId: first.documentId, deduplicated: true, version: 1 });
        expect(await store.findDocuments(user, {})).toHaveLength(1);
      });

      it('versions a document when a customId comes back with new content', async () => {
        const first = await memnest.add({
          containerTag: user.containerTag,
          customId: 'notes',
          content: 'Original zebracorn draft.',
          extraction: 'none',
        });
        const second = await memnest.add({
          containerTag: user.containerTag,
          customId: 'notes',
          content: 'Revised narwhal draft.',
          extraction: 'none',
        });
        expect(second).toMatchObject({ version: 2, deduplicated: false });
        const [previous, current] = await Promise.all([
          store.getDocument(user, first.documentId),
          store.getDocument(user, second.documentId),
        ]);
        expect(previous?.isLatest).toBe(false);
        expect(current).toMatchObject({ isLatest: true, previousVersionId: first.documentId });
        expect(await memnest.searchDocuments('zebracorn', user)).toHaveLength(0);
        expect(await memnest.searchDocuments('narwhal', user)).toHaveLength(1);
      });

      it('dedupes identical content without a customId', async () => {
        const first = await memnest.add({ containerTag: user.containerTag, content: 'Same words.' });
        const second = await memnest.add({ containerTag: user.containerTag, content: 'Same words.' });
        expect(second).toMatchObject({ documentId: first.documentId, deduplicated: true });
      });

      it('rejects invalid input', async () => {
        await expectRejectsWithin(memnest.add({ containerTag: '', content: 'x' }), ['validation']);
        await expectRejectsWithin(memnest.add({ containerTag: 'user:1', content: '   ' }), ['validation']);
        await expectRejectsWithin(
          memnest.add({ containerTag: 'user:1', content: 'x', documentDate: 'last tuesday' }),
          ['validation'],
        );
      });
    });

    describe('recall', () => {
      it('returns what is true now, inside the budget, with the superseded fact traced as not-latest', async () => {
        const { postgres, mysql } = await seedDatabaseSwitch(memnest, clock, user.containerTag);

        const { memories, trace } = await memnest.search('what database does this user use?', user, { tokenBudget: 200 });

        expect(memories.map((m) => m.memory.id)).toEqual([mysql.id]);
        expect(trace.degraded).toBe(store.capabilities().vector ? undefined : 'lexical-only');
        expect(trace.budget.limit).toBe(200);
        expect(trace.budget.used).toBeLessThanOrEqual(200);
        expect(trace.candidates.find((c) => c.memoryId === postgres.id)).toMatchObject({
          included: false,
          excludedReason: 'not-latest',
        });
        const included = trace.candidates.find((c) => c.memoryId === mysql.id)!;
        expect(included).toMatchObject({ included: true, lexicalRank: expect.any(Number) });
        expect(included.tokens).toBeGreaterThan(0);
        expect(included.excludedReason).toBeUndefined();
        expect(trace.timings.total).toBeGreaterThanOrEqual(0);
      });

      it('stops serving a forgotten memory and says so in the trace', async () => {
        const [wrong] = await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'The user is allergic to databases.' }],
        });
        await memnest.forget(user, wrong!.id);

        const { memories, trace } = await memnest.search('user databases', user);
        expect(memories).toHaveLength(0);
        expect(trace.candidates).toEqual([expect.objectContaining({ memoryId: wrong!.id, excludedReason: 'forgotten' })]);
        expect((await memnest.getMemory(user, wrong!.id))?.forgottenAt).toBe(clock.now());
      });

      it('expires time-bound memories against the injected clock', async () => {
        const [meeting] = await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'The user has a design review meeting at 3pm today.', validUntil: '2026-03-01T15:00:00.000Z' }],
        });
        expect((await memnest.searchMemories('design review meeting', user)).map((m) => m.memory.id)).toEqual([meeting!.id]);

        clock.advance(2 * DAY);
        const { memories, trace } = await memnest.search('design review meeting', user);
        expect(memories).toHaveLength(0);
        expect(trace.candidates[0]).toMatchObject({ memoryId: meeting!.id, excludedReason: 'expired' });
      });

      it('packs by token budget, highest value first, never exceeding the limit', async () => {
        await memnest.addMemories({
          containerTag: user.containerTag,
          memories: Array.from({ length: 12 }, (_, i) => ({
            content: `Coffee fact ${i}: the user drinks coffee ${'very '.repeat(i)}often.`,
          })),
        });
        const { memories, trace } = await memnest.search('coffee', user, { tokenBudget: 60, candidates: 20 });
        expect(memories.length).toBeGreaterThan(0);
        expect(trace.budget.used).toBeLessThanOrEqual(60);
        expect(trace.budget.used).toBe(memories.reduce((sum, m) => sum + m.tokens, 0));
        expect(trace.candidates.some((c) => c.excludedReason === 'budget')).toBe(true);
        for (const c of trace.candidates) expect(c.included).toBe(c.excludedReason === undefined);
        const scores = memories.map((m) => m.score);
        expect(scores).toEqual([...scores].sort((a, z) => z - a));
      });

      it('keeps chunks and memories on separate surfaces', async () => {
        await memnest.add({ containerTag: user.containerTag, content: 'Kayaking notes from the river trip.', extraction: 'none' });
        await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user enjoys kayaking.' }] });
        expect(await memnest.searchMemories('kayaking', user)).toHaveLength(1);
        expect(await memnest.searchDocuments('kayaking', user)).toHaveLength(1);
        const both = await memnest.search('kayaking', user);
        expect([both.memories.length, both.chunks.length]).toEqual([1, 1]);
      });

      it('finds the relevant memory among 1,000 irrelevant ones', async () => {
        const colors = ['red', 'blue', 'green', 'amber', 'violet'];
        const objects = ['kettle', 'bicycle', 'lantern', 'notebook', 'umbrella', 'guitar'];
        const places = ['garage', 'attic', 'hallway', 'basement', 'garden shed'];
        const noise = Array.from({ length: 1000 }, (_, i) => ({
          content: `Note ${i}: the ${colors[i % 5]} ${objects[i % 6]} is kept in the ${places[i % 5]}.`,
        }));
        await memnest.addMemories({ containerTag: user.containerTag, memories: noise.slice(0, 500) });
        const [relevant] = await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'Alex works at Stripe as a product manager.' }],
        });
        await memnest.addMemories({ containerTag: user.containerTag, memories: noise.slice(500) });

        const top = await memnest.searchMemories('which company does Alex work at?', user, { candidates: 5 });
        expect(top.slice(0, 5).map((m) => m.memory.id)).toContain(relevant!.id);
      }, 60_000);
    });

    describe('relations and lineage', () => {
      it('records updates and source documents in the lineage DAG, from either end', async () => {
        const { postgres, mysql } = await seedDatabaseSwitch(memnest, clock, user.containerTag);
        expect(mysql).toMatchObject({ version: 2, supersedes: postgres.id, isLatest: true });
        expect((await memnest.getMemory(user, postgres.id))?.isLatest).toBe(false);

        for (const root of [mysql.id, postgres.id]) {
          const lineage = (await memnest.getLineage(user, root))!;
          expect(lineage.rootId).toBe(root);
          expect(lineage.memories.map((m) => m.id).sort()).toEqual([postgres.id, mysql.id].sort());
          expect(lineage.edges).toContainEqual({ from: mysql.id, to: postgres.id, relation: 'updates' });
          const docIds = [...postgres.sourceDocumentIds, ...mysql.sourceDocumentIds];
          expect(lineage.documents.map((d) => d.id).sort()).toEqual([...docIds].sort());
          for (const m of [postgres, mysql]) {
            expect(lineage.edges).toContainEqual({ from: m.id, to: m.sourceDocumentIds[0], relation: 'source' });
          }
        }
      });

      it('records extends edges without invalidating the extended memory', async () => {
        const [role] = await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'Alex is a PM at Stripe.' }],
        });
        const [team] = await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'Alex manages a team of six engineers at Stripe.', extendsIds: [role!.id] }],
        });
        expect((await memnest.getMemory(user, role!.id))?.isLatest).toBe(true);
        expect((await memnest.getLineage(user, role!.id))?.edges).toContainEqual({
          from: team!.id,
          to: role!.id,
          relation: 'extends',
        });
        expect((await memnest.graph(user)).edges).toEqual([{ from: team!.id, to: role!.id, relation: 'extends' }]);
      });

      it('refuses to supersede a superseded memory and writes nothing', async () => {
        const { postgres } = await seedDatabaseSwitch(memnest, clock, user.containerTag);
        const documentsBefore = (await store.findDocuments(user, {})).length;
        const memoriesBefore = (await memnest.listMemories(user)).length;

        await expectRejectsWithin(
          memnest.addMemories({
            containerTag: user.containerTag,
            memories: [{ content: 'Fine first memory.' }, { content: 'The user uses SQLite.', supersedes: postgres.id }],
          }),
          ['validation'],
        );
        expect(await store.findDocuments(user, {})).toHaveLength(documentsBefore);
        expect(await memnest.listMemories(user)).toHaveLength(memoriesBefore);
      });

      it('returns null lineage for unknown memories', async () => {
        expect(await memnest.getLineage(user, 'mem_missing')).toBeNull();
      });

      it('snapshots the graph with forgotten memories hidden by default', async () => {
        const { postgres, mysql } = await seedDatabaseSwitch(memnest, clock, user.containerTag);
        const [noise] = await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'Wrong fact.' }] });
        await memnest.forget(user, noise!.id);

        const snapshot = await memnest.graph(user);
        expect(snapshot).toMatchObject({ containerTag: user.containerTag, totalMemories: 3, truncated: false });
        expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([postgres.id, mysql.id].sort());
        expect(snapshot.nodes.find((n) => n.id === postgres.id)).toMatchObject({ isLatest: false, forgotten: false });
        expect(snapshot.edges).toEqual([{ from: mysql.id, to: postgres.id, relation: 'updates' }]);

        expect((await memnest.graph(user, { includeForgotten: true })).nodes).toHaveLength(3);
        expect((await memnest.graph(user, { includeSuperseded: false })).nodes.map((n) => n.id)).toEqual([mysql.id]);
        const limited = await memnest.graph(user, { limit: 1 });
        expect(limited).toMatchObject({ truncated: true, edges: [] });
        expect(limited.nodes.map((n) => n.id)).toEqual([mysql.id]);
      });

      it('lists memories with keyset pagination and filters', async () => {
        await seedDatabaseSwitch(memnest, clock, user.containerTag);
        await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'Episode one.', kind: 'episode' }, { content: 'Episode two.', kind: 'episode' }],
        });
        const all = await memnest.listMemories(user, { limit: 10 });
        expect(all).toHaveLength(4);
        const page1 = await memnest.listMemories(user, { limit: 3 });
        const page2 = await memnest.listMemories(user, { limit: 3, after: page1.at(-1)!.id });
        expect([...page1, ...page2].map((m) => m.id)).toEqual(all.map((m) => m.id));
        expect(await memnest.listMemories(user, { limit: 10 }, { kind: 'episode' })).toHaveLength(2);
        expect(await memnest.listMemories(user, { limit: 10 }, { latestOnly: true })).toHaveLength(3);
      });
    });

    describe('provenance', () => {
      it('rejects memories without a source at the store boundary', async () => {
        const orphan: Memory = {
          id: 'mem_orphan',
          containerTag: user.containerTag,
          content: 'No source.',
          kind: 'fact',
          confidence: 1,
          isLatest: true,
          version: 1,
          extendsIds: [],
          sourceDocumentIds: [],
          extractionRunId: 'run_x',
          validFrom: clock.now(),
          reinforcementCount: 1,
          createdAt: clock.now(),
        };
        await expectRejectsWithin(store.putMemories(user, [orphan]), ['provenance']);
        await expectRejectsWithin(
          store.putMemories(user, [{ ...orphan, sourceDocumentIds: ['doc_missing'], extractionRunId: '' }]),
          ['provenance'],
        );
        await expectRejectsWithin(
          store.putMemories(user, [{ ...orphan, sourceDocumentIds: ['doc_missing'] }]),
          ['not_found'],
        );
      });

      it('leaves no memory without a traceable source document and run', async () => {
        await seedDatabaseSwitch(memnest, clock, user.containerTag);
        const [forgotten] = await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'Oops.' }] });
        await memnest.forget(user, forgotten!.id);
        await memnest.deleteDocument(user, forgotten!.sourceDocumentIds[0]!);

        const all = await memnest.listMemories(user, { limit: 1000 }, { includeForgotten: true });
        expect(all).toHaveLength(3);
        for (const memory of all) {
          expect(memory.sourceDocumentIds.length).toBeGreaterThan(0);
          expect(memory.extractionRunId).toBeTruthy();
          for (const docId of memory.sourceDocumentIds) expect(await store.getDocument(user, docId)).not.toBeNull();
        }
      });

      it('tombstones deleted documents: content and chunks go, the row stays', async () => {
        const added = await memnest.add({ containerTag: user.containerTag, content: 'Delete me, marmalade.', extraction: 'none' });
        await memnest.deleteDocument(user, added.documentId);
        const tombstone = await store.getDocument(user, added.documentId);
        expect(tombstone).toMatchObject({ content: '', deletedAt: clock.now() });
        expect(await store.getChunks(user, added.documentId)).toEqual([]);
        expect(await memnest.searchDocuments('marmalade', user)).toEqual([]);
        await expectRejectsWithin(memnest.deleteDocument(user, 'doc_missing'), ['not_found']);
      });
    });

    describe('scope is a hard boundary', () => {
      const alpha = scopeOf('user:alpha');
      const bravo = scopeOf('user:bravo');

      interface Fixture {
        a: { memory: Memory; document: Document };
        b: { memory: Memory; superseded: Memory; document: Document; chunkDocumentId: string; ids: string[] };
      }

      async function populate(): Promise<Fixture> {
        const seeded: Record<string, { ids: string[]; memory: Memory; superseded: Memory; document: Document; chunkDocumentId: string }> = {};
        for (const scope of [alpha, bravo]) {
          const marker = scope === alpha ? 'ALPHA' : 'BRAVO';
          const added = await memnest.add({
            containerTag: scope.containerTag,
            customId: 'shared-custom-id',
            content: [
              { role: 'user', content: `${marker} I am building a payments service on Postgres.` },
              { role: 'assistant', content: `${marker} Noted, payments on Postgres.` },
            ],
          });
          const { postgres, mysql } = await seedDatabaseSwitch(memnest, clock, scope.containerTag);
          const [extra] = await memnest.addMemories({
            containerTag: scope.containerTag,
            memories: [{ content: `${marker} payments team has six engineers.`, extendsIds: [mysql.id] }],
          });
          await memnest.forget(scope, extra!.id);
          const document = (await store.getDocument(scope, added.documentId))!;
          const chunks = await store.getChunks(scope, added.documentId);
          const memories = await memnest.listMemories(scope, { limit: 100 }, { includeForgotten: true });
          seeded[marker] = {
            memory: mysql,
            superseded: postgres,
            document,
            chunkDocumentId: added.documentId,
            ids: [
              ...memories.flatMap((m) => [m.id, ...m.sourceDocumentIds, m.extractionRunId]),
              document.id,
              ...chunks.map((c) => c.id),
            ],
          };
        }
        return { a: seeded.ALPHA!, b: seeded.BRAVO! };
      }

      const denied = ['scope_violation', 'not_found'];
      const chunkIdsOf = async (scope: Scope, documentId: string) => (await store.getChunks(scope, documentId)).map((c) => c.id);

      // Keyed by every MemoryStoreOps method: adding a method to the port without a probe here fails typecheck.
      const probes: { [K in keyof MemoryStoreOps]: (f: Fixture) => Promise<unknown> } = {
        putDocument: async (f) => {
          await expectRejectsWithin(store.putDocument(alpha, f.b.document), denied);
          // Re-homing another container's row id under your own tag is also a violation.
          return expectRejectsWithin(store.putDocument(alpha, { ...f.b.document, containerTag: alpha.containerTag }), denied);
        },
        putChunks: async (f) => {
          const [chunk] = await store.getChunks(bravo, f.b.chunkDocumentId);
          await expectRejectsWithin(store.putChunks(alpha, [chunk!]), denied);
          await expectRejectsWithin(
            store.putChunks(alpha, [{ ...chunk!, id: 'chk_new', containerTag: alpha.containerTag }]),
            denied,
          );
          return expectRejectsWithin(store.putChunks(alpha, [{ ...chunk!, containerTag: alpha.containerTag, documentId: f.a.document.id }]), denied);
        },
        putExtractionRun: async (f) =>
          expectRejectsWithin(
            store.putExtractionRun(alpha, {
              id: f.b.memory.extractionRunId,
              containerTag: bravo.containerTag,
              method: 'direct',
              documentIds: [],
              status: 'succeeded',
              startedAt: clock.now(),
            }),
            denied,
          ).then(() =>
            expectRejectsWithin(
              store.putExtractionRun(alpha, {
                id: f.b.memory.extractionRunId,
                containerTag: alpha.containerTag,
                method: 'direct',
                documentIds: [],
                status: 'succeeded',
                startedAt: clock.now(),
              }),
              denied,
            ),
          ),
        putMemories: async (f) => {
          await expectRejectsWithin(store.putMemories(alpha, [f.b.memory]), denied);
          await expectRejectsWithin(
            store.putMemories(alpha, [{ ...f.b.memory, containerTag: alpha.containerTag }]),
            denied,
          );
          return expectRejectsWithin(
            store.putMemories(alpha, [
              { ...f.a.memory, id: 'mem_new', sourceDocumentIds: [f.b.document.id] },
            ]),
            denied,
          );
        },
        supersede: async (f) => expectRejectsWithin(store.supersede(alpha, f.b.superseded.id, f.b.memory.id), denied),
        reinforce: async (f) => {
          await expectRejectsWithin(store.reinforce(alpha, f.b.memory.id, f.a.document.id), denied);
          return expectRejectsWithin(store.reinforce(alpha, f.a.memory.id, f.b.document.id), denied);
        },
        forget: async (f) => expectRejectsWithin(store.forget(alpha, f.b.memory.id, clock.now()), denied),
        getDocument: (f) => store.getDocument(alpha, f.b.document.id),
        findDocuments: async (f) => [
          await store.findDocuments(alpha, { customId: 'shared-custom-id' }),
          await store.findDocuments(alpha, { contentHash: f.b.document.contentHash }),
          await store.findDocuments(alpha, {}),
        ],
        getChunks: (f) => store.getChunks(alpha, f.b.chunkDocumentId),
        deleteDocument: async (f) => expectRejectsWithin(store.deleteDocument(alpha, f.b.document.id, clock.now()), denied),
        getMemory: (f) => store.getMemory(alpha, f.b.memory.id),
        listExtractionRuns: async (f) => [
          await store.listExtractionRuns(alpha, { limit: 1000 }),
          await store.listExtractionRuns(alpha, { limit: 1000, documentId: f.b.document.id }),
          await store.listExtractionRuns(alpha, { limit: 1000, documentId: f.b.memory.sourceDocumentIds[0]! }),
        ],
        lexicalSearch: async () => [
          await store.lexicalSearch('BRAVO payments Postgres MySQL engineers', alpha, { target: 'memories', k: 100 }),
          await store.lexicalSearch('BRAVO payments Postgres', alpha, { target: 'chunks', k: 100 }),
        ],
        vectorSearch: async () => {
          if (!store.capabilities().vector) {
            await expectRejectsWithin(store.vectorSearch(new Float32Array(8), alpha, { target: 'memories', k: 100 }), ['configuration']);
            return null;
          }
          const [query] = await EMBEDDER.embed(['BRAVO payments Postgres MySQL engineers']);
          return [
            await store.vectorSearch(query!, alpha, { target: 'memories', k: 100 }),
            await store.vectorSearch(query!, alpha, { target: 'chunks', k: 100 }),
          ];
        },
        getContainer: () => store.getContainer(alpha),
        listMissingEmbeddings: async () => [
          await store.listMissingEmbeddings(alpha, 'memories', 1000),
          await store.listMissingEmbeddings(alpha, 'chunks', 1000),
        ],
        getProfile: () => store.getProfile(alpha),
        putProfile: async (f) => {
          const bravoProfile = await store.getProfile(bravo);
          expect(bravoProfile, 'populate builds a profile for every container').not.toBeNull();
          await expectRejectsWithin(store.putProfile(alpha, bravoProfile!), denied);
          const alphaProfile = (await store.getProfile(alpha))!;
          return expectRejectsWithin(
            store.putProfile(alpha, { ...alphaProfile, stable: [{ text: 'Cites another container.', memoryIds: [f.b.memory.id] }] }),
            denied,
          );
        },
        noteProfileChanges: () =>
          store.noteProfileChanges(alpha, 50, { threshold: 1, staleAfterMs: 1, requeueAfterMs: 1, now: clock.now() }),
        lockEmbeddingProvider: async () =>
          store.lockEmbeddingProvider(alpha, { id: 'other:3', dimensions: 3 }, clock.now()).catch((e: unknown) => {
            if (e instanceof EmbeddingProviderMismatchError) return null;
            throw e;
          }),
        putEmbeddings: async (f) => {
          const [vector] = await EMBEDDER.embed(['overwrite']);
          const denied = store.capabilities().vector ? ['scope_violation', 'not_found'] : ['configuration'];
          await expectRejectsWithin(store.putEmbeddings(alpha, 'memories', [{ id: f.b.memory.id, embedding: vector! }]), denied);
          const [chunk] = await store.getChunks(bravo, f.b.chunkDocumentId);
          return expectRejectsWithin(store.putEmbeddings(alpha, 'chunks', [{ id: chunk!.id, embedding: vector! }]), denied);
        },
        getLineage: async (f) => [
          await store.getLineage(alpha, f.b.memory.id),
          await store.getLineage(alpha, f.a.memory.id),
        ],
        listMemories: () => store.listMemories(alpha, { limit: 1000 }, { includeForgotten: true }),
        graphSnapshot: () => store.graphSnapshot(alpha, { includeForgotten: true }),
        deleteContainer: async () => {
          await store.deleteContainer(alpha);
          return store.listMemories(alpha, { limit: 1000 }, { includeForgotten: true });
        },
      };

      async function bravoState() {
        const memories = await store.listMemories(bravo, { limit: 1000 }, { includeForgotten: true });
        const documents = await store.findDocuments(bravo, {});
        const chunks = await Promise.all(documents.map((d) => chunkIdsOf(bravo, d.id)));
        const container = await store.getContainer(bravo);
        const profile = await store.getProfile(bravo);
        return JSON.stringify({ memories, documents, chunks, container, profile });
      }

      it.each(Object.keys(probes) as Array<keyof MemoryStoreOps>)('%s never crosses containers', async (method) => {
        const fixture = await populate();
        const before = await bravoState();

        const result = JSON.stringify((await probes[method](fixture)) ?? null);

        expect(result).not.toContain('BRAVO');
        for (const id of fixture.b.ids) expect(result).not.toContain(`"${id}"`);
        expect(await bravoState()).toBe(before);
      });

      it('engine search in one container never returns the other', async () => {
        const fixture = await populate();
        const response = await memnest.search('BRAVO payments Postgres MySQL', alpha, { tokenBudget: 100_000 });
        // The trace echoes the query, so check what was retrieved rather than the whole response.
        const retrieved = JSON.stringify([response.memories, response.chunks, response.trace.candidates]);
        expect(retrieved).not.toContain('BRAVO');
        for (const id of fixture.b.ids) expect(retrieved).not.toContain(`"${id}"`);
        expect(response.memories.length + response.chunks.length).toBeGreaterThan(0);
      });

      it('hard-deletes one container and leaves the other intact', async () => {
        await populate();
        const before = await bravoState();
        await memnest.deleteContainer(alpha);
        expect(await store.findDocuments(alpha, {})).toEqual([]);
        expect(await memnest.listMemories(alpha, { limit: 1000 }, { includeForgotten: true })).toEqual([]);
        expect((await memnest.search('ALPHA payments', alpha)).chunks).toEqual([]);
        expect(await bravoState()).toBe(before);
      });
    });

    describe('transactions', () => {
      it('rolls back every write when the transaction fails', async () => {
        const { documentId } = await memnest.add({ containerTag: user.containerTag, content: 'Keep me.', extraction: 'none' });
        const kept = (await store.getDocument(user, documentId))!;
        await expect(
          store.transaction(async (tx) => {
            await tx.putDocument(user, { ...kept, id: 'doc_rollback' });
            await tx.forget(user, 'mem_missing', clock.now());
          }),
        ).rejects.toThrow();
        expect(await store.getDocument(user, 'doc_rollback')).toBeNull();
      });
    });

    describe('security: secrets never reach storage', () => {
      it('persists zero bytes of any credential fixture', async () => {
        await memnest.add({
          containerTag: user.containerTag,
          customId: 'leaky-session',
          content: credentialTranscript(),
          metadata: { apiToken: CREDENTIAL_FIXTURES[7], source: `export KEY=${CREDENTIAL_FIXTURES[0]}` },
        });
        await memnest.add({
          containerTag: user.containerTag,
          content: `# Setup\n\n\`\`\`\nAWS_SECRET_ACCESS_KEY=${CREDENTIAL_FIXTURES[2]}\npassword: ${CREDENTIAL_FIXTURES[6]}\n\`\`\``,
        });
        await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: `The user's staging token: ${CREDENTIAL_FIXTURES[4]}` }],
          metadata: { note: `Bearer ${CREDENTIAL_FIXTURES[3]}` },
        });

        const persisted = await harness.closeAndDump();
        expect(persisted.length).toBeGreaterThan(0);
        expect(persisted).toContain('Postgres over MongoDB');
        for (const fixture of CREDENTIAL_FIXTURES) expect(persisted).not.toContain(fixture);
      });
    });

    describe('extraction', () => {
      const session = [
        { role: 'user', content: 'I just started at Stripe as a PM. My manager Dana wants me to own the payments dashboard.' },
        { role: 'assistant', content: 'Congratulations!' },
      ];
      const candidate = (content: string, extra: object = {}) => ({ content, kind: 'fact', confidence: 0.9, validUntil: null, ...extra });
      const withCompletion = (extraction: unknown[], resolution?: unknown[]) => {
        const completion = scriptedModel({ extraction, ...(resolution ? { resolution } : {}) });
        const queue = createInMemoryJobQueue({ clock, backoffBaseMs: 1000 });
        return { completion, engine: createMemnest({ store, queue, clock, completion, ids: sequentialIds(), profile: { builder: 'deterministic' }, ...embedding() }) };
      };

      it('turns a batched session into screened memories with full provenance and persisted stats', async () => {
        const { engine, completion } = withCompletion([
          {
            candidates: [
              candidate('The user works at Stripe as a product manager.'),
              candidate('Dana is the manager of the user at Stripe.'),
              candidate('He owns it now.'),
              candidate('The staging token is sk-proj-abcdefghijklmnopqrstu.'),
            ],
          },
        ]);
        const v1 = await engine.add({ containerTag: user.containerTag, customId: 'session', content: session.slice(0, 1) });
        clock.advance(10_000);
        const v2 = await engine.add({ containerTag: user.containerTag, customId: 'session', content: session });
        clock.advance(31_000);

        expect(await engine.processDueJobs()).toMatchObject({ succeeded: 2 });
        expect(completion.extractionCalls).toHaveLength(1);

        const memories = await engine.listMemories(user);
        expect(memories.map((m) => m.content)).toEqual([
          'The user works at Stripe as a product manager.',
          'Dana is the manager of the user at Stripe.',
        ]);
        const runs = await engine.listExtractionRuns(user, { documentId: v1.documentId });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
          status: 'succeeded',
          documentIds: [v1.documentId, v2.documentId],
          stats: { calls: 1, candidates: 4, accepted: 2, created: 2 },
        });
        expect(runs[0]!.stats!.rejected.map((r) => r.reason)).toEqual(['unresolved-pronoun', 'secret']);
        expect(JSON.stringify(runs)).not.toContain('sk-proj-abcdefghijklmnopqrstu');
        for (const m of memories) {
          expect(m.sourceDocumentIds).toEqual([v1.documentId, v2.documentId]);
          expect(m.extractionRunId).toBe(runs[0]!.id);
        }
        for (const id of [v1.documentId, v2.documentId]) expect((await store.getDocument(user, id))?.status).toBe('extracted');
      });

      it('keeps the document searchable and retries after a transient failure', async () => {
        const { engine } = withCompletion([
          new ProviderError('scripted', 'HTTP 503', { status: 503, retryable: true }),
          { candidates: [candidate('The user works at Stripe as a product manager.')] },
        ]);
        const { documentId } = await engine.add({ containerTag: user.containerTag, content: session, extraction: 'instant' });
        expect(await engine.processDueJobs()).toMatchObject({ retried: 1 });
        expect((await store.getDocument(user, documentId))?.status).toBe('failed');
        expect(await engine.searchDocuments('Stripe dashboard', user)).toHaveLength(1);
        expect(await engine.listMemories(user)).toEqual([]);

        clock.advance(1000);
        expect(await engine.processDueJobs()).toMatchObject({ succeeded: 1 });
        expect(await engine.listMemories(user)).toHaveLength(1);
        expect((await engine.listExtractionRuns(user)).map((r) => r.status)).toEqual(['succeeded', 'failed']);
      });

      it('reinforces an exact duplicate instead of writing it again', async () => {
        const { engine } = withCompletion([{ candidates: [candidate('the user prefers postgres over mongodb', { kind: 'preference' })] }]);
        const [existing] = await engine.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'The user prefers Postgres over MongoDB.', kind: 'preference' }],
        });
        const { documentId } = await engine.add({ containerTag: user.containerTag, content: 'I prefer Postgres over MongoDB.', extraction: 'instant' });
        await engine.processDueJobs();
        const memories = await engine.listMemories(user);
        expect(memories).toHaveLength(1);
        expect(memories[0]).toMatchObject({ id: existing!.id, reinforcementCount: 2 });
        expect(memories[0]!.sourceDocumentIds).toEqual([...existing!.sourceDocumentIds, documentId]);
      });
    });

    describe('resolution', () => {
      const say = async (engine: Memnest, text: string) => {
        await engine.add({ containerTag: user.containerTag, content: [{ role: 'user', content: text }], extraction: 'instant' });
        return engine.processDueJobs();
      };
      const withModel = (extraction: unknown[], resolution: unknown[]) => {
        const completion = scriptedModel({ extraction, resolution });
        const queue = createInMemoryJobQueue({ clock });
        return { completion, engine: createMemnest({ store, queue, clock, completion, ids: sequentialIds(), profile: { builder: 'deterministic' }, ...embedding() }) };
      };
      const fact = (content: string, kind = 'fact') => ({ candidates: [{ content, kind, confidence: 0.9, validUntil: null }] });

      it('contradiction: the new fact supersedes the old, which stays traceable as not-latest', async () => {
        const { engine } = withModel(
          [fact('The payments service of the user runs on Postgres.'), fact('The payments service of the user runs on MySQL.')],
          [{ relation: 'updates', memoryId: 'm1', reason: 'Database changed.' }],
        );
        await say(engine, 'Our payments service runs on Postgres.');
        clock.advance(7 * DAY);
        await say(engine, 'We moved the payments service to MySQL.');

        const [postgres, mysql] = await engine.listMemories(user);
        expect(postgres).toMatchObject({ isLatest: false, version: 1 });
        expect(mysql).toMatchObject({ isLatest: true, version: 2, supersedes: postgres!.id });
        const { memories, trace } = await engine.search('what database does the payments service use', user, { tokenBudget: 200 });
        expect(memories.map((m) => m.memory.id)).toEqual([mysql!.id]);
        expect(trace.candidates.find((c) => c.memoryId === postgres!.id)).toMatchObject({ excludedReason: 'not-latest' });
        const lineage = (await engine.getLineage(user, mysql!.id))!;
        expect(lineage.edges).toContainEqual({ from: mysql!.id, to: postgres!.id, relation: 'updates' });
        expect(lineage.documents).toHaveLength(2);
        const [run] = await engine.listExtractionRuns(user);
        expect(run!.stats!.decisions).toEqual([
          { content: mysql!.content, relation: 'updates', memoryId: postgres!.id, reason: 'Database changed.', via: 'model', resultId: mysql!.id },
        ]);
      });

      it('duplicate: one memory, reinforced, with both sources', async () => {
        const { engine } = withModel(
          [fact('The user prefers dark mode.', 'preference'), fact('The user prefers dark mode in every editor.', 'preference')],
          [{ relation: 'duplicate', memoryId: 'm1', reason: 'Same preference.' }],
        );
        await say(engine, 'I always use dark mode.');
        await say(engine, 'Dark mode is my preference in every editor.');
        const memories = await engine.listMemories(user);
        expect(memories).toHaveLength(1);
        expect(memories[0]).toMatchObject({ reinforcementCount: 2 });
        expect(memories[0]!.sourceDocumentIds).toHaveLength(2);
      });

      it('extends: both latest, with an edge', async () => {
        const { engine } = withModel(
          [fact('The user is a product manager at Stripe.'), fact('The user manages a team of six engineers at Stripe.')],
          [{ relation: 'extends', memoryId: 'm1', reason: 'Adds team size.' }],
        );
        await say(engine, 'I am a PM at Stripe.');
        await say(engine, 'At Stripe I manage a team of six engineers.');
        const [role, team] = await engine.listMemories(user, { limit: 10 }, { latestOnly: true });
        expect(team).toMatchObject({ extendsIds: [role!.id] });
        expect((await engine.graph(user)).edges).toEqual([{ from: team!.id, to: role!.id, relation: 'extends' }]);
      });

      it('same-run correction: a later candidate supersedes one planned earlier in the same transaction', async () => {
        const { engine } = withModel(
          [{ candidates: [
            { content: 'The user lives in Portland.', kind: 'fact', confidence: 0.9, validUntil: null },
            { content: 'The user lives in Seattle after moving from Portland.', kind: 'fact', confidence: 0.9, validUntil: null },
          ] }],
          [{ relation: 'updates', memoryId: 'm1', reason: 'Corrected.' }],
        );
        await say(engine, 'I live in Portland. Actually no, I moved to Seattle.');
        const all = await engine.listMemories(user);
        expect(all.map((m) => [m.content, m.isLatest, m.version])).toEqual([
          ['The user lives in Portland.', false, 1],
          ['The user lives in Seattle after moving from Portland.', true, 2],
        ]);
        expect(all[1]!.supersedes).toBe(all[0]!.id);
      });
    });

    describe('profiles', () => {
      const policy = (threshold = 10) => ({ threshold, staleAfterMs: 24 * 60 * 60_000, requeueAfterMs: 10 * 60_000, now: clock.now() });

      it('builds, caches, and never serves forgotten or superseded facts', async () => {
        const [tea, postgres] = await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'The user drinks green tea every afternoon.' }, { content: 'The payments service of the user runs on Postgres.' }],
        });
        const profile = await memnest.profile(user);
        expect(profile).toMatchObject({ builder: 'deterministic', memoryCount: 2, stale: false });
        expect(profile.stable.flatMap((i) => i.memoryIds).sort()).toEqual([tea!.id, postgres!.id].sort());

        const stored = (await store.getProfile(user))!;
        expect(stored).toMatchObject({ containerTag: user.containerTag, changesSinceBuild: 0, builder: 'deterministic' });
        expect(stored.rebuildQueuedAt).toBeUndefined();

        await memnest.forget(user, tea!.id);
        await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The payments service of the user runs on MySQL.', supersedes: postgres!.id }] });
        const after = await memnest.profile(user);
        expect(after.text).not.toContain('green tea');
        expect(after.text).not.toContain('Postgres');
        expect((await store.getProfile(user))!.changesSinceBuild).toBe(2);
        expect((await memnest.rebuildProfile(user)).text).toContain('MySQL');

        await memnest.deleteContainer(user);
        expect(await store.getProfile(user)).toBeNull();
      });

      it('claims a rebuild exactly once under concurrency', async () => {
        const results = await Promise.all(Array.from({ length: 12 }, () => store.noteProfileChanges(user, 1, policy(5))));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await store.getProfile(user)).toBeNull();
      });

      it('enforces provenance on stored profiles', async () => {
        const [tea] = await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user drinks green tea.' }] });
        const base = { containerTag: user.containerTag, recent: [], memoryCount: 1, builtAt: clock.now(), builder: 'deterministic' as const, changesSinceBuild: 0 };
        await expectRejectsWithin(store.putProfile(user, { ...base, stable: [{ text: 'The user drinks green tea.', memoryIds: ['mem_missing'] }] }), ['not_found']);
        await store.putProfile(user, { ...base, stable: [{ text: 'The user drinks green tea.', memoryIds: [tea!.id] }] });
        expect((await store.getProfile(user))!.stable).toEqual([{ text: 'The user drinks green tea.', memoryIds: [tea!.id] }]);
      });

      it('lists rows missing embeddings, for backfill', async () => {
        const plain = createMemnest({ store, clock, ids: sequentialIds() });
        await plain.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user drinks green tea.' }] });
        await plain.add({ containerTag: user.containerTag, content: 'Tea brewing notes.', extraction: 'none' });
        if (!store.capabilities().vector) {
          expect(await store.listMissingEmbeddings(user, 'memories', 10)).toEqual([]);
          return;
        }
        expect(await store.listMissingEmbeddings(user, 'memories', 10)).toEqual([{ id: expect.any(String), content: 'The user drinks green tea.' }]);
        expect(await store.listMissingEmbeddings(user, 'chunks', 10)).toEqual([{ id: expect.any(String), content: 'Tea brewing notes.' }]);
        const embedded = createMemnest({ store, clock, embedder: EMBEDDER });
        expect(await embedded.backfillEmbeddings(user)).toEqual({ memories: 1, chunks: 1 });
        expect(await store.listMissingEmbeddings(user, 'memories', 10)).toEqual([]);
        expect(await store.listMissingEmbeddings(user, 'chunks', 10)).toEqual([]);
      });
    });

    describe('gaps fail loudly', () => {
      it('throws for unbuilt milestones and missing configuration', async () => {
        expect(() => memnest.startWorker()).toThrow(ConfigurationError);
        await expect(memnest.search('x', user, { rerank: true })).rejects.toBeInstanceOf(ConfigurationError);
      });
    });

    describe('vectors', () => {
      it('reports its capability honestly', async () => {
        const [vector] = await EMBEDDER.embed(['anything']);
        if (store.capabilities().vector) {
          expect(await store.vectorSearch(vector!, user, { target: 'memories', k: 5 })).toEqual([]);
        } else {
          await expectRejectsWithin(store.vectorSearch(vector!, user, { target: 'memories', k: 5 }), ['configuration']);
          await expectRejectsWithin(store.putEmbeddings(user, 'memories', []), ['configuration']);
        }
      });

      it('locks the embedding provider atomically, per container', async () => {
        const at = clock.now();
        const provider = { id: 'hash:512', dimensions: 512 };
        const results = await Promise.allSettled([
          store.lockEmbeddingProvider(user, provider, at),
          store.lockEmbeddingProvider(user, { id: 'other:768', dimensions: 768 }, at),
          store.lockEmbeddingProvider(user, provider, at),
        ]);
        const winners = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ embeddingProviderId?: string }>).value.embeddingProviderId);
        expect(new Set(winners).size).toBe(1);
        expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof EmbeddingProviderMismatchError)).toBe(true);
        const record = await store.getContainer(user);
        expect(record).toMatchObject({ containerTag: user.containerTag, embeddingProviderId: winners[0] });
        expect(await store.getContainer(scopeOf('user:unlocked'))).toBeNull();
        await store.lockEmbeddingProvider(scopeOf('user:other'), { id: 'other:768', dimensions: 768 }, at);
        await store.deleteContainer(user);
        expect(await store.getContainer(user)).toBeNull();
        expect(await store.getContainer(scopeOf('user:other'))).toMatchObject({ embeddingProviderId: 'other:768' });
      });

      it('searches stored vectors: nearest first, latest chunks only, dimensions enforced', async () => {
        if (!store.capabilities().vector) return;
        const [tea, coffee] = await memnest.addMemories({
          containerTag: user.containerTag,
          memories: [{ content: 'The user drinks green tea every afternoon.' }, { content: 'The user roasts coffee beans at home.' }],
        });
        const [query] = await EMBEDDER.embed(['green tea afternoon']);
        const hits = await store.vectorSearch(query!, user, { target: 'memories', k: 5 });
        expect(hits.map((h) => h.row.id)).toEqual([tea!.id, coffee!.id]);
        expect(hits.map((h) => h.rank)).toEqual([1, 2]);
        expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
        expect(hits[0]!.score).toBeLessThanOrEqual(1.000001);

        const v1 = await memnest.add({ containerTag: user.containerTag, customId: 'doc', content: 'Green tea brewing notes.', extraction: 'none' });
        await memnest.add({ containerTag: user.containerTag, customId: 'doc', content: 'Coffee roasting notes.', extraction: 'none' });
        const chunkHits = await store.vectorSearch(query!, user, { target: 'chunks', k: 5 });
        expect(chunkHits.map((h) => h.row.documentId)).not.toContain(v1.documentId);
        await memnest.deleteDocument(user, (await store.findDocuments(user, { customId: 'doc', latestOnly: true }))[0]!.id);
        expect(await store.vectorSearch(query!, user, { target: 'chunks', k: 5 })).toEqual([]);

        await expectRejectsWithin(store.vectorSearch(new Float32Array(3), user, { target: 'memories', k: 5 }), ['validation']);
        await expectRejectsWithin(store.putEmbeddings(user, 'memories', [{ id: tea!.id, embedding: new Float32Array(3) }]), ['validation']);
      });
    });
  });
}
