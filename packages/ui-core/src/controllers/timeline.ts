import { scopeOf, type MemnestApi, type Memory } from '@memnest/core';
import { shorten } from '../encoding';
import { createSequencer, createStore, errorText, type Observable } from '../store';

export type TimelineStatus = 'current' | 'superseded' | 'expired' | 'forgotten';

export interface TimelineItem {
  memory: Memory;
  laneId: string;
  start: string;
  /** When the fact stopped (or will stop) being true. Null while it is true with no expiry. */
  end: string | null;
  status: TimelineStatus;
  /** The memory that replaced this one, when superseded. */
  supersededBy: string | null;
}

export interface TimelineLane {
  id: string;
  /** The newest fact in the lane. */
  label: string;
  items: TimelineItem[];
}

export interface TimelineTick {
  at: string;
  label: string;
}

export interface Timeline {
  lanes: TimelineLane[];
  range: { start: string; end: string } | null;
  ticks: TimelineTick[];
}

export interface TimelineState extends Timeline {
  topic: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
}

export interface TimelineController extends Observable<TimelineState> {
  setTopic(topic: string): void;
  run(): Promise<void>;
  rerun(): Promise<void>;
  dispose(): void;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const earliest = (...values: Array<string | undefined | null>) =>
  values.filter((v): v is string => typeof v === 'string').sort()[0] ?? null;

/**
 * Facts over time. Memories linked by UPDATES share a lane; each fact runs from `validFrom` until
 * it was superseded, expired or forgotten, whichever came first. Pure.
 */
export function buildTimeline(memories: readonly Memory[], now: string): Timeline {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const newer = new Map<string, Memory>();
  for (const m of memories) if (m.supersedes && byId.has(m.supersedes)) newer.set(m.supersedes, m);

  // Lanes: follow each chain to its oldest member.
  const laneOf = new Map<string, string>();
  const rootOf = (m: Memory): string => {
    const seen = new Set<string>();
    let current = m;
    while (current.supersedes && byId.has(current.supersedes) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.supersedes)!;
    }
    return current.id;
  };
  for (const m of memories) laneOf.set(m.id, rootOf(m));

  const items: TimelineItem[] = memories.map((memory) => {
    const replacement = newer.get(memory.id);
    const supersededAt = replacement ? earliest(replacement.validFrom, replacement.createdAt) : null;
    const expiredAt = memory.validUntil && memory.validUntil <= now ? memory.validUntil : null;
    const endedAt = earliest(supersededAt, expiredAt, memory.forgottenAt);
    const status: TimelineStatus =
      endedAt === null
        ? memory.isLatest
          ? 'current'
          : 'superseded'
        : endedAt === memory.forgottenAt
          ? 'forgotten'
          : endedAt === supersededAt
            ? 'superseded'
            : 'expired';
    return {
      memory,
      laneId: laneOf.get(memory.id)!,
      start: memory.validFrom,
      // A current fact with a future expiry shows where it will end.
      end: endedAt ?? memory.validUntil ?? null,
      status,
      supersededBy: replacement?.id ?? null,
    };
  });

  const lanes = new Map<string, TimelineItem[]>();
  for (const item of items) (lanes.get(item.laneId) ?? lanes.set(item.laneId, []).get(item.laneId)!).push(item);
  const laneList = [...lanes.entries()]
    .map(([id, laneItems]) => {
      laneItems.sort((a, z) => (a.start < z.start ? -1 : a.start > z.start ? 1 : a.memory.version - z.memory.version));
      return { id, label: shorten(laneItems.at(-1)!.memory.content, 60), items: laneItems };
    })
    .sort((a, z) => (a.items[0]!.start < z.items[0]!.start ? -1 : 1));

  if (items.length === 0) return { lanes: [], range: null, ticks: [] };
  const start = Date.parse(items.map((i) => i.start).sort()[0]!);
  const lastEnd = Math.max(Date.parse(now), ...items.map((i) => Date.parse(i.end ?? now)));
  // A little room either side, and at least a day, so a single point in time still reads as a line.
  const span = Math.max(lastEnd - start, DAY);
  const range = { start: iso(start - span * 0.03), end: iso(start + span * 1.03) };
  return { lanes: laneList, range, ticks: timeTicks(range.start, range.end) };
}

/** About `count` evenly spaced, human-readable ticks (UTC). */
export function timeTicks(start: string, end: string, count = 6): TimelineTick[] {
  const from = Date.parse(start);
  const to = Date.parse(end);
  const span = Math.max(to - from, 1);
  const withTime = span < 3 * DAY;
  const crossesYear = new Date(from).getUTCFullYear() !== new Date(to).getUTCFullYear();
  const format = new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : crossesYear ? { year: 'numeric' } : {}),
  });
  return Array.from({ length: count }, (_, i) => {
    const at = from + (span * i) / (count - 1);
    return { at: iso(at), label: format.format(at) };
  });
}

export function createTimelineController(options: { client: MemnestApi; containerTag: string; now?: () => string }): TimelineController {
  const { client } = options;
  const scope = scopeOf(options.containerTag);
  const now = options.now ?? (() => new Date().toISOString());
  const store = createStore<TimelineState>({ topic: '', status: 'idle', error: null, lanes: [], range: null, ticks: [] });
  const seq = createSequencer();
  let lastTopic: string | null = null;

  async function execute(topic: string): Promise<void> {
    const token = seq.next();
    lastTopic = topic;
    store.set({ status: 'loading', error: null });
    try {
      // The trace names every matching memory, superseded and forgotten ones included.
      const response = await client.search(topic, scope, { tokenBudget: 1, candidates: 30 });
      const found = new Map(response.memories.map((r) => [r.memory.id, r.memory]));
      const ids = response.trace.candidates.map((c) => c.memoryId);
      for (const memory of await Promise.all(ids.filter((id) => !found.has(id)).map((id) => client.getMemory(scope, id)))) {
        if (memory) found.set(memory.id, memory);
      }
      // Complete each version chain, so a switch shows both sides even if only one matched the words.
      const chainRoots = [...found.values()].filter((m) => m.supersedes || !m.isLatest).slice(0, 20);
      for (const graph of await Promise.all(chainRoots.map((m) => client.getLineage(scope, m.id)))) {
        for (const m of graph?.memories ?? []) {
          if (graph!.edges.some((e) => e.relation === 'updates' && (e.from === m.id || e.to === m.id))) found.set(m.id, m);
        }
      }
      if (!seq.isCurrent(token)) return;
      store.set({ status: 'ready', ...buildTimeline([...found.values()], now()) });
    } catch (error) {
      if (seq.isCurrent(token)) store.set({ status: 'error', error: errorText(error) });
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setTopic: (topic) => store.set({ topic }),
    async run() {
      const { topic } = store.getState();
      if (topic.trim()) await execute(topic);
    },
    async rerun() {
      if (lastTopic !== null) await execute(lastTopic);
    },
    dispose: () => seq.cancel(),
  };
}
