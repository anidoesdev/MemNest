import {
  buildGraphScene,
  createWorkspace,
  drawScene,
  type GraphController,
  type GraphPick,
  type GraphTheme,
  type Observable,
  type Workspace,
  type WorkspaceOptions,
} from '@memnest/ui-core';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

/** Subscribes a component to a ui-core controller. All logic stays in the controller. */
export function useController<S>(controller: Observable<S>): S {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/**
 * One workspace per client and container, created in an effect and disposed when either changes or
 * the component unmounts (StrictMode's double mount included). Null until the first effect runs.
 */
export function useWorkspace(options: WorkspaceOptions): Workspace | null {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  useEffect(() => {
    const created = createWorkspace(options);
    setWorkspace(created);
    return () => created.dispose();
    // Only a new client or container means a new workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.client, options.containerTag]);
  return workspace;
}

export interface GraphCanvasProps {
  controller: GraphController;
  theme: GraphTheme;
  className?: string;
  style?: CSSProperties;
  /** Called for clicks; the default selects nodes and expands clusters. */
  onPick?: (pick: GraphPick) => void;
  /** Let neurons breathe and signals travel. Default true; always still when the user prefers reduced motion. */
  animate?: boolean;
  'aria-label'?: string;
}

/** A canvas renderer over a graph controller: forwards size, pan, zoom and clicks; draws each state, animated. */
export function GraphCanvas({ controller, theme, className, style, onPick, animate = true, ...aria }: GraphCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useController(controller);
  const scene = useMemo(() => buildGraphScene(state, theme), [state, theme]);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => controller.setSize(entry!.contentRect.width, entry!.contentRect.height));
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      controller.zoomAt({ x: event.offsetX, y: event.offsetY }, Math.exp(-event.deltaY * 0.0015));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, [controller]);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const still = !animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    // requestAnimationFrame pauses in hidden tabs, so an idle dashboard costs nothing.
    const paint = (time: number) => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = state.size;
      if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio);
      if (element.height !== Math.round(height * ratio)) element.height = Math.round(height * ratio);
      drawScene(ctx, scene, state.viewport, state.size, theme, { pixelRatio: ratio, time: still ? undefined : time });
      if (!still) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [scene, state, theme, animate]);

  return (
    <canvas
      ref={canvas}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'grab', ...style }}
      role="img"
      aria-label={aria['aria-label'] ?? 'Memory graph'}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, moved: false };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) {
          controller.hover({ x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY });
          event.currentTarget.style.cursor = controller.getState().hover ? 'pointer' : 'grab';
          return;
        }
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 3) return;
        drag.current = { x: event.clientX, y: event.clientY, moved: true };
        controller.panBy(dx, dy);
      }}
      onPointerLeave={() => controller.hover(null)}
      onPointerUp={(event) => {
        const start = drag.current;
        drag.current = null;
        if (!start || start.moved) return;
        const pick = controller.pick({ x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY });
        if (onPick) onPick(pick);
        else if (pick?.type === 'cluster') controller.expandCluster(pick.id);
        else controller.select(pick?.id ?? null);
      }}
    />
  );
}
