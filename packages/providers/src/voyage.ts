import { ConfigurationError, ProviderError, type EmbeddingProvider } from '@memnest/core';
import { resolveDimensions } from './dimensions';
import { postJson, toFloat32, trimBaseURL, type HttpOptions } from './http';

export interface VoyageEmbeddingOptions extends HttpOptions {
  apiKey: string;
  /** Default 'voyage-3.5'. */
  model?: string;
  dimensions?: number;
  baseURL?: string;
  /** Texts per request. Default 128. */
  batchSize?: number;
  id?: string;
}

export function voyageEmbeddings(options: VoyageEmbeddingOptions): EmbeddingProvider {
  if (!options.apiKey) throw new ConfigurationError('voyage embeddings: apiKey is required');
  const model = options.model ?? 'voyage-3.5';
  const id = options.id ?? `voyage:${model}`;
  const dimensions = resolveDimensions(id, model, options.dimensions);
  const url = `${trimBaseURL(options.baseURL ?? 'https://api.voyageai.com/v1')}/embeddings`;
  const batchSize = options.batchSize ?? 128;

  return {
    id,
    dimensions,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const response = (await postJson(
          id,
          url,
          { model, input: batch, ...(options.dimensions !== undefined ? { output_dimension: dimensions } : {}) },
          { authorization: `Bearer ${options.apiKey}` },
          { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
        )) as { data?: Array<{ index: number; embedding: number[] }> };
        const data = [...(response.data ?? [])].sort((a, z) => a.index - z.index);
        if (data.length !== batch.length) {
          throw new ProviderError(id, `expected ${batch.length} embeddings, got ${data.length}`, { retryable: true });
        }
        for (const item of data) out.push(toFloat32(id, item.embedding, dimensions));
      }
      return out;
    },
  };
}
