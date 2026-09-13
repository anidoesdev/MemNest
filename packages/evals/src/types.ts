import type {
  AddInput,
  CandidateRejection,
  DirectMemoryInput,
  ExcludedReason,
  MemoryKind,
} from '@memnest/core';

export type EvalStep =
  /** Ingest a document. Extraction mode defaults to batched, as in production. */
  | { add: Omit<AddInput, 'containerTag'> }
  /** Write memories directly, bypassing extraction. */
  | { memories: DirectMemoryInput['memories'] }
  /** Move the injected clock forward. */
  | { advance: number }
  /** Move past every batching window and process jobs until none are due. */
  | { settle: true };

interface AssertionBase {
  /** Only meaningful with scripted model output (e.g. asserting the screen caught a scripted bad candidate). */
  mockOnly?: boolean;
}

export type EvalAssertion = AssertionBase &
  (
    | { type: 'memory-count'; eq?: number; min?: number; max?: number; latestOnly?: boolean }
    | { type: 'memory-exists'; matches: string; kind?: MemoryKind; latest?: boolean; minReinforcement?: number }
    | { type: 'memory-absent'; matches: string }
    | { type: 'no-unresolved-pronouns' }
    | { type: 'no-secrets-persisted'; secrets: readonly string[] }
    | { type: 'rejected'; reason: CandidateRejection; min?: number }
    | { type: 'completion-calls'; eq?: number; max?: number; kind?: 'extraction' | 'resolution' }
    | { type: 'relation-exists'; relation: 'updates' | 'extends'; from: string; to: string }
    | { type: 'recall-includes'; matches: string; topK?: number }
    | { type: 'recall-excludes'; matches: string; reason?: ExcludedReason }
    /** Profile assertions read memnest.profile() after due jobs (including profile rebuilds) have run. */
    | { type: 'profile-includes'; matches: string }
    | { type: 'profile-excludes'; matches: string }
  );

export interface EvalCase {
  name: string;
  summary: string;
  /** A milestone this case depends on. Until it is built, the case reports as pending. */
  requires?: `M${number}`;
  /** Only meaningful against real models (e.g. semantic recall). Skipped in mock mode. */
  liveOnly?: boolean;
  steps: EvalStep[];
  /** Scripted model output for mock mode, one entry per call of each kind. Unscripted resolution calls answer "new". */
  mock?: { extraction: unknown[]; resolution?: unknown[] };
  query?: { text: string; tokenBudget?: number };
  assertions: EvalAssertion[];
}

export type EvalStatus = 'passed' | 'failed' | 'pending' | 'skipped';

export interface EvalResult {
  name: string;
  summary: string;
  status: EvalStatus;
  failures: string[];
  /** Assertions skipped because they are mock-only and this was a live run. */
  skipped: number;
  /** Extraction and resolution model calls. */
  completionCalls: { extraction: number; resolution: number };
  memories: string[];
  durationMs: number;
  pendingReason?: string;
}

export interface EvalReport {
  mode: 'mock' | 'live';
  store: 'memory' | 'sqlite' | 'postgres';
  model?: string;
  results: EvalResult[];
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
}
