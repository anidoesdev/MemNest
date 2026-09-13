import { ConfigurationError, type CompletionProvider, type EmbeddingProvider } from '@memnest/core';
import type { HttpOptions } from './http';
import { ollamaCompletion, ollamaEmbeddings } from './ollama';
import { openAICompatibleCompletion, openAICompatibleEmbeddings } from './openai';
import { voyageEmbeddings } from './voyage';

export type CompletionProviderKind = 'openai' | 'ollama';
export type EmbeddingProviderKind = 'openai' | 'ollama' | 'voyage';

export interface ConfiguredProviders {
  completion?: CompletionProvider & { id: string };
  embedder?: EmbeddingProvider;
  /** Human-readable description of what was (and was not) configured. */
  summary: string[];
}

const DEFAULT_EMBEDDING_MODEL: Record<EmbeddingProviderKind, string> = {
  openai: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
  voyage: 'voyage-3.5',
};

/** Environment variables read by `providersFromEnv`. */
export const PROVIDER_ENV_VARS = {
  MEMNEST_PROVIDER: "'ollama' | 'openai' (any OpenAI-compatible server). Inferred as openai when OPENAI_API_KEY or MEMNEST_BASE_URL is set.",
  MEMNEST_BASE_URL: 'API root. Ollama default http://localhost:11434; OpenAI default https://api.openai.com/v1.',
  MEMNEST_API_KEY: 'API key for MEMNEST_PROVIDER (falls back to OPENAI_API_KEY for openai).',
  MEMNEST_COMPLETION_MODEL: 'Completion model, e.g. llama3.1:8b or gpt-4.1-mini. Required for extraction.',
  MEMNEST_STRUCTURED_OUTPUT: "openai only: 'json_schema' (default) or 'json_object' for servers without schema support.",
  MEMNEST_EMBEDDING_PROVIDER: "'ollama' | 'openai' | 'voyage'. Defaults to MEMNEST_PROVIDER.",
  MEMNEST_EMBEDDING_BASE_URL: 'API root for embeddings when it differs from MEMNEST_BASE_URL.',
  MEMNEST_EMBEDDING_API_KEY: 'API key for embeddings when it differs (VOYAGE_API_KEY is also read).',
  MEMNEST_EMBEDDING_MODEL: 'Default text-embedding-3-small / nomic-embed-text / voyage-3.5.',
  MEMNEST_EMBEDDING_DIMENSIONS: 'Required for embedding models Memnest does not know.',
} as const;

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) throw new ConfigurationError(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  return value as T;
}

/**
 * Builds providers from environment variables. Completions and embeddings are
 * independent: e.g. completions from an OpenAI-compatible server, embeddings from Ollama.
 */
export function providersFromEnv(
  env: Record<string, string | undefined> = process.env,
  http: HttpOptions = {},
): ConfiguredProviders {
  const summary: string[] = [];
  const provider =
    oneOf('MEMNEST_PROVIDER', env.MEMNEST_PROVIDER, ['openai', 'ollama'] as const) ??
    (env.OPENAI_API_KEY || env.MEMNEST_BASE_URL ? 'openai' : undefined);

  const openAIKey = env.MEMNEST_API_KEY || env.OPENAI_API_KEY || undefined;
  const requireOpenAIReachable = (baseURL: string | undefined, apiKey: string | undefined, what: string) => {
    if (!baseURL && !apiKey) {
      throw new ConfigurationError(`${what}: set OPENAI_API_KEY for api.openai.com, or MEMNEST_BASE_URL for a compatible server`);
    }
  };

  const result: ConfiguredProviders = { summary };

  if (!provider) {
    summary.push('completion: not configured (set MEMNEST_PROVIDER=ollama|openai and MEMNEST_COMPLETION_MODEL)');
  } else if (!env.MEMNEST_COMPLETION_MODEL) {
    summary.push(`completion: ${provider} selected but MEMNEST_COMPLETION_MODEL is not set`);
  } else if (provider === 'ollama') {
    result.completion = ollamaCompletion({
      ...http,
      model: env.MEMNEST_COMPLETION_MODEL,
      ...(env.MEMNEST_BASE_URL ? { baseURL: env.MEMNEST_BASE_URL } : {}),
    });
    summary.push(`completion: ${result.completion.id} at ${env.MEMNEST_BASE_URL ?? 'http://localhost:11434'}`);
  } else {
    requireOpenAIReachable(env.MEMNEST_BASE_URL, openAIKey, 'completion');
    const structuredOutput = oneOf('MEMNEST_STRUCTURED_OUTPUT', env.MEMNEST_STRUCTURED_OUTPUT, ['json_schema', 'json_object'] as const);
    result.completion = openAICompatibleCompletion({
      ...http,
      model: env.MEMNEST_COMPLETION_MODEL,
      ...(env.MEMNEST_BASE_URL ? { baseURL: env.MEMNEST_BASE_URL } : {}),
      ...(openAIKey ? { apiKey: openAIKey } : {}),
      ...(structuredOutput ? { structuredOutput } : {}),
    });
    summary.push(`completion: ${result.completion.id} at ${env.MEMNEST_BASE_URL ?? 'https://api.openai.com/v1'}`);
  }

  const embeddingKind =
    oneOf('MEMNEST_EMBEDDING_PROVIDER', env.MEMNEST_EMBEDDING_PROVIDER, ['openai', 'ollama', 'voyage'] as const) ?? provider;
  if (!embeddingKind) {
    summary.push('embeddings: not configured (set MEMNEST_EMBEDDING_PROVIDER or MEMNEST_PROVIDER)');
    return result;
  }

  const model = env.MEMNEST_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL[embeddingKind];
  const baseURL = env.MEMNEST_EMBEDDING_BASE_URL || (embeddingKind === provider ? env.MEMNEST_BASE_URL : undefined) || undefined;
  const dimensionsText = env.MEMNEST_EMBEDDING_DIMENSIONS;
  const dimensions = dimensionsText ? Number(dimensionsText) : undefined;
  if (dimensionsText && !Number.isInteger(dimensions)) {
    throw new ConfigurationError('MEMNEST_EMBEDDING_DIMENSIONS must be an integer');
  }
  const common = { ...http, model, ...(baseURL ? { baseURL } : {}), ...(dimensions !== undefined ? { dimensions } : {}) };

  if (embeddingKind === 'ollama') {
    result.embedder = ollamaEmbeddings(common);
  } else if (embeddingKind === 'voyage') {
    const apiKey = env.VOYAGE_API_KEY || env.MEMNEST_EMBEDDING_API_KEY;
    if (!apiKey) throw new ConfigurationError('embeddings: set VOYAGE_API_KEY for voyage');
    result.embedder = voyageEmbeddings({ ...common, apiKey });
  } else {
    const apiKey = env.MEMNEST_EMBEDDING_API_KEY || (embeddingKind === provider ? openAIKey : env.OPENAI_API_KEY) || undefined;
    requireOpenAIReachable(baseURL, apiKey, 'embeddings');
    result.embedder = openAICompatibleEmbeddings({ ...common, ...(apiKey ? { apiKey } : {}) });
  }
  summary.push(`embeddings: ${result.embedder.id} (${result.embedder.dimensions} dims)${baseURL ? ` at ${baseURL}` : ''}`);
  return result;
}
