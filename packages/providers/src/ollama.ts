import {
  ConfigurationError,
  ProviderError,
  type CompletionProvider,
  type CompletionRequest,
  type CompletionResponse,
  type EmbeddingProvider,
} from '@memnest/core';
import { resolveDimensions } from './dimensions';
import { parseModelJson, postJson, toFloat32, trimBaseURL, type HttpOptions } from './http';

export interface OllamaOptions extends HttpOptions {
  /** Ollama's native API root, without /v1. Default http://localhost:11434. */
  baseURL?: string;
  model: string;
  /** How long Ollama keeps the model loaded after a request, e.g. "10m". */
  keepAlive?: string;
  id?: string;
}

export interface OllamaEmbeddingOptions extends OllamaOptions {
  dimensions?: number;
  /** Texts per request. Default 32. */
  batchSize?: number;
}

const OLLAMA_BASE_URL = 'http://localhost:11434';

function nativeRoot(provider: string, baseURL: string | undefined): string {
  const root = trimBaseURL(baseURL ?? OLLAMA_BASE_URL);
  if (/\/v1$/.test(root)) {
    throw new ConfigurationError(
      `${provider}: ${root} is Ollama's OpenAI-compatible root; use the openai adapter for it, or drop /v1 for the native API`,
    );
  }
  return root;
}

interface OllamaChat {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Native /api/chat. The JSON schema goes in `format`, which Ollama enforces with
 * constrained decoding — stricter than JSON mode on the OpenAI-compatible route.
 */
export function ollamaCompletion(options: OllamaOptions): CompletionProvider & { id: string } {
  if (!options.model) throw new ConfigurationError('ollama completion: model is required');
  const id = options.id ?? `ollama:${options.model}`;
  const url = `${nativeRoot(id, options.baseURL)}/api/chat`;

  return {
    id,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const response = (await postJson(
        id,
        url,
        {
          model: options.model,
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            ...req.messages.map(({ role, content }) => ({ role, content })),
          ],
          stream: false,
          format: req.jsonSchema,
          options: {
            temperature: req.temperature ?? 0,
            ...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {}),
          },
          ...(options.keepAlive ? { keep_alive: options.keepAlive } : {}),
        },
        {},
        { ...options, timeoutMs: options.timeoutMs ?? 300_000 },
      )) as OllamaChat;

      if (response.done_reason === 'length') {
        throw new ProviderError(id, 'response was truncated by the token limit', { retryable: false });
      }
      return {
        json: parseModelJson(id, response.message?.content),
        model: response.model ?? options.model,
        usage: { inputTokens: response.prompt_eval_count ?? 0, outputTokens: response.eval_count ?? 0 },
      };
    },
  };
}

/** Native /api/embed (batch input). */
export function ollamaEmbeddings(options: OllamaEmbeddingOptions): EmbeddingProvider {
  if (!options.model) throw new ConfigurationError('ollama embeddings: model is required');
  const id = options.id ?? `ollama:${options.model.replace(/:latest$/, '')}`;
  const dimensions = resolveDimensions(id, options.model, options.dimensions);
  const url = `${nativeRoot(id, options.baseURL)}/api/embed`;
  const batchSize = options.batchSize ?? 32;

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
          { model: options.model, input: batch, ...(options.keepAlive ? { keep_alive: options.keepAlive } : {}) },
          {},
          { ...options, timeoutMs: options.timeoutMs ?? 120_000 },
        )) as { embeddings?: number[][] };
        const embeddings = response.embeddings ?? [];
        if (embeddings.length !== batch.length) {
          throw new ProviderError(id, `expected ${batch.length} embeddings, got ${embeddings.length}`, { retryable: true });
        }
        for (const vector of embeddings) out.push(toFloat32(id, vector, dimensions));
      }
      return out;
    },
  };
}
