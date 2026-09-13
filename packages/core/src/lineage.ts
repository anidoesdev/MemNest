import type { DocumentRef, LineageEdge, LineageGraph, Memory } from './types';

export interface LineageLookup {
  getMemory(id: string): Promise<Memory | null>;
  /** Memories that supersede or extend `id`. */
  getDependents(id: string): Promise<Memory[]>;
  getDocuments(ids: string[]): Promise<DocumentRef[]>;
}

/** Maximum memories in one lineage graph. Keeps the DAG readable and the query bounded. */
export const LINEAGE_LIMIT = 250;

/**
 * Ancestors (what the root superseded or extends, transitively) and descendants
 * (what supersedes or extends the root, transitively), plus source documents.
 * Store implementations supply the lookups; all are already scope-bound.
 */
export async function traverseLineage(rootId: string, lookup: LineageLookup): Promise<LineageGraph | null> {
  const root = await lookup.getMemory(rootId);
  if (!root) return null;

  const memories = new Map<string, Memory>([[root.id, root]]);
  const edges = new Map<string, LineageEdge>();
  const addEdge = (edge: LineageEdge) => edges.set(`${edge.from}|${edge.to}|${edge.relation}`, edge);

  const ancestors: Memory[] = [root];
  while (ancestors.length > 0 && memories.size < LINEAGE_LIMIT) {
    const m = ancestors.pop()!;
    const parents: Array<[string, 'updates' | 'extends']> = [
      ...(m.supersedes ? [[m.supersedes, 'updates'] as [string, 'updates']] : []),
      ...m.extendsIds.map((id) => [id, 'extends'] as [string, 'extends']),
    ];
    for (const [parentId, relation] of parents) {
      const parent = memories.get(parentId) ?? (await lookup.getMemory(parentId));
      if (!parent) continue;
      addEdge({ from: m.id, to: parent.id, relation });
      if (!memories.has(parent.id)) {
        memories.set(parent.id, parent);
        ancestors.push(parent);
      }
    }
  }

  const descendants: Memory[] = [root];
  while (descendants.length > 0 && memories.size < LINEAGE_LIMIT) {
    const m = descendants.pop()!;
    for (const child of await lookup.getDependents(m.id)) {
      if (child.supersedes === m.id) addEdge({ from: child.id, to: m.id, relation: 'updates' });
      if (child.extendsIds.includes(m.id)) addEdge({ from: child.id, to: m.id, relation: 'extends' });
      if (!memories.has(child.id)) {
        memories.set(child.id, child);
        descendants.push(child);
      }
    }
  }

  const documentIds = new Set<string>();
  for (const m of memories.values()) {
    for (const docId of m.sourceDocumentIds) {
      documentIds.add(docId);
      addEdge({ from: m.id, to: docId, relation: 'source' });
    }
  }

  return {
    rootId,
    memories: [...memories.values()],
    documents: await lookup.getDocuments([...documentIds]),
    edges: [...edges.values()],
  };
}
