import {
  MemnestError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  scopeOf,
  systemClock,
  type AddInput,
  type ApiKeyRecord,
  type AuthStore,
  type Clock,
  type DirectMemoryInput,
  type MemnestApi,
  type MemnestErrorCode,
  type MemoryFilter,
  type MemoryKind,
  type Scope,
  type SearchOptions,
  type SessionRecord,
  type SnapshotOpts,
} from '@memnest/core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createJobEventHub, type JobEventHub } from './events';
import { createKeyring, type Keyring, type KeyringOptions } from './keyring';
import { ROUTES, type RouteDefinition, type RouteId } from './routes';

/** Cookie-authenticated requests that change state must send this header, which a cross-site form cannot. */
export const CSRF_HEADER = 'x-memnest-csrf';
export const DEFAULT_SESSION_COOKIE = 'memnest_session';

export interface ServerOptions {
  /** The embedded engine, or anything else implementing the API. */
  memnest: MemnestApi;
  auth: AuthStore;
  /** Job events for `GET /v1/events`. Default: a new hub; wire `server.events.publish` into the queue's `onEvent`. */
  events?: JobEventHub;
  clock?: Clock;
  session?: {
    /** Default `memnest_session`. */
    cookieName?: string;
    /** Default true. Browsers accept Secure cookies on http://localhost; set false only for other plain-HTTP hosts. */
    secureCookie?: boolean;
    /** Default 12 hours. */
    ttlMs?: number;
  };
  /** Default 5 MiB. */
  maxBodyBytes?: number;
  /** SSE keep-alive interval. Default 15s. */
  heartbeatMs?: number;
  /** Test hook for the keyring (e.g. cheaper argon2 parameters). */
  keyring?: Partial<Omit<KeyringOptions, 'auth' | 'clock'>>;
}

export interface MemnestServer {
  app: Hono<ServerEnv>;
  fetch: (request: Request) => Response | Promise<Response>;
  keyring: Keyring;
  events: JobEventHub;
}

interface Principal {
  key: ApiKeyRecord;
  session?: { token: string; record: SessionRecord };
}

interface ServerEnv {
  Variables: {
    principal: Principal;
    /** Undefined only for `container: 'none'` routes and unfiltered `any` routes with an unscoped key. */
    scope: Scope | undefined;
  };
}

const STATUS: Record<MemnestErrorCode, ContentfulStatusCode> = {
  validation: 400,
  unauthorized: 401,
  scope_violation: 403,
  not_found: 404,
  configuration: 409,
  provenance: 422,
  internal: 500,
  transactions_unsupported: 500,
  not_implemented: 501,
  provider: 502,
};

const errorBody = (code: MemnestErrorCode, message: string) => ({ error: { code, message } });

async function readJson(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('request body must be a JSON object');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('request body must be a JSON object');
  return body as Record<string, unknown>;
}

function intQuery(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new ValidationError(`${name} must be a non-negative integer`);
  return value;
}

function boolQuery(c: Context, name: string): boolean | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ValidationError(`${name} must be true or false`);
}

const requireScope = (c: Context<ServerEnv>): Scope => c.get('scope')!;

function sessionView(principal: Principal) {
  return {
    keyId: principal.key.id,
    name: principal.key.name,
    containerTag: principal.key.containerTag ?? null,
    via: principal.session ? 'session' : 'key',
    ...(principal.session ? { expiresAt: principal.session.record.expiresAt } : {}),
  };
}

export function createServer(options: ServerOptions): MemnestServer {
  const { memnest } = options;
  const clock = options.clock ?? systemClock;
  const events = options.events ?? createJobEventHub();
  const cookieName = options.session?.cookieName ?? DEFAULT_SESSION_COOKIE;
  const secureCookie = options.session?.secureCookie ?? true;
  const sessionTtlMs = options.session?.ttlMs ?? 12 * 60 * 60 * 1000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const keyring = createKeyring({ ...options.keyring, auth: options.auth, clock, sessionTtlMs });
  const app = new Hono<ServerEnv>();

  app.onError((error, c) => {
    if (error instanceof MemnestError) return c.json(errorBody(error.code, error.message), STATUS[error.code] ?? 500);
    if (error instanceof HTTPException) {
      const status = error.status as ContentfulStatusCode;
      return c.json(errorBody(status === 401 ? 'unauthorized' : status >= 500 ? 'internal' : 'validation', error.message), status);
    }
    // Never echo unexpected errors: they can carry SQL, stack traces or content.
    return c.json(errorBody('internal', 'internal server error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', `no route for ${c.req.method} ${new URL(c.req.url).pathname}`), 404));

  async function authenticate(c: Context<ServerEnv>): Promise<Principal> {
    const header = c.req.header('authorization');
    if (header !== undefined) {
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      if (!match) throw new UnauthorizedError('Authorization must be "Bearer <api key>"');
      return { key: await keyring.verify(match[1]!) };
    }
    const token = getCookie(c, cookieName);
    if (token !== undefined) {
      const { session, key } = await keyring.resolveSession(token);
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header(CSRF_HEADER) === undefined) {
        throw new MemnestError('unauthorized', `cookie-authenticated ${c.req.method} requests must send the ${CSRF_HEADER} header`);
      }
      return { key, session: { token, record: session } };
    }
    throw new UnauthorizedError();
  }

  async function resolveScope(c: Context<ServerEnv>, def: RouteDefinition, key: ApiKeyRecord): Promise<Scope | undefined> {
    let requested: unknown;
    switch (def.container) {
      case 'none':
        return undefined;
      case 'path':
        requested = c.req.param('containerTag');
        break;
      case 'query':
      case 'any':
        requested = c.req.query('containerTag');
        break;
      case 'body':
        requested = (await readJson(c)).containerTag;
        break;
    }
    if (key.containerTag !== undefined) {
      if (requested !== undefined && requested !== key.containerTag) {
        throw new MemnestError('scope_violation', `this key is scoped to container "${key.containerTag}" and cannot use another container`);
      }
      return scopeOf(key.containerTag);
    }
    if (requested === undefined) {
      if (def.container === 'any') return undefined;
      throw new ValidationError('containerTag is required: this key is not scoped to a container');
    }
    return scopeOf(requested as string);
  }

  const limitBody = bodyLimit({
    maxSize: options.maxBodyBytes ?? 5 * 1024 * 1024,
    onError: (c) => c.json(errorBody('validation', 'request body is too large'), 413),
  });

  /** Registers a route from the table. Authentication and scope injection happen here, never in handlers. */
  function route(id: RouteId, handler: (c: Context<ServerEnv>) => Response | Promise<Response>): void {
    const def: RouteDefinition = ROUTES[id];
    app.on(def.method, def.path, limitBody, async (c) => {
      if (def.auth) {
        const principal = await authenticate(c);
        c.set('principal', principal);
        c.set('scope', await resolveScope(c, def, principal.key));
      }
      return handler(c);
    });
  }

  route('health', (c) => c.json({ ok: true }));

  route('createSession', async (c) => {
    const { apiKey } = await readJson(c);
    if (typeof apiKey !== 'string') throw new ValidationError('apiKey is required');
    const { token, session, key } = await keyring.createSession(apiKey);
    setCookie(c, cookieName, token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(sessionTtlMs / 1000),
    });
    return c.json(sessionView({ key, session: { token, record: session } }), 201);
  });

  route('getSession', (c) => c.json(sessionView(c.get('principal'))));

  route('deleteSession', async (c) => {
    const { session } = c.get('principal');
    if (session) {
      await keyring.endSession(session.token);
      deleteCookie(c, cookieName, { path: '/', secure: secureCookie });
    }
    return c.body(null, 204);
  });

  route('addDocument', async (c) => {
    const body = await readJson(c);
    const input: AddInput = { ...(body as unknown as AddInput), containerTag: requireScope(c).containerTag };
    return c.json(await memnest.add(input), 202);
  });

  route('getDocument', async (c) => {
    const id = c.req.param('id')!;
    const found = await memnest.getDocument(requireScope(c), id);
    if (!found) throw new NotFoundError('document', id);
    return c.json(found);
  });

  route('deleteDocument', async (c) => {
    await memnest.deleteDocument(requireScope(c), c.req.param('id')!);
    return c.body(null, 204);
  });

  route('search', async (c) => {
    const { query, include, options: searchOptions } = await readJson(c);
    if (typeof query !== 'string') throw new ValidationError('query must be a string');
    if (searchOptions !== undefined && (searchOptions === null || typeof searchOptions !== 'object' || Array.isArray(searchOptions))) {
      throw new ValidationError('options must be an object');
    }
    const targets = include === undefined ? ['memories', 'chunks'] : include;
    if (!Array.isArray(targets) || targets.length === 0 || targets.some((t) => t !== 'memories' && t !== 'chunks')) {
      throw new ValidationError('include must be a non-empty array of "memories" and "chunks"');
    }
    const scope = requireScope(c);
    const opts = (searchOptions ?? {}) as SearchOptions;
    if (!targets.includes('chunks')) return c.json({ memories: await memnest.searchMemories(query, scope, opts) });
    if (!targets.includes('memories')) return c.json({ chunks: await memnest.searchDocuments(query, scope, opts) });
    return c.json(await memnest.search(query, scope, opts));
  });

  route('profile', async (c) => c.json(await memnest.profile(requireScope(c))));
  route('rebuildProfile', async (c) => c.json(await memnest.rebuildProfile(requireScope(c))));

  route('listMemories', async (c) => {
    const after = c.req.query('after');
    const kind = c.req.query('kind');
    const latestOnly = boolQuery(c, 'latestOnly');
    const includeForgotten = boolQuery(c, 'includeForgotten');
    const filter: MemoryFilter = {
      ...(kind !== undefined ? { kind: kind as MemoryKind } : {}),
      ...(latestOnly !== undefined ? { latestOnly } : {}),
      ...(includeForgotten !== undefined ? { includeForgotten } : {}),
    };
    const page = { limit: intQuery(c, 'limit') ?? 100, ...(after !== undefined ? { after } : {}) };
    return c.json(await memnest.listMemories(requireScope(c), page, filter));
  });

  route('addMemories', async (c) => {
    const body = await readJson(c);
    const input: DirectMemoryInput = { ...(body as unknown as DirectMemoryInput), containerTag: requireScope(c).containerTag };
    return c.json(await memnest.addMemories(input), 201);
  });

  route('getMemory', async (c) => {
    const id = c.req.param('id')!;
    const memory = await memnest.getMemory(requireScope(c), id);
    if (!memory) throw new NotFoundError('memory', id);
    return c.json(memory);
  });

  route('getLineage', async (c) => {
    const id = c.req.param('id')!;
    const lineage = await memnest.getLineage(requireScope(c), id);
    if (!lineage) throw new NotFoundError('memory', id);
    return c.json(lineage);
  });

  route('forget', async (c) => c.json(await memnest.forget(requireScope(c), c.req.param('id')!)));

  route('graph', async (c) => {
    const limit = intQuery(c, 'limit');
    const includeSuperseded = boolQuery(c, 'includeSuperseded');
    const includeForgotten = boolQuery(c, 'includeForgotten');
    const opts: SnapshotOpts = {
      ...(limit !== undefined ? { limit } : {}),
      ...(includeSuperseded !== undefined ? { includeSuperseded } : {}),
      ...(includeForgotten !== undefined ? { includeForgotten } : {}),
    };
    return c.json(await memnest.graph(requireScope(c), opts));
  });

  route('deleteContainer', async (c) => {
    await memnest.deleteContainer(requireScope(c));
    return c.body(null, 204);
  });

  route('listRuns', async (c) => {
    const limit = intQuery(c, 'limit');
    const documentId = c.req.query('documentId');
    return c.json(
      await memnest.listExtractionRuns(requireScope(c), { ...(limit !== undefined ? { limit } : {}), ...(documentId ? { documentId } : {}) }),
    );
  });

  route('events', (c) => {
    const scope = c.get('scope');
    return streamSSE(c, async (stream) => {
      // Writes are chained so events arrive in the order they were published.
      let chain: Promise<void> = Promise.resolve();
      const send = (event: string, data: string) => {
        chain = chain.then(() => stream.writeSSE({ event, data })).catch(() => undefined);
        return chain;
      };
      const unsubscribe = events.subscribe((event) => {
        if (!scope || event.containerTag === scope.containerTag) void send('job', JSON.stringify(event));
      });
      stream.onAbort(unsubscribe);
      try {
        await send('ready', JSON.stringify({ containerTag: scope?.containerTag ?? null }));
        while (!stream.aborted && !stream.closed) {
          await stream.sleep(heartbeatMs);
          if (!stream.aborted) await send('ping', '');
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return { app, fetch: (request) => app.fetch(request), keyring, events };
}
