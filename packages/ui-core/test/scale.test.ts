import { seedMemories } from '@memnest/cli';
import { createMemnest, type Memnest } from '@memnest/core';
import { createInMemoryStore, sequentialIds } from '@memnest/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGraphScene, createGraphController, drawScene, toScreen, type Canvas2DLike, type GraphState, type GraphTheme, type Observable } from '../src/index';

const FIXTURE = 'fixture:10k';

function until<S>(observable: Observable<S>, predicate: (state: S) => boolean, timeoutMs = 60_000): Promise<S> {
  return new Promise((resolve, reject) => {
    if (predicate(observable.getState())) return resolve(observable.getState());
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    const unsubscribe = observable.subscribe(() => {
      if (!predicate(observable.getState())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(observable.getState());
    });
  });
}

const theme: GraphTheme = {
  ground: 'dark',
  background: '#000',
  spark: '#fff',
  kinds: { fact: '#2a6', preference: '#a62', episode: '#26a' },
  cluster: '#ddd',
  clusterStroke: '#999',
  edges: { updates: '#333', extends: '#777', aggregate: '#bbb' },
  label: '#111',
  labelHalo: '#fff',
  selection: '#f0f',
  lineage: '#fa0',
  supersededAlpha: 0.35,
  forgottenAlpha: 0.5,
  font: '12px sans-serif',
};

/** Counts drawing calls instead of painting. */
function countingCanvas() {
  const calls = { arcs: 0, lines: 0, labels: 0 };
  const ctx: Canvas2DLike = {
    save() {},
    restore() {},
    setTransform() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {
      calls.lines++;
    },
    quadraticCurveTo() {
      calls.lines++;
    },
    arc() {
      calls.arcs++;
    },
    fill() {},
    stroke() {},
    fillText() {
      calls.labels++;
    },
    strokeText() {},
    setLineDash() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: 'center',
    textBaseline: 'top',
    lineJoin: 'round',
    lineCap: 'butt',
  };
  return { ctx, calls };
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

describe('usable at 10,000 memories (M8)', () => {
  let memnest: Memnest;

  beforeAll(async () => {
    memnest = createMemnest({ store: createInMemoryStore(), ids: sequentialIds() });
    await seedMemories(memnest, { containerTag: FIXTURE, count: 10_000 });
  }, 120_000);

  it('opens as a few dozen labelled clusters, not a hairball, and draws them in milliseconds', async () => {
    const graph = createGraphController({ client: memnest, containerTag: FIXTURE });
    graph.setSize(1280, 800);
    const state = await until(graph, (s) => s.status === 'ready');

    expect(state.loaded).toBe(10_000);
    expect(state.mode).toBe('clusters');
    expect(state.clusters.length).toBeGreaterThan(3);
    expect(state.clusters.length).toBeLessThanOrEqual(48);
    expect(state.clusters.reduce((sum, c) => sum + c.count, 0)).toBe(state.matching);
    expect(state.nodes).toHaveLength(0);
    expect(state.layoutMs!).toBeLessThan(2000);

    const { ctx, calls } = countingCanvas();
    const frame = timed(() => drawScene(ctx, buildGraphScene(state, theme), state.viewport, state.size, theme));
    expect(calls.arcs).toBe(state.clusters.length);
    expect(frame.ms).toBeLessThan(50);

    // Clicking a cluster finds it under the pointer.
    const biggest = state.clusters[0]!;
    const pick = graph.pick(toScreen(state.viewport, state.positions.get(biggest.id)!));
    expect(pick).toEqual({ type: 'cluster', id: biggest.id, key: biggest.key });
    graph.dispose();
  });

  it('expands a cluster by searching its term, lays out the members and keeps interactions fast', async () => {
    const graph = createGraphController({ client: memnest, containerTag: FIXTURE });
    graph.setSize(1280, 800);
    let state: GraphState = await until(graph, (s) => s.status === 'ready');

    // Expanding may first yield finer clusters; keep expanding until members are shown.
    for (let depth = 0; state.mode === 'clusters' && depth < 4; depth++) {
      const cluster = state.clusters.find((c) => c.key && c.count <= 2000) ?? state.clusters.find((c) => c.key)!;
      graph.expandCluster(cluster.id);
      state = await until(graph, (s) => s.status === 'ready' && s.filter.search.includes(cluster.key));
    }
    expect(state.mode).toBe('nodes');
    expect(state.nodes.length).toBeGreaterThan(50);
    expect(state.nodes.length).toBeLessThanOrEqual(2000);
    expect(state.layoutMs!).toBeLessThan(15_000);

    const { ctx, calls } = countingCanvas();
    const frame = timed(() => drawScene(ctx, buildGraphScene(state, theme), state.viewport, state.size, theme));
    expect(frame.ms).toBeLessThan(250);
    expect(calls.labels).toBeLessThanOrEqual(160);
    // An animated frame, with signals travelling, stays within budget too.
    const animated = timed(() => drawScene(ctx, buildGraphScene(state, theme), state.viewport, state.size, theme, { time: 12_345 }));
    expect(animated.ms).toBeLessThan(250);

    const node = state.nodes[0]!;
    const pick = timed(() => graph.pick(toScreen(state.viewport, state.positions.get(node.id)!)));
    expect(pick.value).toMatchObject({ type: 'node' });
    expect(pick.ms).toBeLessThan(5);

    const filtering = timed(() => graph.setFilter({ kinds: ['fact'] }));
    expect(filtering.ms).toBeLessThan(100);
    graph.dispose();
  }, 60_000);

  it('shows superseded memories dimmed and forgotten ones hollow when included', async () => {
    const graph = createGraphController({ client: memnest, containerTag: FIXTURE, filter: { includeForgotten: true, search: 'works' } });
    graph.setSize(1280, 800);
    const state = await until(graph, (s) => s.status === 'ready' && s.mode === 'nodes');
    const scene = buildGraphScene(state, theme);
    const superseded = state.nodes.find((n) => !n.isLatest && !n.forgotten)!;
    const forgotten = state.nodes.find((n) => n.forgotten)!;
    expect(scene.circles.find((c) => c.id === superseded.id)).toMatchObject({ alpha: theme.supersededAlpha });
    expect(scene.circles.find((c) => c.id === forgotten.id)).toMatchObject({ fill: null, alpha: theme.forgottenAlpha });
    expect(scene.lines.some((l) => l.dash !== null)).toBe(true);
    expect(scene.lines.some((l) => l.arrow !== null)).toBe(true);
    graph.dispose();
  }, 60_000);
});
