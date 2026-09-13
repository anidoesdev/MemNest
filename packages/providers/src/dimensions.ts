import { ConfigurationError } from '@memnest/core';

/** Native output sizes of common embedding models. Anything else needs explicit `dimensions`. */
export const KNOWN_DIMENSIONS: Readonly<Record<string, number>> = {
  // OpenAI
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  // Ollama
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
  'bge-m3': 1024,
  embeddinggemma: 768,
  // Voyage
  'voyage-3.5': 1024,
  'voyage-3.5-lite': 1024,
  'voyage-3-large': 1024,
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-code-3': 1024,
};

export function resolveDimensions(provider: string, model: string, explicit: number | undefined): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1) {
      throw new ConfigurationError(`${provider}: dimensions must be a positive integer`);
    }
    return explicit;
  }
  const known = KNOWN_DIMENSIONS[model.replace(/:latest$/, '')];
  if (known === undefined) {
    throw new ConfigurationError(
      `${provider}: unknown embedding model "${model}"; pass dimensions (or MEMNEST_EMBEDDING_DIMENSIONS) explicitly`,
    );
  }
  return known;
}
