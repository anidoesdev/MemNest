import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  clusterNodes,
  computeLayout,
  createHitIndex,
  createWorkerLayoutRunner,
  fitViewport,
  forceLayout,
  layeredLayout,
  serveLayoutRequests,
  toScreen,
  toWorld,
  zoomAt,
  type MessagePortLike,
} from '../src/index';

describe('layered layout', () => {
  const nodes = ['new', 'mid', 'old', 'ext', 'doc1', 'doc2', 'doc3'].map((id) => ({ id }));
  const edges = [
    { from: 'new', to: 'mid' },
    { from: 'mid', to: 'old' },
    { from: 'ext', to: 'new' },
    { from: 'new', to: 'doc3' },
    { from: 'mid', to: 'doc2' },
    { from: 'old', to: 'doc1' },
  ];

  it('puts every edge target in a later layer, with no two nodes in the same place', () => {
    const positions = layeredLayout(nodes, edges);
    for (const { from, to } of edges) expect(positions.get(to)!.x).toBeGreaterThan(positions.get(from)!.x);
    const spots = new Set([...positions.values()].map((p) => `${p.x},${p.y}`));
    expect(spots.size).toBe(nodes.length);
  });

  it('is deterministic and survives cycles and unknown ids', () => {
    expect([...layeredLayout(nodes, edges)]).toEqual([...layeredLayout(nodes, edges)]);
    const cyclic = layeredLayout([{ id: 'a' }, { id: 'b' }], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'a', to: 'ghost' },
    ]);
    expect(cyclic.size).toBe(2);
    for (const p of cyclic.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('orders a layer to follow its predecessors (fewer crossings)', () => {
    const positions = layeredLayout(
      [{ id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'y' }],
      [
        { from: 'a', to: 'y' },
        { from: 'b', to: 'x' },
      ],
    );
    expect(Math.sign(positions.get('a')!.y - positions.get('b')!.y)).toBe(Math.sign(positions.get('y')!.y - positions.get('x')!.y));
  });
});

describe('force layout', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, r: 6 }));
  const edges = Array.from({ length: 40 }, (_, i) => ({ from: `n${i}`, to: `n${(i * 7 + 3) % 60}` }));

  it('is deterministic for a seed and finite everywhere', () => {
    const a = forceLayout(nodes, edges, { seed: 7 });
    const b = forceLayout(nodes, edges, { seed: 7 });
    expect([...a]).toEqual([...b]);
    for (const p of a.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('keeps linked nodes closer than unlinked ones on average', () => {
    const positions = computeLayout(nodes, edges, { algorithm: 'force' });
    const distance = (a: string, b: string) => Math.hypot(positions.get(a)!.x - positions.get(b)!.x, positions.get(a)!.y - positions.get(b)!.y);
    const linked = edges.reduce((sum, e) => sum + distance(e.from, e.to), 0) / edges.length;
    let unlinked = 0;
    for (let i = 0; i < 40; i++) unlinked += distance(`n${i}`, `n${(i + 30) % 60}`);
    expect(linked).toBeLessThan(unlinked / 40);
  });

  it('starts from previous positions so a re-layout does not scramble the picture', () => {
    const first = forceLayout(nodes, edges);
    const again = forceLayout(nodes, edges, { initial: first, iterations: 5 });
    const drift = [...first].reduce((sum, [id, p]) => sum + Math.hypot(p.x - again.get(id)!.x, p.y - again.get(id)!.y), 0) / nodes.length;
    expect(drift).toBeLessThan(10);
  });
});

describe('worker layout runner', () => {
  it('lays out large graphs through the worker protocol and small ones inline', async () => {
    const { port1, port2 } = new MessageChannel();
    const worker = port2 as unknown as MessagePortLike;
    let served = 0;
    const counting: MessagePortLike = {
      postMessage: (m) => worker.postMessage(m),
      addEventListener: (type, listener) =>
        worker.addEventListener(type, (event) => {
          served++;
          listener(event);
        }),
      removeEventListener: () => undefined,
    };
    const stop = serveLayoutRequests(counting);
    const runner = createWorkerLayoutRunner(port1 as unknown as MessagePortLike, { threshold: 50 });

    const big = Array.from({ length: 80 }, (_, i) => ({ id: `n${i}` }));
    const remote = await runner.run({ algorithm: 'force', nodes: big, edges: [], options: { seed: 3 } });
    expect(served).toBe(1);
    expect([...remote]).toEqual([...forceLayout(big, [], { seed: 3 })]);

    const small = await runner.run({ algorithm: 'layered', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] });
    expect(served).toBe(1);
    expect(small.get('b')!.x).toBeGreaterThan(small.get('a')!.x);

    runner.dispose?.();
    stop();
    port1.close();
    port2.close();
  });
});

describe('viewport and hit testing', () => {
  it('fits bounds into the canvas and zooms around the pointer', () => {
    const bounds = boundsOf([
      { x: -100, y: -50, r: 0 },
      { x: 300, y: 150, r: 0 },
    ]);
    const viewport = fitViewport(bounds, { width: 800, height: 400 }, 0);
    expect(toScreen(viewport, { x: 100, y: 50 })).toEqual({ x: 400, y: 200 });
    const zoomed = zoomAt(viewport, { x: 123, y: 45 }, 2.5);
    const before = toWorld(viewport, { x: 123, y: 45 });
    const after = toWorld(zoomed, { x: 123, y: 45 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomed.k).toBeCloseTo(viewport.k * 2.5);
  });

  it('picks the circle under a point, including large circles whose centre is not nearest', () => {
    const index = createHitIndex([
      { id: 'big', x: 0, y: 0, r: 50 },
      { id: 'small', x: 45, y: 0, r: 3 },
      { id: 'far', x: 500, y: 500, r: 5 },
    ]);
    expect(index.pick({ x: 46, y: 0 })?.id).toBe('small');
    expect(index.pick({ x: 30, y: 25 })?.id).toBe('big');
    expect(index.pick({ x: 200, y: 200 })).toBeNull();
    expect(index.pick({ x: 507, y: 500 }, 3)?.id).toBe('far');
  });
});

describe('clustering', () => {
  const node = (id: string, content: string, extra: object = {}) => ({
    id,
    content,
    kind: 'fact' as const,
    confidence: 1,
    isLatest: true,
    forgotten: false,
    reinforcementCount: 1,
    validFrom: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });

  it('groups by the most widespread meaningful term, keeps the largest groups and aggregates edges', () => {
    const nodes = [
      node('a', 'Alex works at Stripe.'),
      node('b', 'Sam works at Figma.'),
      node('c', 'Priya works at Stripe.', { isLatest: false }),
      node('d', 'Jordan lives in Berlin.'),
      node('e', 'Mei lives in Lisbon.'),
      node('f', 'A lonely sentence.'),
    ];
    const { clusters, clusterOf, edges } = clusterNodes(nodes, [{ from: 'a', to: 'd', relation: 'extends' }]);
    expect(clusters.map((c) => [c.key, c.count])).toEqual([
      ['works', 3],
      ['lives', 2],
      ['', 1],
    ]);
    expect(clusters[0]!.inactive).toBe(1);
    expect(clusterOf.get('f')).toBe('cluster:*');
    expect(edges).toEqual([{ from: 'cluster:lives', to: 'cluster:works', weight: 1 }]);
  });

  it('refines with the search terms excluded, and caps the number of clusters', () => {
    const nodes = ['Stripe', 'Stripe', 'Figma', 'Figma', 'Notion'].map((org, i) => node(`n${i}`, `Person${i % 2} works at ${org}.`));
    expect(clusterNodes(nodes, [], { exclude: ['works'] }).clusters.map((c) => c.key)).not.toContain('works');
    const capped = clusterNodes(nodes, [], { exclude: ['works'], maxClusters: 2 });
    expect(capped.clusters).toHaveLength(2);
    expect(capped.clusters.reduce((sum, c) => sum + c.count, 0)).toBe(nodes.length);
  });
});
