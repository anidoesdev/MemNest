import { buildGraphScene, drawScene, shorten, toScreen, type GraphController, type GraphPick, type GraphTheme } from '@memnest/ui-core';

/**
 * The preview panel keeps one look in both page themes, so the graph theme is fixed here
 * rather than read from CSS. Colours match the --pv-* tokens in styles.css.
 */
export const PREVIEW_GRAPH_THEME: GraphTheme = {
  ground: 'dark',
  background: '#0c1311',
  spark: '#ffffff',
  kinds: { fact: '#6cc6ca', preference: '#d9a64c', episode: '#b39ddb' },
  cluster: '#8ea6ff',
  clusterStroke: '#c7d3ff',
  edges: { updates: '#8fd3d6', extends: '#d9a64c', aggregate: '#7d93e0' },
  label: '#e1eae5',
  labelHalo: 'rgba(12, 19, 17, 0.92)',
  selection: '#ffffff',
  lineage: '#ff6ad5',
  supersededAlpha: 0.35,
  forgottenAlpha: 0.6,
  font: "12px 'IBM Plex Sans', system-ui, sans-serif",
};

export interface GraphCanvasOptions {
  canvas: HTMLCanvasElement;
  controller: GraphController;
  theme?: GraphTheme;
  onPick?: (pick: GraphPick) => void;
  /** Called when the pointer moves, for a tooltip. */
  onHover?: (pick: GraphPick, x: number, y: number) => void;
  /**
   * Overlay for node labels. ui-core draws its own labels once a node is big enough on screen;
   * a small graph fits below that zoom, so a handful of nodes get DOM labels instead.
   */
  labels?: HTMLElement;
  /** Above this many nodes, labels are left to the canvas (and to zooming in). Default 14. */
  maxLabels?: number;
}

/**
 * Binds a canvas to a graph controller: forwards size, pan, zoom, hover and clicks, and paints
 * every state. All graph logic stays in @memnest/ui-core, exactly as in the dashboard.
 */
export function mountGraphCanvas(options: GraphCanvasOptions): () => void {
  const { canvas, controller } = options;
  const theme = options.theme ?? PREVIEW_GRAPH_THEME;
  const context = canvas.getContext('2d');
  if (!context) return () => undefined;

  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let frame = 0;
  let drag: { x: number; y: number; moved: boolean } | null = null;

  const labelEls = new Map<string, HTMLElement>();

  const syncLabels = (state: ReturnType<GraphController['getState']>) => {
    const host = options.labels;
    if (!host) return;
    const show = state.mode === 'nodes' && state.nodes.length <= (options.maxLabels ?? 14);
    const seen = new Set<string>();
    if (show) {
      // Nearest-first, so when two labels collide the one further down is dropped rather
      // than drawn over its neighbour.
      const placed: Array<{ x: number; y: number }> = [];
      const ordered = state.nodes
        .map((node) => ({ node, position: state.positions.get(node.id) }))
        .filter((entry): entry is { node: (typeof state.nodes)[number]; position: { x: number; y: number } } => !!entry.position)
        .sort((a, z) => a.position.y - z.position.y);

      for (const { node, position } of ordered) {
        const { x, y } = toScreen(state.viewport, position);
        if (x < -80 || y < -40 || x > state.size.width + 80 || y > state.size.height + 40) continue;
        // Labels are centred and at most 180px wide, so two within that span would collide.
        if (placed.some((p) => Math.abs(p.x - x) < 185 && Math.abs(p.y - y) < 24)) continue;
        placed.push({ x, y });
        seen.add(node.id);
        let el = labelEls.get(node.id);
        if (!el) {
          el = document.createElement('span');
          el.className = 'graph-label';
          labelEls.set(node.id, el);
          host.append(el);
        }
        el.textContent = shorten(node.content, 38);
        el.classList.toggle('faded', !node.isLatest || node.forgotten);
        // Centred under its node: the second translate is relative to the label's own size.
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, 12px)`;
      }
    }
    for (const [id, el] of labelEls) {
      if (seen.has(id)) continue;
      el.remove();
      labelEls.delete(id);
    }
  };

  const paint = (time: number) => {
    const state = controller.getState();
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = state.size;
    if (width > 0 && height > 0) {
      const w = Math.round(width * ratio);
      const h = Math.round(height * ratio);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      drawScene(context, buildGraphScene(state, theme), state.viewport, state.size, theme, {
        pixelRatio: ratio,
        ...(still ? {} : { time }),
      });
      syncLabels(state);
    }
    frame = requestAnimationFrame(paint);
  };
  frame = requestAnimationFrame(paint);

  const observer = new ResizeObserver(([entry]) => {
    const box = entry!.contentRect;
    controller.setSize(box.width, box.height);
  });
  observer.observe(canvas);

  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    controller.zoomAt({ x: event.offsetX, y: event.offsetY }, Math.exp(-event.deltaY * 0.0015));
  };
  canvas.addEventListener('wheel', wheel, { passive: false });

  const down = (event: PointerEvent) => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: PointerEvent) => {
    if (!drag) {
      const point = { x: event.offsetX, y: event.offsetY };
      controller.hover(point);
      const pick = controller.pick(point);
      canvas.style.cursor = pick ? 'pointer' : 'grab';
      options.onHover?.(pick, event.offsetX, event.offsetY);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag = { x: event.clientX, y: event.clientY, moved: true };
    controller.panBy(dx, dy);
  };
  const leave = () => {
    controller.hover(null);
    options.onHover?.(null, 0, 0);
  };
  const up = (event: PointerEvent) => {
    const start = drag;
    drag = null;
    if (!start || start.moved) return;
    const pick = controller.pick({ x: event.offsetX, y: event.offsetY });
    if (options.onPick) options.onPick(pick);
    else if (pick?.type === 'cluster') controller.expandCluster(pick.id);
    else controller.select(pick?.id ?? null);
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('pointerup', up);

  return () => {
    cancelAnimationFrame(frame);
    for (const el of labelEls.values()) el.remove();
    labelEls.clear();
    observer.disconnect();
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerleave', leave);
    canvas.removeEventListener('pointerup', up);
  };
}
