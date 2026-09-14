import type { GraphNode } from '@memnest/core';

/** Size by reinforcementCount: a fact stated five times is visibly bigger than one stated once. */
export const nodeRadius = (node: Pick<GraphNode, 'reinforcementCount'>): number =>
  5 + Math.min(11, 2.5 * Math.sqrt(Math.max(0, node.reinforcementCount - 1)));

export const clusterRadius = (count: number): number => 14 + Math.min(70, 3.2 * Math.sqrt(count));

export const documentRadius = 7;

/** Shortens text for labels at a word boundary. */
export function shorten(text: string, max = 48): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}
