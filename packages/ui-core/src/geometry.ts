export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** screen = world × k + (x, y) */
export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, k: 1 };
export const ZOOM_LIMITS = { min: 0.02, max: 8 } as const;

export function boundsOf(circles: Iterable<Point & { r?: number }>): Bounds | null {
  let bounds: Bounds | null = null;
  for (const { x, y, r = 0 } of circles) {
    if (!bounds) bounds = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
    else {
      bounds.minX = Math.min(bounds.minX, x - r);
      bounds.minY = Math.min(bounds.minY, y - r);
      bounds.maxX = Math.max(bounds.maxX, x + r);
      bounds.maxY = Math.max(bounds.maxY, y + r);
    }
  }
  return bounds;
}

/** The viewport that shows `bounds` centred in `size`, never zooming in past `maxK`. */
export function fitViewport(bounds: Bounds | null, size: Size, padding = 60, maxK = 2.5): Viewport {
  if (!bounds || size.width <= 0 || size.height <= 0) return { x: size.width / 2, y: size.height / 2, k: 1 };
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const k = clamp(
    Math.min((size.width - padding * 2) / width, (size.height - padding * 2) / height),
    ZOOM_LIMITS.min,
    maxK,
  );
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { x: size.width / 2 - cx * k, y: size.height / 2 - cy * k, k };
}

/** Zooms by `factor` keeping the world point under `screen` fixed. */
export function zoomAt(viewport: Viewport, screen: Point, factor: number): Viewport {
  const k = clamp(viewport.k * factor, ZOOM_LIMITS.min, ZOOM_LIMITS.max);
  const world = toWorld(viewport, screen);
  return { x: screen.x - world.x * k, y: screen.y - world.y * k, k };
}

export const panBy = (viewport: Viewport, dx: number, dy: number): Viewport => ({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });

export const toWorld = (viewport: Viewport, screen: Point): Point => ({ x: (screen.x - viewport.x) / viewport.k, y: (screen.y - viewport.y) / viewport.k });

export const toScreen = (viewport: Viewport, world: Point): Point => ({ x: world.x * viewport.k + viewport.x, y: world.y * viewport.k + viewport.y });

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
