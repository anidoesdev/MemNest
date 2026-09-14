import type { MemnestApi, Memory } from '@memnest/core';
import { createDetailController, type DetailController } from './controllers/detail';
import { createFinderController, type FinderController } from './controllers/finder';
import { createGraphController, type GraphController, type GraphControllerOptions } from './controllers/graph';
import { createLineageController, type LineageController } from './controllers/lineage';
import { createTimelineController, type TimelineController } from './controllers/timeline';
import { createTraceController, type TraceController } from './controllers/trace';
import type { LayoutRunner } from './layout/runner';
import { createStore, type Observable } from './store';

export interface SelectionState {
  memoryId: string | null;
}

export interface Workspace {
  containerTag: string;
  selection: Observable<SelectionState>;
  /** Selecting a memory anywhere opens its detail and lineage, and highlights it in the graph. */
  select(memoryId: string | null): void;
  finder: FinderController;
  detail: DetailController;
  lineage: LineageController;
  trace: TraceController;
  timeline: TimelineController;
  graph: GraphController;
  /** Reloads every view that has data, e.g. after new memories arrive. */
  refresh(): Promise<void>;
  dispose(): void;
}

export interface WorkspaceOptions {
  client: MemnestApi;
  containerTag: string;
  layout?: LayoutRunner;
  graph?: Pick<GraphControllerOptions, 'clusterThreshold' | 'limit' | 'filter' | 'autoload'>;
  now?: () => string;
}

/** Every controller for one container, wired so selection and forgetting stay consistent across views. */
export function createWorkspace(options: WorkspaceOptions): Workspace {
  const { client, containerTag } = options;
  const selection = createStore<SelectionState>({ memoryId: null });
  let workspace: Workspace;

  const onForgotten = (_memory: Memory) => {
    // A forgotten memory changes what search returns, what the graph shows and what the timeline says.
    void Promise.all([
      workspace.finder.run(),
      workspace.trace.rerun(),
      workspace.timeline.rerun(),
      workspace.graph.load(),
      workspace.lineage.reload(),
    ]);
  };

  const select = (memoryId: string | null) => {
    if (selection.getState().memoryId === memoryId) return;
    selection.set({ memoryId });
    workspace.graph.select(memoryId);
    if (memoryId) {
      void workspace.detail.load(memoryId);
      void workspace.lineage.load(memoryId);
    } else {
      workspace.detail.clear();
      workspace.lineage.clear();
    }
  };

  workspace = {
    containerTag,
    selection,
    select,
    finder: createFinderController({ client, containerTag }),
    detail: createDetailController({ client, containerTag, onForgotten }),
    lineage: createLineageController({ client, containerTag }),
    trace: createTraceController({ client, containerTag }),
    timeline: createTimelineController({ client, containerTag, ...(options.now ? { now: options.now } : {}) }),
    graph: createGraphController({
      client,
      containerTag,
      ...options.graph,
      ...(options.layout ? { layout: options.layout } : {}),
      onSelect: (memoryId) => select(memoryId),
    }),
    async refresh() {
      await Promise.all([
        workspace.finder.run(),
        workspace.trace.rerun(),
        workspace.timeline.rerun(),
        workspace.graph.load(),
        workspace.detail.reload(),
        workspace.lineage.reload(),
      ]);
    },
    dispose() {
      for (const controller of [workspace.finder, workspace.detail, workspace.lineage, workspace.trace, workspace.timeline, workspace.graph]) {
        controller.dispose();
      }
    },
  };
  return workspace;
}
