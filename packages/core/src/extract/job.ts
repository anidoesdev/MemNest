import { ConfigurationError, errorMessage } from '../errors';
import type { Clock, CompletionProvider, EmbeddingProvider, IdGenerator, MemoryStore, Redactor, TokenCounter } from '../ports';
import { contextualText, summarizeForChunks } from './context';
import { scopeOf } from '../scope';
import type {
  Chunk,
  EmbeddingWrite,
  Document,
  ExtractionRun,
  ExtractionStats,
  Job,
  JobHandler,
  Memory,
  ResolutionDecision,
  Scope,
} from '../types';
import { loadExtractionGroup, transcriptWindows, type ExtractionGroup } from './group';
import { EXTRACTION_PROMPT_VERSION, buildExtractionRequest } from './prompt';
import { NEIGHBOR_LIMIT, nearestLatestMemories, sharesTerms, type Resolver } from './resolve';
import { screenCandidates, type Candidate } from './screen';

interface Plan {
  candidate: Candidate;
  decision: ResolutionDecision;
  /** The memory to write. Absent for a duplicate, which reinforces instead. */
  memory?: Memory;
}

export interface ExtractionOptions {
  /** Batched mode waits until a customId has been quiet this long. Default 30s. */
  batchWindowMs: number;
  /** ...but never longer than this after its oldest unextracted version. Default 10 minutes. */
  maxBatchDelayMs: number;
  /** Candidates below this confidence are dropped. Default 0.5. */
  minConfidence: number;
  /** Default 400. */
  maxCandidateChars: number;
  /** Transcript tokens per completion call. Default 12000. */
  windowTokens: number;
  /** Already-extracted context passed with a grown session. Default 1500. */
  priorContextTokens: number;
  /** Re-embed the latest document's chunks with a one-line document summary. Needs embeddings. Default true. */
  contextualChunks: boolean;
  /** Vector neighbors for resolution at or below this cosine similarity are ignored. Default 0.35. */
  minNeighborSimilarity: number;
}

export const DEFAULT_EXTRACTION_OPTIONS: ExtractionOptions = {
  batchWindowMs: 30_000,
  maxBatchDelayMs: 10 * 60_000,
  minConfidence: 0.5,
  maxCandidateChars: 400,
  windowTokens: 12_000,
  priorContextTokens: 1500,
  contextualChunks: true,
  minNeighborSimilarity: 0.35,
};

export interface ExtractionDeps {
  store: MemoryStore;
  completion: CompletionProvider;
  resolver: Resolver;
  redactor: Redactor;
  tokenCounter: TokenCounter;
  clock: Clock;
  ids: IdGenerator;
  options: ExtractionOptions;
  /** Present when the store can search vectors: embeds after enforcing the container's provider lock. */
  embed?: ((scope: Scope, texts: string[]) => Promise<Float32Array[] | undefined>) | undefined;
  embedder?: EmbeddingProvider | undefined;
  /** Called after a successful write with the number of memory changes and the memories no longer latest. Failures are ignored. */
  onMemoriesChanged?: ((scope: Scope, changes: number, invalidated: string[]) => Promise<void>) | undefined;
}

function batchReadyAt(group: ExtractionGroup, options: ExtractionOptions): number {
  const created = group.documents.map((d) => Date.parse(d.createdAt));
  const quiet = Math.max(...created) + options.batchWindowMs;
  const cap = Math.min(...created) + options.maxBatchDelayMs;
  return Math.min(quiet, cap);
}

function emptyStats(): ExtractionStats {
  return {
    calls: 0,
    resolutionCalls: 0,
    decisions: [],
    candidates: 0,
    accepted: 0,
    rejected: [],
    created: 0,
    reinforced: 0,
    updated: 0,
    extended: 0,
    contextualizedChunks: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

async function setStatus(
  tx: Pick<MemoryStore, 'getDocument' | 'putDocument'>,
  scope: Scope,
  documents: Document[],
  status: Document['status'],
  at: string,
) {
  for (const d of documents) {
    // Re-read inside the transaction: a document tombstoned mid-extraction must stay tombstoned.
    const fresh = await tx.getDocument(scope, d.id);
    if (fresh) await tx.putDocument(scope, { ...fresh, status, updatedAt: at });
  }
}

/**
 * load group → (batched: wait for quiet) → extract candidates → screen → resolve each
 * (no transaction held) → re-validate and write (one transaction). A failure marks the
 * documents failed and rethrows so the queue can retry. Chunks stay searchable throughout.
 */
export function createExtractionHandler(deps: ExtractionDeps): JobHandler {
  const { store, completion, resolver, redactor, tokenCounter, clock, ids, options, embed, embedder, onMemoriesChanged } = deps;
  if (!store.capabilities().transactions) {
    throw new ConfigurationError('extraction needs a store with transactions');
  }
  const provider = completion.id ?? 'completion';

  return async (job: Job) => {
    if (job.type !== 'extract') return;
    const scope = scopeOf(job.containerTag);
    const group = await loadExtractionGroup(store, scope, job.documentId, {
      grouping: job.mode === 'batched',
      tokenCounter,
      priorContextTokens: options.priorContextTokens,
    });
    if (!group) return;

    if (job.mode === 'batched') {
      const readyAt = batchReadyAt(group, options);
      if (readyAt > Date.parse(clock.now())) return { deferUntil: new Date(readyAt).toISOString() };
    }

    const startedAt = clock.now();
    const run: ExtractionRun = {
      id: ids.next('run'),
      containerTag: scope.containerTag,
      method: 'llm',
      documentIds: group.documents.map((d) => d.id),
      promptVersion: `${EXTRACTION_PROMPT_VERSION}+${resolver.id}`,
      ...(completion.id ? { model: completion.id } : {}),
      status: 'running',
      startedAt,
    };
    const stats = emptyStats();
    await store.transaction(async (tx) => {
      await tx.putExtractionRun(scope, run);
      await setStatus(tx, scope, group.documents, 'extracting', startedAt);
    });

    try {
      const referenceDate = group.latest.documentDate ?? group.latest.createdAt;
      const accepted: Candidate[] = [];
      const seen = new Set<string>();
      for (const transcript of group.transcript ? transcriptWindows(group.transcript, tokenCounter, options.windowTokens) : []) {
        const response = await completion.complete(
          buildExtractionRequest({ transcript, referenceDate, ...(group.priorContext ? { priorContext: group.priorContext } : {}) }),
        );
        stats.calls++;
        if (response.model && !run.model) run.model = response.model;
        stats.usage.inputTokens += response.usage?.inputTokens ?? 0;
        stats.usage.outputTokens += response.usage?.outputTokens ?? 0;
        const screened = screenCandidates(response.json, {
          provider,
          now: clock.now(),
          redactor,
          minConfidence: options.minConfidence,
          maxChars: options.maxCandidateChars,
        });
        stats.candidates += screened.total;
        stats.rejected.push(...screened.rejected);
        for (const candidate of screened.accepted) {
          const key = candidate.content.toLowerCase();
          if (seen.has(key)) {
            stats.rejected.push({ content: candidate.content, reason: 'duplicate-in-batch' });
            continue;
          }
          seen.add(key);
          accepted.push(candidate);
        }
      }
      stats.accepted = accepted.length;

      const sourceDocumentIds = group.documents.map((d) => d.id);
      const buildMemory = (candidate: Candidate): Memory => ({
        id: ids.next('mem'),
        containerTag: scope.containerTag,
        content: candidate.content,
        kind: candidate.kind,
        confidence: candidate.confidence,
        isLatest: true,
        version: 1,
        extendsIds: [],
        sourceDocumentIds,
        extractionRunId: run.id,
        validFrom: referenceDate,
        ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
        reinforcementCount: 1,
        createdAt: startedAt,
      });

      // Phase 1, no transaction open: decide. Model calls must never hold the write lock.
      const plans: Plan[] = [];
      const plannedIds = new Set<string>();
      const supersededInBatch = new Set<string>();
      const vectors = new Map<Candidate, Float32Array>();
      const candidateVectors = embed ? await embed(scope, accepted.map((c) => c.content)) : undefined;
      accepted.forEach((c, i) => candidateVectors?.[i] && vectors.set(c, candidateVectors[i]!));
      for (const candidate of accepted) {
        const planned = plans
          .map((p) => p.memory)
          .filter((m): m is Memory => !!m && !supersededInBatch.has(m.id) && sharesTerms(m.content, candidate.content))
          .slice(-5);
        const stored = (
          await nearestLatestMemories(candidate, scope, {
            store,
            embedder,
            embedding: vectors.get(candidate),
            minVectorScore: options.minNeighborSimilarity,
          })
        ).filter((m) => !supersededInBatch.has(m.id));
        const neighbors = [...planned, ...stored].slice(0, NEIGHBOR_LIMIT);

        const result = await resolver.resolve({ candidate, neighbors, referenceDate });
        stats.resolutionCalls += result.calls;
        stats.usage.inputTokens += result.usage.inputTokens;
        stats.usage.outputTokens += result.usage.outputTokens;
        const decision: ResolutionDecision = {
          content: candidate.content,
          relation: result.relation,
          ...(result.memoryId ? { memoryId: result.memoryId } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          via: result.via,
        };
        stats.decisions.push(decision);

        const plan: Plan = { candidate, decision };
        if (result.relation !== 'duplicate' || !result.memoryId) {
          plan.memory = buildMemory(candidate);
          if (result.relation === 'updates' && result.memoryId) {
            plan.memory.supersedes = result.memoryId;
            supersededInBatch.add(result.memoryId);
          }
          if (result.relation === 'extends' && result.memoryId) plan.memory.extendsIds = [result.memoryId];
          plannedIds.add(plan.memory.id);
        }
        plans.push(plan);
      }

      // Contextual chunking, still outside the transaction: summarize the newest document, re-embed its chunks.
      let contextual: { summary: string; chunks: Chunk[]; vectors: Float32Array[] } | undefined;
      if (embed && options.contextualChunks) {
        try {
          const { summary, usage } = await summarizeForChunks(completion, group.latest, { tokenCounter, maxTokens: options.windowTokens, redactor });
          stats.usage.inputTokens += usage.inputTokens;
          stats.usage.outputTokens += usage.outputTokens;
          const chunks = await store.getChunks(scope, group.latest.id);
          if (!summary) stats.contextError = 'summary output was unusable';
          else if (chunks.length > 0) {
            const chunkVectors = await embed(scope, chunks.map((ch) => contextualText(summary, ch.content)));
            if (chunkVectors) contextual = { summary, chunks, vectors: chunkVectors };
          }
        } catch (error) {
          // Contextual chunks improve retrieval; they are never worth failing extraction over.
          stats.contextError = redactor.redact(errorMessage(error));
        }
      }

      // Phase 2, one transaction: re-validate each plan against the current graph and write.
      await store.transaction(async (tx) => {
        const now = clock.now();
        const embeddings: EmbeddingWrite[] = [];
        const remember = (memory: Memory, candidate: Candidate) => {
          const vector = vectors.get(candidate);
          if (vector) embeddings.push({ id: memory.id, embedding: vector });
        };
        const downgrade = (plan: Plan): Memory => {
          plan.decision.via = 'conflict';
          plan.decision.relation = 'new';
          const memory = plan.memory ?? buildMemory(plan.candidate);
          delete memory.supersedes;
          memory.extendsIds = [];
          return memory;
        };

        for (const plan of plans) {
          const { decision } = plan;
          if (!plan.memory) {
            // Duplicate of a memory written earlier in this same run: nothing new to record.
            if (plannedIds.has(decision.memoryId!)) {
              decision.resultId = decision.memoryId!;
              continue;
            }
            const target = await tx.getMemory(scope, decision.memoryId!);
            if (target && !target.forgottenAt) {
              await tx.reinforce(scope, target.id, group.latest.id);
              stats.reinforced++;
              decision.resultId = target.id;
              continue;
            }
          }

          let memory: Memory = { ...(plan.memory ?? downgrade(plan)), createdAt: now };
          if (memory.supersedes) {
            const target = await tx.getMemory(scope, memory.supersedes);
            if (target?.isLatest && !target.forgottenAt) {
              memory.version = target.version + 1;
              await tx.putMemories(scope, [memory]);
              await tx.supersede(scope, target.id, memory.id);
              remember(memory, plan.candidate);
              stats.updated++;
              decision.resultId = memory.id;
              continue;
            }
            memory = { ...downgrade(plan), createdAt: now };
          } else if (memory.extendsIds.length > 0) {
            const target = await tx.getMemory(scope, memory.extendsIds[0]!);
            if (target && !target.forgottenAt) {
              await tx.putMemories(scope, [memory]);
              remember(memory, plan.candidate);
              stats.extended++;
              decision.resultId = memory.id;
              continue;
            }
            memory = { ...downgrade(plan), createdAt: now };
          }
          await tx.putMemories(scope, [memory]);
          remember(memory, plan.candidate);
          stats.created++;
          decision.resultId = memory.id;
        }
        if (embeddings.length > 0) await tx.putEmbeddings(scope, 'memories', embeddings);

        if (contextual) {
          const latest = await tx.getDocument(scope, group.latest.id);
          // Never resurrect chunks of a document deleted while the model was busy.
          if (latest && !latest.deletedAt) {
            const live = new Set((await tx.getChunks(scope, latest.id)).map((ch) => ch.id));
            const keep = contextual.chunks.map((ch, i) => ({ ch, v: contextual!.vectors[i]! })).filter(({ ch }) => live.has(ch.id));
            await tx.putChunks(scope, keep.map(({ ch }) => ({ ...ch, context: contextual!.summary })));
            await tx.putEmbeddings(scope, 'chunks', keep.map(({ ch, v }) => ({ id: ch.id, embedding: v })));
            stats.contextualizedChunks = keep.length;
          }
        }
        await tx.putExtractionRun(scope, { ...run, status: 'succeeded', stats, finishedAt: now });
        await setStatus(tx, scope, group.documents, 'extracted', now);
      });

      const changes = stats.created + stats.updated + stats.extended + stats.reinforced;
      if (onMemoriesChanged && changes > 0) {
        const superseded = stats.decisions.filter((d) => d.relation === 'updates' && d.memoryId).map((d) => d.memoryId!);
        // The memories are committed; a profile bookkeeping failure must not make the job retry and re-extract.
        await onMemoriesChanged(scope, changes, superseded).catch(() => undefined);
      }
    } catch (error) {
      const now = clock.now();
      await store.transaction(async (tx) => {
        await tx.putExtractionRun(scope, {
          ...run,
          status: 'failed',
          error: redactor.redact(errorMessage(error)),
          stats,
          finishedAt: now,
        });
        await setStatus(tx, scope, group.documents, 'failed', now);
      });
      throw error;
    }
  };
}
