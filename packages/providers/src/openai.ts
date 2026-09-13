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

export interface OpenAICompatibleOptions extends HttpOptions {
  /**
   * Any OpenAI-compatible API root. Default https://api.openai.com/v1.
   * Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · vLLM, Groq, OpenRouter, Together, ...
   */
  baseURL?: string;
  /** Optional: local servers usually need none. */
  apiKey?: string;
  model: string;
  /** Overrides the provider id used for logs and the dimension lock. */
  id?: string;
}

export interface OpenAICompletionOptions extends OpenAICompatibleOptions {
  /**
   * 'json_schema' uses strict structured outputs. 'json_object' is for servers that only
   * support JSON mode; the schema is then given to the model in the system prompt.
   * Default 'json_schema'.
   */
  structuredOutput?: 'json_schema' | 'json_object';
}

export interface OpenAIEmbeddingOptions extends OpenAICompatibleOptions {
  /** Required for models not in KNOWN_DIMENSIONS. Sent to the API for text-embedding-3-* models. */
  dimensions?: number;
  /** Texts per request. Default 96. */
  batchSize?: number;
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function requireModel(provider: string, model: string | undefined): string {
  if (!model) throw new ConfigurationError(`${provider}: model is required`);
  return model;
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openAICompatibleCompletion(options: OpenAICompletionOptions): CompletionProvider & { id: string } {
  const model = requireModel('openai-compatible completion', options.model);
  const id = options.id ?? `openai:${model}`;
  const url = `${trimBaseURL(options.baseURL ?? OPENAI_BASE_URL)}/chat/completions`;
  const mode = options.structuredOutput ?? 'json_schema';

  return {
    id,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const system =
        mode === 'json_object'
          ? `${req.system ?? ''}\n\nRespond with a single JSON object that satisfies this JSON schema:\n${JSON.stringify(req.jsonSchema)}`.trim()
          : req.system;
      const body = {
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...req.messages.map(({ role, content }) => ({ role, content })),
        ],
        temperature: req.temperature ?? 0,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        response_format:
          mode === 'json_schema'
            ? { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: true } }
            : { type: 'json_object' },
      };
      const response = (await postJson(id, url, body, authHeaders(options.apiKey), {
        ...options,
        timeoutMs: options.timeoutMs ?? 120_000,
      })) as ChatCompletion;

      const choice = response.choices?.[0];
      if (!choice?.message) throw new ProviderError(id, 'response has no choices', { retryable: true });
      if (choice.message.refusal) {
        throw new ProviderError(id, `model refused: ${choice.message.refusal}`, { retryable: false });
      }
      if (choice.finish_reason === 'length') {
        throw new ProviderError(id, 'response was truncated by the token limit', { retryable: false });
      }
      return {
        json: parseModelJson(id, choice.message.content),
        model: response.model ?? model,
        ...(response.usage
          ? { usage: { inputTokens: response.usage.prompt_tokens ?? 0, outputTokens: response.usage.completion_tokens ?? 0 } }
          : {}),
      };
    },
  };
}

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
}

export function openAICompatibleEmbeddings(options: OpenAIEmbeddingOptions): EmbeddingProvider {
  const model = requireModel('openai-compatible embeddings', options.model);
  const id = options.id ?? `openai:${model}`;
  const dimensions = resolveDimensions(id, model, options.dimensions);
  const url = `${trimBaseURL(options.baseURL ?? OPENAI_BASE_URL)}/embeddings`;
  const batchSize = options.batchSize ?? 96;
  const sendDimensions = options.dimensions !== undefined && /^text-embedding-3/.test(model);

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
          { model, input: batch, encoding_format: 'float', ...(sendDimensions ? { dimensions } : {}) },
          authHeaders(options.apiKey),
          { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
        )) as EmbeddingResponse;
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
