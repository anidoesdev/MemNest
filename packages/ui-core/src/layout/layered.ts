import type { Point } from '../geometry';
import type { LayoutEdge, LayoutNode } from './types';

export interface LayeredOptions {
  /** Distance between layers (x). Default 220. */
  layerGap?: number;
  /** Distance between nodes in a layer (y). Default 84. */
  nodeGap?: number;
  /** Barycentre ordering passes. Default 6. */
  sweeps?: number;
}

/**
 * A Sugiyama-style layered layout for small DAGs (lineage): longest-path layering, so every edge
 * points to a later layer; barycentre sweeps to reduce crossings; even spacing within a layer.
 * Deterministic: the same input always yields the same positions. Edges run left → right,
 * `from` in an earlier layer than `to`. Edges that would close a cycle are ignored.
 */
export function layeredLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: LayeredOptions = {}): Map<string, Point> {
  const layerGap = options.layerGap ?? 220;
  const nodeGap = options.nodeGap ?? 84;
  const sweeps = options.sweeps ?? 6;

  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { from, to } of edges) {
    if (!known.has(from) || !known.has(to) || from === to) continue;
    out.get(from)!.push(to);
    incoming.get(to)!.push(from);
  }

  // Longest-path layering over a topological order (Kahn). Nodes left in a cycle keep layer 0.
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const remaining = new Map(ids.map((id) => [id, incoming.get(id)!.length]));
  const queue = ids.filter((id) => remaining.get(id) === 0);
  const acyclicOut = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const to of out.get(id)!) {
      layer.set(to, Math.max(layer.get(to)!, layer.get(id)! + 1));
      acyclicOut.get(id)!.push(to);
      remaining.set(to, remaining.get(to)! - 1);
      if (remaining.get(to) === 0) queue.push(to);
    }
  }

  const layers: string[][] = [];
  for (const id of ids) {
    const l = layer.get(id)!;
    (layers[l] ??= []).push(id);
  }
  const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, tos] of acyclicOut) for (const to of tos) predecessors.get(to)!.push(from);

  const position = new Map<string, number>();
  const index = () => layers.forEach((members) => members.forEach((id, i) => position.set(id, i)));
  index();
  const barycentre = (neighbours: string[], fallback: number) =>
    neighbours.length === 0 ? fallback : neighbours.reduce((sum, n) => sum + position.get(n)!, 0) / neighbours.length;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const members of order) {
      const keyed = members.map((id, i) => ({
        id,
        i,
        key: barycentre(down ? predecessors.get(id)! : acyclicOut.get(id)!, position.get(id)!),
      }));
      keyed.sort((a, z) => a.key - z.key || a.i - z.i);
      members.splice(0, members.length, ...keyed.map((k) => k.id));
      members.forEach((id, i) => position.set(id, i));
    }
  }

  const positions = new Map<string, Point>();
  layers.forEach((members, l) => {
    members.forEach((id, i) => positions.set(id, { x: l * layerGap, y: (i - (members.length - 1) / 2) * nodeGap }));
  });
  return positions;
}
