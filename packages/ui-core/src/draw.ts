import type { MemoryKind } from '@memnest/core';
import type { GraphState } from './controllers/graph';
import { clusterRadius, nodeRadius, shorten } from './encoding';
import type { Size, Viewport } from './geometry';

export interface CanvasGradientLike {
  addColorStop(offset: number, color: string): void;
}

/** The subset of CanvasRenderingContext2D the renderer uses. No DOM types. */
export interface Canvas2DLike {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradientLike;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  globalCompositeOperation: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  lineJoin: string;
  lineCap: string;
}

/** Colours are hex (#rgb or #rrggbb) wherever the renderer derives glows from them. */
export interface GraphTheme {
  /**
   * How light meets the ground. On a dark ground neurons and signals add light, so they glow; on a light
   * ground adding light would wash out to white, so they lay soft colour down instead.
   */
  ground: 'dark' | 'light';
  /** A flat ground, dark or light to match `ground`. */
  background: string;
  /** The bright core of a signal travelling along a connection. */
  spark: string;
  kinds: Record<MemoryKind, string>;
  /** Clusters are neutral: their colour would otherwise suggest a kind they do not have. */
  cluster: string;
  clusterStroke: string;
  edges: { updates: string; extends: string; aggregate: string };
  label: string;
  labelHalo: string;
  selection: string;
  lineage: string;
  /** Opacity of superseded memories. */
  supersededAlpha: number;
  /** Opacity of forgotten memories (drawn hollow). */
  forgottenAlpha: number;
  font: string;
}

export interface SceneCircle {
  id: string;
  x: number;
  y: number;
  r: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  alpha: number;
  /** How brightly the neuron shines, 0–1. */
  glow: number;
  selected: boolean;
  /** Stable per circle in [0, 1): varies each pulse so no two breathe in step. */
  seed: number;
  label: string | null;
  /** Higher labels win when space is short. */
  priority: number;
}

export interface SceneLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The circle the line ends at, which flashes when a signal arrives. */
  to: string | null;
  color: string;
  width: number;
  alpha: number;
  dash: number[] | null;
  /** Draw an arrowhead at (x2, y2), outside a circle of this radius. */
  arrow: number | null;
  /** Stable per line in [0, 1): sets its curve and when it fires. */
  seed: number;
}

export interface Scene {
  circles: SceneCircle[];
  lines: SceneLine[];
}

/** A stable pseudo-random number in [0, 1) for a string. */
function seedOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  // Finalise, so ids that differ by one character land far apart.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** Turns graph state into drawable primitives in world coordinates. Pure. */
export function buildGraphScene(state: GraphState, theme: GraphTheme): Scene {
  const { positions, selectedId, lineage } = state;
  const circles: SceneCircle[] = [];
  const lines: SceneLine[] = [];

  if (state.mode === 'clusters') {
    for (const edge of state.clusterEdges) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) continue;
      lines.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        to: edge.to,
        color: theme.edges.aggregate,
        width: Math.min(6, 1 + Math.log2(edge.weight)),
        alpha: 0.5,
        dash: null,
        arrow: null,
        seed: seedOf(`${edge.from} ${edge.to}`),
      });
    }
    for (const cluster of state.clusters) {
      const p = positions.get(cluster.id);
      if (!p) continue;
      circles.push({
        id: cluster.id,
        x: p.x,
        y: p.y,
        r: clusterRadius(cluster.count),
        fill: theme.cluster,
        stroke: theme.clusterStroke,
        strokeWidth: 1,
        // Translucent, so the glow behind shows through.
        alpha: 0.62,
        glow: 0.45 + Math.min(0.4, Math.log10(cluster.count) / 8),
        selected: false,
        seed: seedOf(cluster.id),
        label: `${cluster.label} · ${cluster.count.toLocaleString('en')}`,
        priority: cluster.count,
      });
    }
    return { circles, lines };
  }

  const radius = new Map(state.nodes.map((n) => [n.id, nodeRadius(n)]));
  const lineageEdges = new Set(lineage?.edges.map((e) => `${e.from} ${e.to}`) ?? []);
  for (const edge of state.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;
    const inLineage = lineageEdges.has(`${edge.from} ${edge.to}`);
    lines.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      to: edge.to,
      color: inLineage ? theme.lineage : edge.relation === 'updates' ? theme.edges.updates : theme.edges.extends,
      width: inLineage ? 2.5 : 1.25,
      alpha: lineage && !inLineage ? 0.25 : 0.9,
      // updates: solid with an arrow to the replaced fact; extends: dotted, no arrow.
      dash: edge.relation === 'extends' ? [0.5, 4] : null,
      arrow: edge.relation === 'updates' ? radius.get(edge.to) ?? 6 : null,
      seed: seedOf(`${edge.from} ${edge.to}`),
    });
  }
  for (const node of state.nodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    const selected = node.id === selectedId;
    const inLineage = lineage?.memoryIds.has(node.id) ?? false;
    const dimmed = Boolean(lineage) && !inLineage && !selected;
    const base = node.forgotten ? theme.forgottenAlpha : node.isLatest ? 1 : theme.supersededAlpha;
    // Reinforced memories shine brighter; superseded ones smoulder; forgotten ones have gone dark.
    const glow = node.forgotten ? 0 : node.isLatest ? 0.55 + Math.min(0.45, 0.12 * (node.reinforcementCount - 1)) : 0.22;
    circles.push({
      id: node.id,
      x: p.x,
      y: p.y,
      r: radius.get(node.id)!,
      fill: node.forgotten ? null : theme.kinds[node.kind],
      stroke: selected ? theme.selection : inLineage ? theme.lineage : node.forgotten ? theme.kinds[node.kind] : null,
      strokeWidth: selected ? 3 : inLineage || node.forgotten ? 2 : 0,
      alpha: dimmed ? base * 0.35 : base,
      glow: dimmed ? glow * 0.3 : selected ? 1 : glow,
      selected,
      seed: seedOf(node.id),
      label: shorten(node.content, 42),
      priority: (selected ? 1e9 : 0) + (inLineage ? 1e6 : 0) + node.reinforcementCount * 10 + (node.isLatest ? 5 : 0),
    });
  }
  return { circles, lines };
}

export interface DrawOptions {
  pixelRatio?: number;
  /** Maximum labels per frame. Default 160. */
  maxLabels?: number;
  /**
   * Milliseconds on any steady clock. When given, neurons breathe and signals travel along
   * connections, lighting up the memory they reach. Omit for a still frame (reduced motion, snapshots).
   */
  time?: number;
}

const TAU = Math.PI * 2;
/** Only topics are this large: a memory's radius tops out at 16. */
const TOPIC_RADIUS = 17;

function parseHex(color: string): [number, number, number] | null {
  let hex = color.trim();
  if (!hex.startsWith('#')) return null;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** `color` at `alpha`, for hex colours; anything else passes through (or clears, at alpha 0). */
function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return alpha <= 0 ? 'rgba(0,0,0,0)' : color;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** `color` moved towards `toward` by `t`, for hex colours. */
function mix(color: string, toward: string, t: number): string {
  const a = parseHex(color);
  const b = parseHex(toward);
  if (!a || !b) return color;
  const channel = (i: number) => Math.round(a[i]! + (b[i]! - a[i]!) * t);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

/**
 * Unit radial gradients (radius 1 at the origin), made once per context and colour. Drawn through a
 * transform that places and scales them, so thousands of glowing neurons cost no gradient allocations.
 */
const spriteCache = new WeakMap<object, Map<string, CanvasGradientLike>>();

function unitGradient(ctx: Canvas2DLike, key: string, stops: () => Array<[number, string]>): CanvasGradientLike {
  let cache = spriteCache.get(ctx);
  if (!cache) spriteCache.set(ctx, (cache = new Map()));
  let gradient = cache.get(key);
  if (!gradient) {
    gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [offset, color] of stops()) gradient.addColorStop(offset, color);
    cache.set(key, gradient);
  }
  return gradient;
}

const haloGradient = (ctx: Canvas2DLike, color: string, ground: GraphTheme['ground']) =>
  unitGradient(ctx, `halo ${ground} ${color}`, () =>
    ground === 'dark'
      ? [
          [0, withAlpha(color, 0.6)],
          [0.22, withAlpha(color, 0.26)],
          [0.55, withAlpha(color, 0.07)],
          [1, withAlpha(color, 0)],
        ]
      : // A soft tint: on a light ground a strong halo reads as a stain, not a glow.
        [
          [0, withAlpha(color, 0.34)],
          [0.25, withAlpha(color, 0.15)],
          [0.6, withAlpha(color, 0.04)],
          [1, withAlpha(color, 0)],
        ],
  );

const coreGradient = (ctx: Canvas2DLike, color: string, ground: GraphTheme['ground']) =>
  unitGradient(ctx, `core ${ground} ${color}`, () =>
    ground === 'dark'
      ? [
          [0, mix(color, '#ffffff', 0.9)],
          [0.3, mix(color, '#ffffff', 0.45)],
          [0.75, color],
          [1, mix(color, '#000000', 0.3)],
        ]
      : // A softer highlight and a firmer edge, so the neuron keeps its shape against white.
        [
          [0, mix(color, '#ffffff', 0.6)],
          [0.45, mix(color, '#ffffff', 0.12)],
          [0.85, color],
          [1, mix(color, '#000000', 0.2)],
        ],
  );

const sparkGradient = (ctx: Canvas2DLike, color: string, core: string) =>
  unitGradient(ctx, `spark ${color} ${core}`, () => [
    [0, withAlpha(core, 1)],
    [0.15, withAlpha(mix(color, core, 0.5), 0.9)],
    [0.4, withAlpha(color, 0.3)],
    [1, withAlpha(color, 0)],
  ]);

/**
 * Draws a scene to a 2D canvas as a glowing neural network. Labels appear once a circle is large enough
 * on screen to own one, highest priority first, capped per frame, so 2,000 nodes stay legible and fast.
 */
export function drawScene(ctx: Canvas2DLike, scene: Scene, viewport: Viewport, size: Size, theme: GraphTheme, options: DrawOptions = {}): void {
  const ratio = options.pixelRatio ?? 1;
  const live = options.time !== undefined;
  const time = options.time ?? 0;
  const { k } = viewport;
  // Light adds up on a dark ground; on a light one, colour is laid down.
  const glow = theme.ground === 'dark' ? 'lighter' : 'source-over';
  ctx.save();
  // A plain ground: only the neurons and their connections carry colour.
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, size.width, size.height);

  const world = () => ctx.setTransform(ratio * k, 0, 0, ratio * k, ratio * viewport.x, ratio * viewport.y);
  /** Maps the unit square to a square of half-width `r` centred on a world point. */
  const place = (x: number, y: number, r: number) => {
    const scale = ratio * k * r;
    ctx.setTransform(scale, 0, 0, scale, ratio * (viewport.x + x * k), ratio * (viewport.y + y * k));
  };

  // Cull to the visible world rectangle.
  const margin = 80 / k;
  const minX = -viewport.x / k - margin;
  const minY = -viewport.y / k - margin;
  const maxX = (size.width - viewport.x) / k + margin;
  const maxY = (size.height - viewport.y) / k + margin;
  const visible = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;

  // Connections: curved axons with a soft glow, each firing a signal now and then.
  world();
  ctx.globalCompositeOperation = glow;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const flashes = new Map<string, number>();
  const sparks: Array<{ x: number; y: number; color: string; strength: number }> = [];
  const lines = scene.lines.filter((line) => visible(line.x1, line.y1) || visible(line.x2, line.y2));
  // Light adds up: the more connections on screen, the dimmer each, so dense regions glow instead of burning white.
  const density = Math.min(1, 12 / Math.sqrt(lines.length || 1));
  for (const line of lines) {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    const length = Math.hypot(dx, dy) || 1;
    const bend = (line.seed - 0.5) * 0.4 * length;
    const cx = (line.x1 + line.x2) / 2 - (dy / length) * bend;
    const cy = (line.y1 + line.y2) / 2 + (dx / length) * bend;

    ctx.strokeStyle = line.color;
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y1);
    ctx.quadraticCurveTo(cx, cy, line.x2, line.y2);
    ctx.setLineDash([]);
    ctx.globalAlpha = line.alpha * 0.1 * density;
    ctx.lineWidth = (line.width * 4) / k;
    ctx.stroke();
    ctx.setLineDash(line.dash ? line.dash.map((d) => d / k) : []);
    ctx.globalAlpha = line.alpha * (0.25 + 0.35 * density);
    ctx.lineWidth = line.width / k;
    ctx.stroke();

    if (line.arrow !== null) {
      const angle = Math.atan2(line.y2 - cy, line.x2 - cx);
      const tipX = line.x2 - Math.cos(angle) * (line.arrow + 1.5 / k);
      const tipY = line.y2 - Math.sin(angle) * (line.arrow + 1.5 / k);
      // Arrowheads scale with the node on screen, so a zoomed-out graph is not all arrows.
      const head = Math.min(6, Math.max(2, line.arrow * k)) / k;
      ctx.setLineDash([]);
      ctx.fillStyle = line.color;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(angle - 0.45) * head, tipY - Math.sin(angle - 0.45) * head);
      ctx.lineTo(tipX - Math.cos(angle + 0.45) * head, tipY - Math.sin(angle + 0.45) * head);
      ctx.fill();
    }

    if (live) {
      const period = 2800 + line.seed * 6000;
      const travel = Math.min(2400, Math.max(700, length * 9));
      const u = ((time + line.seed * 9973) % period) / travel;
      if (u <= 1) {
        const e = u < 0.5 ? 2 * u * u : 1 - (2 - 2 * u) ** 2 / 2;
        const inv = 1 - e;
        sparks.push({
          x: inv * inv * line.x1 + 2 * inv * e * cx + e * e * line.x2,
          y: inv * inv * line.y1 + 2 * inv * e * cy + e * e * line.y2,
          color: line.color,
          strength: Math.min(1, line.alpha * 1.1) * Math.sin(Math.PI * Math.min(1, u * 1.15 + 0.08)),
        });
      } else if (line.to && u < 1.5) {
        flashes.set(line.to, Math.max(flashes.get(line.to) ?? 0, 1 - (u - 1) / 0.5));
      }
    }
  }
  ctx.setLineDash([]);

  for (const spark of sparks) {
    place(spark.x, spark.y, Math.min(9, Math.max(4, 3 * k)) / k);
    ctx.globalAlpha = Math.max(0, spark.strength);
    ctx.fillStyle = sparkGradient(ctx, spark.color, theme.spark);
    ctx.fillRect(-1, -1, 2, 2);
  }

  // Halos.
  const shown = scene.circles.filter((c) => visible(c.x, c.y));
  const crowd = Math.min(1, 22 / Math.sqrt(shown.length || 1));
  for (const circle of shown) {
    const color = circle.fill ?? circle.stroke;
    const flash = flashes.get(circle.id) ?? 0;
    const pulse = live ? 0.75 + 0.25 * Math.sin(time / (1100 + circle.seed * 1400) + circle.seed * TAU) : 1;
    const strength = Math.min(1, circle.glow * (pulse * crowd + flash * 0.55));
    if (!color || strength <= 0.01) continue;
    // At a distance, each memory still reads as a point of light rather than a pinprick.
    place(circle.x, circle.y, Math.max(circle.r * (3 + flash * 0.8), 7 / k));
    ctx.globalAlpha = strength;
    ctx.fillStyle = haloGradient(ctx, color, theme.ground);
    ctx.fillRect(-1, -1, 2, 2);
  }

  // Cell bodies: a bright nucleus fading to the kind's colour; one arc each for fill and ring.
  ctx.globalCompositeOperation = 'source-over';
  const labelled: SceneCircle[] = [];
  for (const circle of shown) {
    place(circle.x, circle.y, circle.r);
    // A faded neuron is a ghost: a faint glassy body and a thin rim in its colour. Dimming the colour itself
    // would turn amber into brown on a dark ground.
    const ghost = circle.fill !== null && circle.alpha < 1 && circle.r < TOPIC_RADIUS;
    ctx.globalCompositeOperation = ghost ? glow : 'source-over';
    ctx.globalAlpha = ghost ? circle.alpha * 0.45 : circle.alpha;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    if (circle.fill) {
      ctx.fillStyle = coreGradient(ctx, circle.fill, theme.ground);
      ctx.fill();
    }
    if (circle.stroke && circle.strokeWidth > 0) {
      ctx.globalAlpha = circle.alpha;
      ctx.strokeStyle = circle.stroke;
      ctx.lineWidth = circle.strokeWidth / (k * circle.r);
      ctx.stroke();
    } else if (ghost) {
      ctx.globalAlpha = Math.min(1, circle.alpha * 2);
      ctx.strokeStyle = circle.fill!;
      ctx.lineWidth = 1 / (k * circle.r);
      ctx.stroke();
    }
    if (circle.label && (circle.r * k >= 9 || circle.priority >= 1e6)) labelled.push(circle);
  }

  // The selected memory sends out a slow ripple.
  ctx.globalCompositeOperation = glow;
  world();
  if (live) {
    for (const circle of shown) {
      if (!circle.selected) continue;
      const phase = (time % 2400) / 2400;
      ctx.globalAlpha = 0.6 * (1 - phase);
      ctx.strokeStyle = circle.stroke ?? theme.selection;
      ctx.lineWidth = 1.5 / k;
      ctx.beginPath();
      ctx.arc(circle.x, circle.y, circle.r * (1.3 + phase * 2.2), 0, TAU);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  labelled.sort((a, z) => z.priority - a.priority);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.font = theme.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const taken: Array<[number, number, number, number]> = [];
  for (const circle of labelled.slice(0, options.maxLabels ?? 160)) {
    const x = circle.x * k + viewport.x;
    const y = (circle.y + circle.r) * k + viewport.y + 6;
    const width = circle.label!.length * 6.2;
    const box: [number, number, number, number] = [x - width / 2, y, x + width / 2, y + 14];
    if (taken.some(([x0, y0, x1, y1]) => box[0] < x1 && box[2] > x0 && box[1] < y1 && box[3] > y0)) continue;
    taken.push(box);
    ctx.globalAlpha = Math.max(circle.alpha, 0.7);
    ctx.strokeStyle = theme.labelHalo;
    ctx.lineWidth = 4;
    ctx.strokeText(circle.label!, x, y);
    ctx.fillStyle = theme.label;
    ctx.fillText(circle.label!, x, y);
  }
  ctx.restore();
}
