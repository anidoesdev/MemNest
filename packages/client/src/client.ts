import {
  MemnestError,
  scopeOf,
  type AddInput,
  type AddResult,
  type ChunkResult,
  type DirectMemoryInput,
  type DocumentWithChunks,
  type ExtractionRun,
  type GraphSnapshot,
  type JobStatusEvent,
  type LineageGraph,
  type Memory,
  type MemnestApi,
  type MemnestErrorCode,
  type MemoryFilter,
  type MemoryResult,
  type Page,
  type Profile,
  type Scope,
  type SearchOptions,
  type SearchResponse,
  type SnapshotOpts,
} from '@memnest/core';

/** Must match the server's CSRF header. Sent on every request: harmless with keys, required with cookies. */
const CSRF_HEADER = 'x-memnest-csrf';

const CODES: ReadonlySet<MemnestErrorCode> = new Set([
  'not_implemented',
  'validation',
  'not_found',
  'scope_violation',
  'provenance',
  'transactions_unsupported',
  'configuration',
  'provider',
  'unauthorized',
  'internal',
]);

export interface MemnestClientOptions {
  /** e.g. https://memnest.example.com. Paths are appended to it. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>`. Omit in a browser that holds a session cookie. */
  apiKey?: string;
  /** Default: the global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Default 'same-origin'. Use 'include' for a dashboard on another origin. */
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
}

/** An error returned by the server, rebuilt with the same `code` the engine would have thrown. */
export class MemnestHttpError extends MemnestError {
  readonly status: number;

  constructor(code: MemnestErrorCode, message: string, status: number) {
    super(code, message);
    this.status = status;
  }
}

export interface SessionInfo {
  keyId: string;
  name: string;
  containerTag: string | null;
  via: 'key' | 'session';
  expiresAt?: string;
}

export interface EventsOptions {
  /** Unscoped keys only: one container. Scoped keys always receive their own. */
  containerTag?: string;
  signal?: AbortSignal;
}

export interface MemnestClient extends MemnestApi {
  /** Exchanges an API key for an HttpOnly session cookie (browsers). */
  login(apiKey: string): Promise<SessionInfo>;
  logout(): Promise<void>;
  /** Who the current credentials belong to. */
  session(): Promise<SessionInfo>;
  /** Job status events until the signal aborts or the client closes. */
  events(options?: EventsOptions): AsyncIterable<JobStatusEvent>;
}

type Query = Record<string, string | number | boolean | undefined>;

function queryString(query: Query): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value !== undefined) params.set(name, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}

const tag = (scope: Scope) => scopeOf(scope?.containerTag).containerTag;
const path = (scope: Scope) => encodeURIComponent(tag(scope));

/**
 * The Memnest API over HTTP. Implements `MemnestApi`, so code written against the embedded engine
 * runs unchanged against a server (D2). Nulls, errors and results match the engine's.
 */
export function createMemnestClient(options: MemnestClientOptions): MemnestClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const open = new Set<AbortController>();

  async function send(method: string, url: string, body?: unknown, init: { signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', [CSRF_HEADER]: '1', ...options.headers };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await doFetch(`${baseUrl}${url}`, {
      method,
      headers,
      credentials: options.credentials ?? 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (response.ok) return response;
    let code: MemnestErrorCode = response.status >= 500 ? 'internal' : 'validation';
    let message = `${method} ${url} failed with HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      if (payload.error?.code && CODES.has(payload.error.code as MemnestErrorCode)) code = payload.error.code as MemnestErrorCode;
      if (typeof payload.error?.message === 'string') message = payload.error.message;
    } catch {
      // Not a Memnest error body (a proxy, a gateway): keep the generic message.
    }
    throw new MemnestHttpError(code, message, response.status);
  }

  async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await send(method, url, body);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** The engine returns null for a missing row; the server says 404. */
  async function orNull<T>(url: string): Promise<T | null> {
    try {
      return await json<T>('GET', url);
    } catch (error) {
      if (error instanceof MemnestHttpError && error.code === 'not_found') return null;
      throw error;
    }
  }

  return {
    add: (input: AddInput) => json<AddResult>('POST', '/v1/documents', input),
    getDocument: (scope, id) => orNull<DocumentWithChunks>(`/v1/documents/${encodeURIComponent(id)}${queryString({ containerTag: tag(scope) })}`),
    deleteDocument: (scope, id) =>
      json<void>('DELETE', `/v1/documents/${encodeURIComponent(id)}${queryString({ containerTag: tag(scope) })}`),

    addMemories: (input: DirectMemoryInput) => json<Memory[]>('POST', '/v1/memories', input),
    getMemory: (scope, id) => orNull<Memory>(`/v1/memories/${encodeURIComponent(id)}${queryString({ containerTag: tag(scope) })}`),
    listMemories: (scope, page: Page = { limit: 100 }, filter: MemoryFilter = {}) =>
      json<Memory[]>(
        'GET',
        `/v1/memories${queryString({ containerTag: tag(scope), limit: page.limit, after: page.after, kind: filter.kind, latestOnly: filter.latestOnly, includeForgotten: filter.includeForgotten })}`,
      ),
    getLineage: (scope, memoryId) =>
      orNull<LineageGraph>(`/v1/memories/${encodeURIComponent(memoryId)}/lineage${queryString({ containerTag: tag(scope) })}`),
    forget: (scope, memoryId) =>
      json<Memory>('POST', `/v1/memories/${encodeURIComponent(memoryId)}/forget${queryString({ containerTag: tag(scope) })}`),
    graph: (scope, opts: SnapshotOpts = {}) =>
      json<GraphSnapshot>(
        'GET',
        `/v1/graph/${path(scope)}${queryString({ limit: opts.limit, includeSuperseded: opts.includeSuperseded, includeForgotten: opts.includeForgotten })}`,
      ),

    searchMemories: async (query, scope, opts: SearchOptions = {}) =>
      (await json<{ memories: MemoryResult[] }>('POST', '/v1/search', { query, containerTag: tag(scope), options: opts, include: ['memories'] })).memories,
    searchDocuments: async (query, scope, opts: SearchOptions = {}) =>
      (await json<{ chunks: ChunkResult[] }>('POST', '/v1/search', { query, containerTag: tag(scope), options: opts, include: ['chunks'] })).chunks,
    search: (query, scope, opts: SearchOptions = {}) =>
      json<SearchResponse>('POST', '/v1/search', { query, containerTag: tag(scope), options: opts }),

    profile: (scope) => json<Profile>('GET', `/v1/profile/${path(scope)}`),
    rebuildProfile: (scope) => json<Profile>('POST', `/v1/profile/${path(scope)}/rebuild`),
    deleteContainer: (scope) => json<void>('DELETE', `/v1/containers/${path(scope)}`),
    listExtractionRuns: (scope, opts = {}) =>
      json<ExtractionRun[]>('GET', `/v1/runs${queryString({ containerTag: tag(scope), limit: opts.limit, documentId: opts.documentId })}`),

    login: (apiKey) => json<SessionInfo>('POST', '/v1/session', { apiKey }),
    logout: () => json<void>('DELETE', '/v1/session'),
    session: () => json<SessionInfo>('GET', '/v1/session'),

    events(eventOptions: EventsOptions = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          const controller = new AbortController();
          const abort = () => controller.abort();
          eventOptions.signal?.addEventListener('abort', abort, { once: true });
          open.add(controller);
          try {
            if (eventOptions.signal?.aborted) return;
            const response = await send('GET', `/v1/events${queryString({ containerTag: eventOptions.containerTag })}`, undefined, {
              signal: controller.signal,
            });
            const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = '';
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) return;
                buffer += value;
                let boundary: number;
                while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                  const block = buffer.slice(0, boundary);
                  buffer = buffer.slice(boundary + 2);
                  if (/^event: job$/m.test(block)) {
                    const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join('\n');
                    yield JSON.parse(data) as JobStatusEvent;
                  }
                }
              }
            } finally {
              await reader.cancel().catch(() => undefined);
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            throw error;
          } finally {
            eventOptions.signal?.removeEventListener('abort', abort);
            open.delete(controller);
            controller.abort();
          }
        },
      };
    },

    async close() {
      for (const controller of open) controller.abort();
      open.clear();
    },
  };
}
