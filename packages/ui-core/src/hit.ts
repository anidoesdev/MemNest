import { quadtree } from 'd3-quadtree';
import type { Point } from './geometry';

export interface HitCircle {
  id: string;
  x: number;
  y: number;
  r: number;
}

export interface HitIndex {
  /** The circle under a world point, allowing `slop` extra world units for small targets. */
  pick(world: Point, slop?: number): HitCircle | null;
  readonly size: number;
}

/** A quadtree over circle centres: picking stays logarithmic at 10,000 nodes. */
export function createHitIndex(circles: readonly HitCircle[]): HitIndex {
  const tree = quadtree<HitCircle>(
    [...circles],
    (c) => c.x,
    (c) => c.y,
  );
  const maxR = circles.reduce((max, c) => Math.max(max, c.r), 0);
  return {
    size: circles.length,
    pick(world, slop = 0) {
      // Nearest centre within reach of the largest circle, then an exact containment check.
      const candidate = tree.find(world.x, world.y, maxR + slop);
      if (candidate && Math.hypot(candidate.x - world.x, candidate.y - world.y) <= candidate.r + slop) return candidate;
      // A large circle can contain the point while a small neighbour's centre is nearer.
      let best: HitCircle | null = null;
      let bestDistance = Infinity;
      tree.visit((node, x0, y0, x1, y1) => {
        if (!node.length) {
          for (let leaf: typeof node | undefined = node; leaf; leaf = (leaf as { next?: typeof node }).next) {
            const c = (leaf as { data: HitCircle }).data;
            const d = Math.hypot(c.x - world.x, c.y - world.y);
            if (d <= c.r + slop && d < bestDistance) {
              best = c;
              bestDistance = d;
            }
          }
        }
        const reach = maxR + slop;
        return x0 > world.x + reach || x1 < world.x - reach || y0 > world.y + reach || y1 < world.y - reach;
      });
      return best;
    },
  };
}
