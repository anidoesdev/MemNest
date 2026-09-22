/**
 * The landing page preview: the real `@memnest/core` engine, running in the browser.
 *
 * Everything is the production code path (redaction, chunking, screening, resolution,
 * versioning, hybrid recall, packing, profiles, forget) except the language model, which is
 * scripted: a static page has no model to call. The script only supplies what a model
 * would say; every rule applied to it is Memnest's own.
 */
import {
  createInMemoryJobQueue,
  createMemnest,
  scopeOf,
  type CompletionRequest,
  type ConversationTurn,
  type ExtractionRun,
  type LineageGraph,
  type Memnest,
  type Memory,
  type MemoryKind,
  type Profile,
  type SearchResponse,
} from '@memnest/core';
import { createInMemoryStore, fixedClock, hashEmbedder, scriptedModel, sequentialIds } from '@memnest/core/testing';

export const CONTAINER = 'customer:acme';

/**
 * A deliberately fake credential for the redaction demo. Shaped like a secret key so the redactor
 * catches it, but in no provider's live-key format, so secret scanners don't flag the repository.
 */
export const DEMO_SECRET = 'sk-demo-0000-not-a-real-key';
const scope = scopeOf(CONTAINER);

export interface Session {
  id: 'onboarding' | 'ticket' | 'followup';
  /** When the session happens; the demo clock moves here before ingesting it. */
  at: string;
  title: string;
  channel: string;
  turns: ConversationTurn[];
}

export const SESSIONS: Session[] = [
  {
    id: 'onboarding',
    at: '2026-03-03T10:00:00.000Z',
    title: 'Onboarding call',
    channel: 'Call transcript',
    turns: [
      { role: 'user', content: "Hi! I'm Priya Shah, platform lead at Acme." },
      { role: 'user', content: 'Our payments service runs on Postgres, and the platform team is six engineers.' },
      { role: 'user', content: `Here's our staging key so you can test: ${DEMO_SECRET}` },
      { role: 'user', content: 'For incidents, email me please. She never picks up the phone, and neither do I.' },
      { role: 'user', content: 'Thanks, great call!' },
    ],
  },
  {
    id: 'ticket',
    at: '2026-06-12T14:30:00.000Z',
    title: 'Ticket #4411',
    channel: 'Support ticket',
    turns: [
      { role: 'user', content: 'We finished moving payments from Postgres to MySQL last week.' },
      { role: 'user', content: 'The new cluster runs in eu-west-1. The platform team is still six engineers, by the way.' },
    ],
  },
  {
    id: 'followup',
    at: '2026-06-20T09:15:00.000Z',
    title: 'Chat follow-up',
    channel: 'Live chat',
    turns: [
      { role: 'user', content: "Quick one before our incident review with you on 24 June at 15:00 UTC." },
      { role: 'user', content: "Our CFO keeps asking: we're on the Enterprise plan, right?" },
      { role: 'assistant', content: 'Let me check that for you.' },
    ],
  },
];

const candidate = (content: string, kind: MemoryKind = 'fact', confidence = 0.9, validUntil: string | null = null) => ({
  content,
  kind,
  confidence,
  validUntil,
});

/**
 * What a model would extract from each session. Some candidates are deliberately bad: the
 * deterministic screen rejects them whatever the model says.
 */
const EXTRACTION: Record<Session['id'], unknown> = {
  onboarding: {
    candidates: [
      candidate('Acme runs its payments service on Postgres.', 'fact', 0.95),
      candidate("Acme's platform team has six engineers.", 'fact', 0.9),
      candidate('Priya Shah, platform lead at Acme, wants incident updates by email, not phone.', 'preference', 0.9),
      candidate('She never picks up the phone.', 'fact', 0.8),
      candidate(`Acme's staging API key is ${DEMO_SECRET}.`, 'fact', 0.9),
      candidate('The onboarding call went well.', 'episode', 0.3),
    ],
  },
  ticket: {
    candidates: [
      candidate('Acme runs its payments service on MySQL, migrated from Postgres in June 2026.', 'fact', 0.95),
      candidate("Acme's payments MySQL cluster runs in eu-west-1.", 'fact', 0.9),
      candidate("Acme's platform team has six engineers.", 'fact', 0.9),
    ],
  },
  followup: {
    candidates: [
      candidate('Acme is on the Enterprise plan.', 'fact', 0.7),
      candidate('Acme has an incident review with Ledgerly on 2026-06-24 at 15:00 UTC.', 'episode', 0.9, '2026-06-24T16:00:00.000Z'),
    ],
  },
};

const SUMMARIES: Record<Session['id'], string> = {
  onboarding: "Onboarding call with Acme's platform lead about their payments stack and team.",
  ticket: 'Acme reports migrating its payments database from Postgres to MySQL.',
  followup: 'Acme asks about its plan ahead of an incident review.',
};

function sessionOf(request: CompletionRequest): Session['id'] {
  const text = request.messages.map((m) => m.content).join('\n');
  if (text.includes('eu-west-1')) return 'ticket';
  if (text.includes('Enterprise')) return 'followup';
  return 'onboarding';
}

/** Neighbors arrive as `m1 [kind, since date] content`; answer by label, as a model does. */
function resolve(request: CompletionRequest): unknown {
  const text = request.messages[0]?.content ?? '';
  const candidateLine = /^Candidate \[[^\]]*\]: (.+)$/m.exec(text)?.[1] ?? '';
  const neighbors = [...text.matchAll(/^(m\d+) \[[^\]]*\] (.+)$/gm)].map(([, label, content]) => ({ label: label!, content: content! }));
  const find = (pattern: RegExp) => neighbors.find((n) => pattern.test(n.content))?.label;

  if (/MySQL/.test(candidateLine) && /migrated/.test(candidateLine)) {
    const target = find(/Postgres/);
    if (target) return { relation: 'updates', memoryId: target, reason: 'The payments database changed from Postgres to MySQL.' };
  }
  if (/eu-west-1/.test(candidateLine)) {
    const target = find(/MySQL/);
    if (target) return { relation: 'extends', memoryId: target, reason: 'Adds where the new MySQL cluster runs.' };
  }
  return { relation: 'new', memoryId: null, reason: 'No existing memory states this.' };
}

export interface IngestResult {
  run: ExtractionRun;
  /** The stored source text: what persisted after redaction. */
  stored: string;
}

export interface Demo {
  readonly container: string;
  now(): string;
  ingested(): Session['id'][];
  ingest(id: Session['id']): Promise<IngestResult>;
  remember(content: string, options?: { kind?: MemoryKind; supersedes?: string }): Promise<Memory>;
  recall(query: string, tokenBudget: number): Promise<SearchResponse>;
  /** Every memory, including superseded and forgotten ones, oldest first. */
  memories(): Promise<Memory[]>;
  forget(id: string): Promise<Memory>;
  lineage(id: string): Promise<LineageGraph | null>;
  profile(): Promise<Profile>;
  /** Moves the clock forward (never back), e.g. past an expiry. */
  advanceTo(iso: string): void;
}

export function createDemo(): Demo {
  const clock = fixedClock('2026-03-03T09:00:00.000Z');
  const model = scriptedModel({
    extraction: (request) => EXTRACTION[sessionOf(request)],
    resolution: (request) => resolve(request),
    context: (request) => ({ summary: SUMMARIES[sessionOf(request)] }),
  });
  const memnest: Memnest = createMemnest({
    store: createInMemoryStore({ vector: true }),
    queue: createInMemoryJobQueue({ clock }),
    clock,
    ids: sequentialIds(),
    embedder: hashEmbedder(),
    completion: model,
    profile: { builder: 'deterministic' },
  });
  const done: Session['id'][] = [];

  const advanceTo = (iso: string) => {
    if (Date.parse(iso) > Date.parse(clock.now())) clock.set(iso);
  };

  return {
    container: CONTAINER,
    now: () => clock.now(),
    ingested: () => [...done],

    async ingest(id) {
      const session = SESSIONS.find((s) => s.id === id)!;
      advanceTo(session.at);
      const added = await memnest.add({
        containerTag: CONTAINER,
        customId: `session-${id}`,
        documentDate: session.at.slice(0, 10),
        content: session.turns,
        extraction: 'instant',
      });
      // Run the extraction job now instead of waiting for a worker.
      while ((await memnest.processDueJobs()).processed > 0) {
        /* drain */
      }
      if (!done.includes(id)) done.push(id);
      const [run] = await memnest.listExtractionRuns(scope, { documentId: added.documentId, limit: 1 });
      const document = await memnest.getDocument(scope, added.documentId);
      return { run: run!, stored: document?.chunks.map((c) => c.content).join('\n') ?? '' };
    },

    async remember(content, options = {}) {
      const [memory] = await memnest.addMemories({
        containerTag: CONTAINER,
        memories: [{ content, ...(options.kind ? { kind: options.kind } : {}), ...(options.supersedes ? { supersedes: options.supersedes } : {}) }],
      });
      return memory!;
    },

    recall: (query, tokenBudget) => memnest.search(query, scope, { tokenBudget }),

    async memories() {
      const all = await memnest.listMemories(scope, { limit: 500 }, { includeForgotten: true });
      return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },

    forget: (id) => memnest.forget(scope, id),
    lineage: (id) => memnest.getLineage(scope, id),
    profile: () => memnest.rebuildProfile(scope),
    advanceTo,
  };
}
