import { ConfigurationError } from '../errors';
import type { Clock, CompletionProvider, CompletionRequest, CompletionResponse, EmbeddingProvider, IdGenerator } from '../ports';
import { queryTerms } from '../text';
import { stem } from './memory-store';

export interface ScriptedCompletion extends CompletionProvider {
  id: string;
  /** Every request received, in order. */
  calls: CompletionRequest[];
}

/**
 * Deterministic completion provider for tests and CI evals. Each call returns the
 * next scripted JSON value; an Error in the script is thrown instead. A function
 * script computes the response from the request.
 */
export function scriptedCompletion(
  script: unknown[] | ((request: CompletionRequest, index: number) => unknown),
  options: { id?: string } = {},
): ScriptedCompletion {
  const calls: CompletionRequest[] = [];
  const id = options.id ?? 'scripted';
  return {
    id,
    calls,
    async complete(request): Promise<CompletionResponse> {
      const index = calls.length;
      calls.push(request);
      let value: unknown;
      if (typeof script === 'function') {
        value = await script(request, index);
      } else {
        if (index >= script.length) {
          throw new ConfigurationError(`scripted completion exhausted: call ${index + 1} but only ${script.length} scripted`);
        }
        value = script[index];
      }
      if (value instanceof Error) throw value;
      return { json: value, model: id, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
}

export { createInMemoryStore, type InMemoryStore, type InMemoryStoreOptions } from './memory-store';

export interface HashEmbedder extends EmbeddingProvider {
  /** Every batch received, in order. */
  calls: string[][];
}

/**
 * Deterministic embeddings for tests and CI evals: stemmed terms and adjacent-term
 * pairs hashed into a unit vector. Texts sharing words are similar; texts sharing
 * none are near-orthogonal. It captures wording, not meaning, so semantic recall
 * is only testable with a real model.
 */
export function hashEmbedder(options: { dimensions?: number; id?: string } = {}): HashEmbedder {
  const dimensions = options.dimensions ?? 512;
  const calls: string[][] = [];
  const bucket = (feature: string) => {
    let h = 2166136261;
    for (let i = 0; i < feature.length; i++) h = Math.imul(h ^ feature.charCodeAt(i), 16777619);
    return (h >>> 0) % dimensions;
  };
  return {
    id: options.id ?? `hash:${dimensions}`,
    dimensions,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => {
        const vector = new Float32Array(dimensions);
        const words = queryTerms(text).map(stem);
        words.forEach((w, i) => {
          vector[bucket(w)]! += 1;
          if (i > 0) vector[bucket(`${words[i - 1]} ${w}`)]! += 0.5;
        });
        const norm = Math.hypot(...vector);
        if (norm > 0) for (let i = 0; i < dimensions; i++) vector[i]! /= norm;
        return vector;
      });
    },
  };
}

export interface ScriptedModelScript {
  /** Responses to extraction calls, in order, or a function of the prompt. Errors are thrown. */
  extraction?: unknown[] | ((request: CompletionRequest, index: number) => unknown);
  /**
   * Responses to resolution calls, in order, or a function of the prompt. When the
   * list runs out, resolution answers "new".
   */
  resolution?: unknown[] | ((request: CompletionRequest, index: number) => unknown);
  /** Chunk-context summaries. Default: a fixed summary. */
  context?: (request: CompletionRequest, index: number) => unknown;
  /** Rerank scores. Default: every memory scores 5. */
  rerank?: (request: CompletionRequest, index: number) => unknown;
  /** Profile builds. Default: durable memories verbatim. */
  profile?: (request: CompletionRequest, index: number) => unknown;
}

export interface ScriptedModel extends ScriptedCompletion {
  extractionCalls: CompletionRequest[];
  resolutionCalls: CompletionRequest[];
  contextCalls: CompletionRequest[];
  rerankCalls: CompletionRequest[];
  profileCalls: CompletionRequest[];
}

/** A scripted completion provider that routes extraction and resolution calls to separate scripts. */
export function scriptedModel(script: ScriptedModelScript, options: { id?: string } = {}): ScriptedModel {
  const extractionCalls: CompletionRequest[] = [];
  const resolutionCalls: CompletionRequest[] = [];
  const contextCalls: CompletionRequest[] = [];
  const rerankCalls: CompletionRequest[] = [];
  const profileCalls: CompletionRequest[] = [];
  const inner = scriptedCompletion((request) => {
    if (request.schemaName === 'memnest_chunk_context') {
      contextCalls.push(request);
      return script.context ? script.context(request, contextCalls.length - 1) : { summary: 'A scripted summary of the document.' };
    }
    if (request.schemaName === 'memnest_profile') {
      profileCalls.push(request);
      if (script.profile) return script.profile(request, profileCalls.length - 1);
      // Default: every durable memory verbatim as a stable item, citing itself.
      const content = request.messages[0]?.content ?? '';
      const durable = content.split('Memories from the last')[0] ?? '';
      const stable = [...durable.matchAll(/^(m\d+) \[[^\]]*\] (.+)$/gm)].map(([, label, text]) => ({ text, memoryIds: [label] }));
      return { stable, recent: [] };
    }
    if (request.schemaName === 'memnest_rerank') {
      rerankCalls.push(request);
      if (script.rerank) return script.rerank(request, rerankCalls.length - 1);
      const count = (request.messages[0]?.content.match(/^m\d+:/gm) ?? []).length;
      return { scores: Array.from({ length: count }, (_, i) => ({ label: `m${i + 1}`, score: 5 })) };
    }
    if (request.schemaName === 'memnest_resolution') {
      const index = resolutionCalls.length;
      resolutionCalls.push(request);
      const r = script.resolution;
      if (typeof r === 'function') return r(request, index);
      return r && index < r.length ? r[index] : { relation: 'new', memoryId: null, reason: 'scripted default' };
    }
    const index = extractionCalls.length;
    extractionCalls.push(request);
    const e = script.extraction ?? [];
    if (typeof e === 'function') return e(request, index);
    if (index >= e.length) {
      return new ConfigurationError(`scripted extraction exhausted: call ${index + 1} but only ${e.length} scripted`);
    }
    return e[index];
  }, options);
  return Object.assign(inner, { extractionCalls, resolutionCalls, contextCalls, rerankCalls, profileCalls });
}

export interface FixedClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
}

/** A clock that only moves when told to. */
export function fixedClock(start = '2026-01-01T00:00:00.000Z'): FixedClock {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    set(iso) {
      current = Date.parse(iso);
    },
    advance(ms) {
      current += ms;
    },
  };
}

/** Deterministic, readable ids: doc_0001, mem_0002, ... */
export function sequentialIds(): IdGenerator {
  let n = 0;
  return { next: (prefix) => `${prefix}_${String(++n).padStart(4, '0')}` };
}

/** Known credential fixtures. Ingest them, then assert none reach storage. */
export const CREDENTIAL_FIXTURES = [
  'sk-proj-Q7hT2mZx9LwR4vB8nK3pYc6D',
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  'hunter2-correct-horse',
  's3cr3t-P@ssw0rd!',
  'tok_live_9f8e7d6c5b4a',
] as const;

/** A transcript that embeds every credential fixture the way people actually paste them. */
export function credentialTranscript(): Array<{ role: string; content: string }> {
  const [skKey, awsId, awsSecret, jwt, ghToken, jsonPassword, envPassword, apiToken] = CREDENTIAL_FIXTURES;
  return [
    { role: 'user', content: `My OpenAI key is ${skKey}, can you check why calls fail?` },
    { role: 'assistant', content: 'Please do not share keys. What error do you see?' },
    {
      role: 'user',
      content: `Here's my env:\nAWS_ACCESS_KEY_ID=${awsId}\naws_secret_access_key=${awsSecret}\nDB_PASSWORD=${envPassword}`,
    },
    { role: 'user', content: `curl -H "Authorization: Bearer ${ghToken}" https://api.example.com` },
    { role: 'user', content: `config.json: {"user": "alex", "password": "${jsonPassword}", "apiToken": "${apiToken}"}` },
    { role: 'user', content: `The session cookie holds ${jwt}` },
    { role: 'user', content: 'Anyway, I prefer Postgres over MongoDB for the payments service.' },
  ];
}

export { seedMemories, type SeedOptions } from './seed';
