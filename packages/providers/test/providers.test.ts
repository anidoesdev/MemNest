import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigurationError, ProviderError, type CompletionRequest } from '@memnest/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ollamaCompletion,
  ollamaEmbeddings,
  openAICompatibleCompletion,
  openAICompatibleEmbeddings,
  providersFromEnv,
  voyageEmbeddings,
} from '../src/index';

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

/** A real HTTP server: the adapters are exercised end to end, fetch included. */
async function fakeServer(handler: (req: Recorded, n: number) => Reply) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const recorded = { method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(recorded);
      const reply = handler(recorded, requests.length);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const noSleep = { sleep: async () => undefined };

const request: CompletionRequest = {
  system: 'Extract facts.',
  messages: [{ role: 'user', content: 'Alex works at Stripe.' }],
  jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  schemaName: 'check',
};

const chat = (content: string, extra: object = {}) => ({
  model: 'served-model',
  choices: [{ finish_reason: 'stop', message: { content }, ...extra }],
  usage: { prompt_tokens: 11, completion_tokens: 3 },
});

describe('OpenAI-compatible completion', () => {
  it('sends strict json_schema structured output and parses the result', async () => {
    const api = await fakeServer(() => ({ body: chat('{"ok":true}') }));
    const provider = openAICompatibleCompletion({ baseURL: `${api.url}/v1/`, apiKey: 'sk-test-key', model: 'gpt-test' });

    const response = await provider.complete(request);

    expect(provider.id).toBe('openai:gpt-test');
    expect(response).toEqual({ json: { ok: true }, model: 'served-model', usage: { inputTokens: 11, outputTokens: 3 } });
    const [sent] = api.requests;
    expect(sent!.path).toBe('/v1/chat/completions');
    expect(sent!.headers.authorization).toBe('Bearer sk-test-key');
    expect(sent!.body).toMatchObject({
      model: 'gpt-test',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Extract facts.' },
        { role: 'user', content: 'Alex works at Stripe.' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'check', schema: request.jsonSchema, strict: true } },
    });
  });

  it('supports JSON-mode servers by putting the schema in the system prompt', async () => {
    const api = await fakeServer(() => ({ body: chat('```json\n{"ok":false}\n```') }));
    const provider = openAICompatibleCompletion({ baseURL: api.url, model: 'local', structuredOutput: 'json_object' });

    expect((await provider.complete(request)).json).toEqual({ ok: false });
    const sent = api.requests[0]!;
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.body.response_format).toEqual({ type: 'json_object' });
    expect(sent.body.messages[0].content).toContain('"additionalProperties":false');
  });

  it('retries rate limits and server errors, honouring Retry-After', async () => {
    const api = await fakeServer((_, n) =>
      n === 1 ? { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '2' } } : n === 2 ? { status: 503, body: {} } : { body: chat('{"ok":true}') },
    );
    const waits: number[] = [];
    const provider = openAICompatibleCompletion({
      baseURL: api.url,
      model: 'm',
      sleep: async (ms) => void waits.push(ms),
    });
    expect((await provider.complete(request)).json).toEqual({ ok: true });
    expect(api.requests).toHaveLength(3);
    expect(waits[0]).toBe(2000);
  });

  it('fails fast on client errors without leaking the API key', async () => {
    const api = await fakeServer(() => ({ status: 400, body: { error: { message: 'bad schema' } } }));
    const provider = openAICompatibleCompletion({ baseURL: api.url, apiKey: 'sk-secret-do-not-log', model: 'm', ...noSleep });
    const error = await provider.complete(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 400, retryable: false, code: 'provider' });
    expect((error as Error).message).toContain('bad schema');
    expect((error as Error).message).not.toContain('sk-secret-do-not-log');
    expect(api.requests).toHaveLength(1);
  });

  it('reports unreachable servers and timeouts as retryable', async () => {
    const unreachable = openAICompatibleCompletion({ baseURL: 'http://127.0.0.1:9/v1', model: 'm', maxRetries: 1, ...noSleep });
    await expect(unreachable.complete(request)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('could not reach') });

    const api = await fakeServer(() => ({ body: chat('{"ok":true}'), delayMs: 500 }));
    const slow = openAICompatibleCompletion({ baseURL: api.url, model: 'm', timeoutMs: 50, maxRetries: 0 });
    await expect(slow.complete(request)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('timed out') });
  });

  it('rejects refusals, truncation and invalid JSON distinctly', async () => {
    const replies = [
      chat('', { message: { content: null, refusal: 'no' } }),
      chat('{"ok":', { finish_reason: 'length' }),
      chat('not json at all'),
    ];
    const api = await fakeServer((_, n) => ({ body: replies[n - 1] }));
    const provider = openAICompatibleCompletion({ baseURL: api.url, model: 'm', ...noSleep });
    await expect(provider.complete(request)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('refused') });
    await expect(provider.complete(request)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('truncated') });
    await expect(provider.complete(request)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('invalid JSON') });
  });
});

describe('OpenAI-compatible embeddings', () => {
  it('batches, restores input order, and returns Float32Arrays', async () => {
    const api = await fakeServer((req) => ({
      body: {
        data: (req.body.input as string[])
          .map((text, index) => ({ index, embedding: [text.length, index, 0.5] }))
          .reverse(),
      },
    }));
    const embedder = openAICompatibleEmbeddings({ baseURL: api.url, model: 'custom-embed', dimensions: 3, batchSize: 2 });

    const vectors = await embedder.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee']);

    expect(embedder).toMatchObject({ id: 'openai:custom-embed', dimensions: 3 });
    expect(api.requests.map((r) => r.body.input)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(api.requests[0]!.body).not.toHaveProperty('dimensions');
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(await embedder.embed([])).toEqual([]);
  });

  it('knows common models, sends dimensions to text-embedding-3, and catches mismatches', async () => {
    expect(openAICompatibleEmbeddings({ apiKey: 'k', model: 'text-embedding-3-small' }).dimensions).toBe(1536);
    expect(() => openAICompatibleEmbeddings({ model: 'mystery-model' })).toThrow(ConfigurationError);

    const api = await fakeServer(() => ({ body: { data: [{ index: 0, embedding: [1, 2] }] } }));
    const shortened = openAICompatibleEmbeddings({ baseURL: api.url, model: 'text-embedding-3-large', dimensions: 256 });
    await expect(shortened.embed(['x'])).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('2 dimensions but the provider is configured for 256'),
    });
    expect(api.requests[0]!.body.dimensions).toBe(256);
  });
});

describe('Ollama (native API)', () => {
  it('constrains chat output with the JSON schema in `format`', async () => {
    const api = await fakeServer(() => ({
      body: { model: 'llama3.1:8b', message: { role: 'assistant', content: '{"ok":true}' }, done_reason: 'stop', prompt_eval_count: 20, eval_count: 4 },
    }));
    const provider = ollamaCompletion({ baseURL: api.url, model: 'llama3.1:8b', keepAlive: '10m' });

    expect(await provider.complete({ ...request, maxTokens: 64 })).toEqual({
      json: { ok: true },
      model: 'llama3.1:8b',
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    expect(provider.id).toBe('ollama:llama3.1:8b');
    expect(api.requests[0]).toMatchObject({
      path: '/api/chat',
      body: {
        model: 'llama3.1:8b',
        stream: false,
        format: request.jsonSchema,
        keep_alive: '10m',
        options: { temperature: 0, num_predict: 64 },
        messages: [{ role: 'system' }, { role: 'user' }],
      },
    });
  });

  it('points /v1 users at the OpenAI-compatible adapter and reports truncation', async () => {
    expect(() => ollamaCompletion({ baseURL: 'http://localhost:11434/v1', model: 'm' })).toThrow(/openai adapter/);
    const api = await fakeServer(() => ({ body: { message: { content: '{"ok"' }, done_reason: 'length' } }));
    await expect(ollamaCompletion({ baseURL: api.url, model: 'm' }).complete(request)).rejects.toMatchObject({
      message: expect.stringContaining('truncated'),
    });
  });

  it('embeds in batches through /api/embed', async () => {
    const api = await fakeServer((req) => ({
      body: { embeddings: (req.body.input as string[]).map((t) => Array.from({ length: 768 }, () => t.length)) },
    }));
    const embedder = ollamaEmbeddings({ baseURL: api.url, model: 'nomic-embed-text:latest', batchSize: 3 });
    const vectors = await embedder.embed(['a', 'bb', 'ccc', 'dddd']);
    expect(embedder).toMatchObject({ id: 'ollama:nomic-embed-text', dimensions: 768 });
    expect(api.requests.map((r) => [r.path, r.body.input.length])).toEqual([['/api/embed', 3], ['/api/embed', 1]]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4]);
  });
});

describe('Voyage embeddings', () => {
  it('authenticates and requests the configured output dimension', async () => {
    const api = await fakeServer(() => ({ body: { data: [{ index: 0, embedding: [0.1, 0.2] }] } }));
    const embedder = voyageEmbeddings({ baseURL: api.url, apiKey: 'pa-key', model: 'voyage-3.5', dimensions: 2 });
    expect((await embedder.embed(['x']))[0]).toHaveLength(2);
    expect(api.requests[0]).toMatchObject({
      path: '/embeddings',
      headers: { authorization: 'Bearer pa-key' },
      body: { model: 'voyage-3.5', input: ['x'], output_dimension: 2 },
    });
  });
});

describe('providersFromEnv', () => {
  it('configures nothing when nothing is set, and says what is missing', () => {
    const result = providersFromEnv({});
    expect(result.completion).toBeUndefined();
    expect(result.embedder).toBeUndefined();
    expect(result.summary.join('\n')).toMatch(/MEMNEST_PROVIDER/);
  });

  it('uses Ollama for both with defaults', () => {
    const result = providersFromEnv({ MEMNEST_PROVIDER: 'ollama', MEMNEST_COMPLETION_MODEL: 'qwen3:8b' });
    expect(result.completion?.id).toBe('ollama:qwen3:8b');
    expect(result.embedder).toMatchObject({ id: 'ollama:nomic-embed-text', dimensions: 768 });
  });

  it('infers an OpenAI-compatible server from MEMNEST_BASE_URL and mixes embedding providers', () => {
    const result = providersFromEnv({
      MEMNEST_BASE_URL: 'http://localhost:1234/v1',
      MEMNEST_COMPLETION_MODEL: 'local-model',
      MEMNEST_STRUCTURED_OUTPUT: 'json_object',
      MEMNEST_EMBEDDING_PROVIDER: 'ollama',
    });
    expect(result.completion?.id).toBe('openai:local-model');
    expect(result.embedder?.id).toBe('ollama:nomic-embed-text');

    const voyage = providersFromEnv({ OPENAI_API_KEY: 'sk-x', MEMNEST_COMPLETION_MODEL: 'gpt-x', MEMNEST_EMBEDDING_PROVIDER: 'voyage', VOYAGE_API_KEY: 'pa' });
    expect(voyage.embedder).toMatchObject({ id: 'voyage:voyage-3.5', dimensions: 1024 });
  });

  it('refuses configurations that cannot work', () => {
    expect(() => providersFromEnv({ MEMNEST_PROVIDER: 'openai', MEMNEST_COMPLETION_MODEL: 'gpt-x' })).toThrow(/OPENAI_API_KEY/);
    expect(() => providersFromEnv({ MEMNEST_PROVIDER: 'anthropic' })).toThrow(ConfigurationError);
    expect(() => providersFromEnv({ MEMNEST_PROVIDER: 'ollama', MEMNEST_EMBEDDING_MODEL: 'unknown-embed' })).toThrow(/DIMENSIONS/);
    expect(() => providersFromEnv({ MEMNEST_EMBEDDING_PROVIDER: 'voyage' })).toThrow(/VOYAGE_API_KEY/);
  });
});
