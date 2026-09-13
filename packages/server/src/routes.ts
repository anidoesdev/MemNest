/**
 * Every endpoint the server exposes, with how its container is named. The scope middleware reads
 * `container` and injects the Scope; handlers never read a container tag from the request.
 * The leakage suite is keyed by this table, so a new route without a probe fails typecheck, and
 * a route registered outside the table fails the suite.
 *
 * - `path`: the `:containerTag` path parameter.
 * - `query`: the `containerTag` query parameter.
 * - `body`: the `containerTag` field of the JSON body.
 * - `any`: optional `containerTag` query parameter; unscoped keys may omit it to see every container.
 * - `none`: no container (auth and health).
 */
export const ROUTES = {
  health: { method: 'GET', path: '/healthz', auth: false, container: 'none' },
  createSession: { method: 'POST', path: '/v1/session', auth: false, container: 'none' },
  getSession: { method: 'GET', path: '/v1/session', auth: true, container: 'none' },
  deleteSession: { method: 'DELETE', path: '/v1/session', auth: true, container: 'none' },

  addDocument: { method: 'POST', path: '/v1/documents', auth: true, container: 'body' },
  getDocument: { method: 'GET', path: '/v1/documents/:id', auth: true, container: 'query' },
  deleteDocument: { method: 'DELETE', path: '/v1/documents/:id', auth: true, container: 'query' },

  search: { method: 'POST', path: '/v1/search', auth: true, container: 'body' },
  profile: { method: 'GET', path: '/v1/profile/:containerTag', auth: true, container: 'path' },
  rebuildProfile: { method: 'POST', path: '/v1/profile/:containerTag/rebuild', auth: true, container: 'path' },

  listMemories: { method: 'GET', path: '/v1/memories', auth: true, container: 'query' },
  addMemories: { method: 'POST', path: '/v1/memories', auth: true, container: 'body' },
  getMemory: { method: 'GET', path: '/v1/memories/:id', auth: true, container: 'query' },
  getLineage: { method: 'GET', path: '/v1/memories/:id/lineage', auth: true, container: 'query' },
  forget: { method: 'POST', path: '/v1/memories/:id/forget', auth: true, container: 'query' },

  graph: { method: 'GET', path: '/v1/graph/:containerTag', auth: true, container: 'path' },
  deleteContainer: { method: 'DELETE', path: '/v1/containers/:containerTag', auth: true, container: 'path' },
  listRuns: { method: 'GET', path: '/v1/runs', auth: true, container: 'query' },
  events: { method: 'GET', path: '/v1/events', auth: true, container: 'any' },
} as const satisfies Record<string, RouteDefinition>;

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  auth: boolean;
  container: 'path' | 'query' | 'body' | 'any' | 'none';
}

export type RouteId = keyof typeof ROUTES;
