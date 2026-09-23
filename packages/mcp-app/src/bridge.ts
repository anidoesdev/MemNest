import type { MemnestApi, Scope } from '@memnest/core';
import type { App } from '@modelcontextprotocol/ext-apps';

/** The part of `MemnestApi` the dashboard's controllers use. */
export type DashboardSource = Pick<MemnestApi, 'graph' | 'getLineage' | 'getMemory' | 'getDocument' | 'listMemories' | 'search' | 'forget'>;

async function callJson<T>(app: App, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  if (result.isError) throw new Error(text || `${name} failed`);
  return JSON.parse(text) as T;
}

/**
 * The dashboard's data, read through the MCP host, which forwards each call to the Memnest MCP server.
 * The server is bound to one container, so the scope the controllers pass is never sent;
 * `onContainer` learns the real one from the first graph snapshot.
 */
export function mcpDashboardSource(app: App, onContainer?: (containerTag: string) => void): DashboardSource {
  const read = <T>(args: Record<string, unknown>) => callJson<T>(app, 'dashboard_read', args);
  return {
    graph: async (_scope: Scope, options) => {
      const snapshot = await read<Awaited<ReturnType<MemnestApi['graph']>>>({ method: 'graph', ...(options ? { options } : {}) });
      onContainer?.(snapshot.containerTag);
      return snapshot;
    },
    getLineage: (_scope, memoryId) => read({ method: 'getLineage', memoryId }),
    getMemory: (_scope, memoryId) => read({ method: 'getMemory', memoryId }),
    getDocument: (_scope, documentId) => read({ method: 'getDocument', documentId }),
    listMemories: (_scope, page, filter) => read({ method: 'listMemories', ...(page ? { options: page } : {}), ...(filter ? { filter } : {}) }),
    search: (query, _scope, options) => read({ method: 'search', query, ...(options ? { options } : {}) }),
    forget: (_scope, memoryId) => callJson(app, 'dashboard_forget', { memoryId }),
  };
}
