import type { GraphSnapshot, LineageGraph, MemnestApi, Scope, SnapshotOpts } from '@memnest/core';
import type { App } from '@modelcontextprotocol/ext-apps';

/** The part of `MemnestApi` the graph controller uses. */
export type GraphSource = Pick<MemnestApi, 'graph' | 'getLineage'>;

async function callJson<T>(app: App, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  if (result.isError) throw new Error(text || `${name} failed`);
  return JSON.parse(text) as T;
}

/**
 * Reads the graph through the MCP host, which forwards the calls to the Memnest MCP server.
 * The server is bound to one container, so the scope the controller passes is not sent;
 * `onContainer` learns the real one from each snapshot.
 */
export function mcpGraphSource(app: App, onContainer?: (containerTag: string) => void): GraphSource {
  return {
    graph: async (_scope: Scope, opts?: SnapshotOpts) => {
      const snapshot = await callJson<GraphSnapshot>(app, 'graph_snapshot', opts?.limit ? { limit: opts.limit } : {});
      onContainer?.(snapshot.containerTag);
      return snapshot;
    },
    getLineage: async (_scope: Scope, memoryId: string) => {
      try {
        return await callJson<LineageGraph>(app, 'graph_lineage', { memoryId });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('not_found')) return null;
        throw error;
      }
    },
  };
}
