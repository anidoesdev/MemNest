import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { Point } from '../geometry';
import type { LayoutEdge, LayoutNode } from './types';

export interface ForceOptions {
  /** Simulation ticks. Default 300, fewer for large graphs. */
  iterations?: number;
  /** Seed for the simulation's randomness. Same seed, same input, same output. Default 1. */
  seed?: number;
  /** Starting positions, e.g. the previous layout, so nodes stay where the user saw them. */
  initial?: ReadonlyMap<string, Point> | ReadonlyArray<[string, Point]>;
  /** Default 36. */
  linkDistance?: number;
  /** Many-body strength per node. Default -40. */
  charge?: number;
  /** Extra space kept around each node. Default 2. */
  collidePadding?: number;
  /** Collision passes per tick; more keeps large circles apart. Default 1. */
  collideIterations?: number;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  r: number;
}

/**
 * A seeded generator in [0, 1) (mulberry32). Not a plain LCG: consecutive LCG outputs are correlated,
 * so (angle, radius) pairs fall on lattice lines and a scatter comes out as visible spiral arms.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** d3-force layout run to completion off-screen: link, many-body, collision and weak centring. */
export function forceLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: ForceOptions = {}): Map<string, Point> {
  const initial = options.initial instanceof Map ? options.initial : new Map(options.initial ?? []);
  // Unplaced nodes start scattered in a disk sized for their count. d3's default spiral leaves visible rings
  // when most nodes are unconnected, because nothing pulls them out of it.
  const scatter = seededRandom((options.seed ?? 1) * 7919);
  const disk = Math.sqrt(nodes.length) * ((options.linkDistance ?? 36) * 0.9);
  const simNodes: SimNode[] = nodes.map((n) => {
    const start = initial.get(n.id);
    if (start) return { id: n.id, r: n.r ?? 6, x: start.x, y: start.y };
    const angle = scatter() * Math.PI * 2;
    const radius = Math.sqrt(scatter()) * disk;
    return { id: n.id, r: n.r ?? 6, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  const ids = new Set(simNodes.map((n) => n.id));
  const links: Array<SimulationLinkDatum<SimNode>> = edges
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e) => ({ source: e.from, target: e.to }));

  const n = simNodes.length;
  const iterations = options.iterations ?? (n > 1000 ? 240 : 300);
  const simulation = forceSimulation<SimNode>(simNodes)
    .randomSource(seededRandom(options.seed ?? 1))
    .alphaDecay(1 - Math.pow(0.001, 1 / iterations))
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((d) => d.id)
        .distance(options.linkDistance ?? 36)
        .strength(0.6),
    )
    // No distanceMax: a cutoff leaves circular seams at that radius (rings of nodes) in large, sparse graphs.
    .force('charge', forceManyBody<SimNode>().strength(options.charge ?? -40).theta(0.9))
    .force('collide', forceCollide<SimNode>((d) => d.r + (options.collidePadding ?? 2)).iterations(options.collideIterations ?? 1))
    .force('x', forceX<SimNode>(0).strength(0.04))
    .force('y', forceY<SimNode>(0).strength(0.04))
    .stop();
  for (let i = 0; i < iterations; i++) simulation.tick();

  const positions = new Map<string, Point>();
  for (const node of simNodes) positions.set(node.id, { x: Math.round(node.x! * 10) / 10, y: Math.round(node.y! * 10) / 10 });
  return positions;
}
