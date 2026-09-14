import type { Point } from '../geometry';
import { forceLayout, type ForceOptions } from './force';
import { layeredLayout, type LayeredOptions } from './layered';
import type { LayoutEdge, LayoutNode } from './types';

export type LayoutRequest =
  | { algorithm: 'force'; nodes: LayoutNode[]; edges: LayoutEdge[]; options?: Omit<ForceOptions, 'initial'> & { initial?: Array<[string, Point]> } }
  | { algorithm: 'layered'; nodes: LayoutNode[]; edges: LayoutEdge[]; options?: LayeredOptions };

/** d3-force for the global graph, a layered (Sugiyama-style) layout for lineage DAGs. */
export function computeLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: { algorithm: 'force' } & ForceOptions): Map<string, Point>;
export function computeLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: { algorithm: 'layered' } & LayeredOptions): Map<string, Point>;
export function computeLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  opts: ({ algorithm: 'force' } & ForceOptions) | ({ algorithm: 'layered' } & LayeredOptions),
): Map<string, Point> {
  return opts.algorithm === 'layered' ? layeredLayout(nodes, edges, opts) : forceLayout(nodes, edges, opts);
}

export function runLayoutRequest(request: LayoutRequest): Map<string, Point> {
  return request.algorithm === 'layered'
    ? layeredLayout(request.nodes, request.edges, request.options)
    : forceLayout(request.nodes, request.edges, request.options);
}

export { forceLayout, seededRandom, type ForceOptions } from './force';
export { layeredLayout, type LayeredOptions } from './layered';
export type { LayoutEdge, LayoutNode } from './types';
