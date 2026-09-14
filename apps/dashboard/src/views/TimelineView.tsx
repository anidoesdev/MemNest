import type { TimelineItem, Workspace } from '@memnest/ui-core';
import { shorten } from '@memnest/ui-core';
import { useController } from '@memnest/ui-react';
import { useEffect, useState } from 'react';
import { EmptyState, ErrorNote, KindDot } from '../components';
import { KIND_LABEL, formatDate } from '../format';

const LANE = 64;
const TOP = 34;
const SIDE = 44;
/** Approximate width of one character of label text, for truncation. */
const CHAR = 6.6;

/** Width of an element that may mount later (a callback ref, so the observer attaches when it appears). */
function useWidth<T extends Element>(): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

const STATUS_TEXT: Record<TimelineItem['status'], string> = {
  current: 'true now',
  superseded: 'superseded',
  expired: 'expired',
  forgotten: 'forgotten',
};

/** One entity or topic, its facts over time: superseded facts greyed, each switch dated. */
export function TimelineView({ workspace }: { workspace: Workspace }) {
  const { timeline } = workspace;
  const state = useController(timeline);
  const { memoryId } = useController(workspace.selection);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<{ item: TimelineItem; x: number; y: number } | null>(null);
  const now = new Date().toISOString();

  const { range, lanes, ticks } = state;
  const start = range ? Date.parse(range.start) : 0;
  const end = range ? Date.parse(range.end) : 1;
  const x = (iso: string) => SIDE + ((Date.parse(iso) - start) / Math.max(end - start, 1)) * (width - SIDE * 2);
  const height = TOP + lanes.length * LANE + 12;

  return (
    <div className="timeline-view">
      <form
        className="filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void timeline.run();
        }}
      >
        <input type="search" aria-label="Topic" placeholder="An entity or topic, e.g. payments database" value={state.topic} onChange={(e) => timeline.setTopic(e.target.value)} />
        <button className="button primary" type="submit" disabled={!state.topic.trim() || state.status === 'loading'}>
          {state.status === 'loading' ? 'Loading…' : 'Show'}
        </button>
      </form>
      <ErrorNote message={state.error} />

      {state.status === 'idle' && (
        <EmptyState title="Pick a topic to see how its facts changed">
          Facts that replaced each other share a row. A superseded fact ends where its replacement begins, so each switch carries its date.
        </EmptyState>
      )}
      {state.status === 'ready' && lanes.length === 0 && <EmptyState title="No memories about this topic" />}

      {range && lanes.length > 0 && (
        <div ref={ref} className={`timeline-wrap ${state.status === 'loading' ? 'refreshing' : ''}`}>
          <svg width={width} height={height} role="img" aria-label={`Timeline of ${state.topic}`} className="timeline">
            {ticks.map((tick) => (
              <g key={tick.at} transform={`translate(${x(tick.at)} 0)`}>
                <line y1={TOP - 8} y2={height} className="grid" />
                <text y={TOP - 14} className="tick">
                  {tick.label}
                </text>
              </g>
            ))}
            {now >= range.start && now <= range.end && (
              <g transform={`translate(${x(now)} 0)`}>
                <line y1={TOP - 8} y2={height} className="now" />
                <text y={height - 2} className="tick now-label">
                  now
                </text>
              </g>
            )}
            {lanes.map((lane, laneIndex) => {
              const y = TOP + laneIndex * LANE;
              return (
                <g key={lane.id} transform={`translate(0 ${y})`}>
                  {laneIndex > 0 && <line x1={0} x2={width} className="lane-rule" />}
                  {lane.items.map((item, itemIndex) => {
                    const x1 = x(item.start);
                    const x2 = Math.max(x1 + 4, x(item.end ?? range.end));
                    const selected = item.memory.id === memoryId;
                    // Labels alternate above and below the bar, so neighbours never share a line. A label runs until the
                    // next label on its line; near the right edge it is right-aligned to the bar's end instead.
                    const above = itemIndex % 2 === 1;
                    const nextOnLine = lane.items[itemIndex + 2];
                    const room = (nextOnLine ? x(nextOnLine.start) : width - 8) - x1 - 8;
                    const alignEnd = room < 140;
                    const dated = itemIndex > 0;
                    const dateText = dated ? `${formatDate(item.start)} · ` : '';
                    const chars = Math.max(10, Math.floor((alignEnd ? x2 - 8 : room) / CHAR) - dateText.length);
                    return (
                      <g
                        key={item.memory.id}
                        className={`span status-${item.status} ${selected ? 'selected' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${item.memory.content}. ${KIND_LABEL[item.memory.kind]}, ${STATUS_TEXT[item.status]}, from ${formatDate(item.start)}${item.end ? ` to ${formatDate(item.end)}` : ''}.`}
                        onClick={() => workspace.select(item.memory.id)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), workspace.select(item.memory.id))}
                        onPointerEnter={() => setHovered({ item, x: (x1 + x2) / 2, y: y + 30 })}
                        onPointerLeave={() => setHovered(null)}
                        onFocus={() => setHovered({ item, x: (x1 + x2) / 2, y: y + 30 })}
                        onBlur={() => setHovered(null)}
                      >
                        <rect x={x1} y={24} width={x2 - x1} height={30} className="hit" />
                        <rect x={x1} y={34} width={x2 - x1} height={10} rx={3} className={`bar kind-fill kind-${item.memory.kind}`} />
                        {item.end === null && <path d={`M${x2 - 1} 32 l6 7 l-6 7`} className="ongoing" />}
                        <text x={alignEnd ? x2 : x1} y={above ? 27 : 60} className="span-label" textAnchor={alignEnd ? 'end' : 'start'}>
                          {dated && <tspan className="switch-date">{dateText}</tspan>}
                          {shorten(item.memory.content, chars)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
          {hovered && (
            <div className="tooltip" style={{ left: hovered.x, top: hovered.y }} role="tooltip">
              <strong>{hovered.item.memory.content}</strong>
              <span>
                <KindDot kind={hovered.item.memory.kind} decorative /> {KIND_LABEL[hovered.item.memory.kind]} · {STATUS_TEXT[hovered.item.status]}
              </span>
              <span>
                {formatDate(hovered.item.start)} → {hovered.item.end ? formatDate(hovered.item.end) : 'now'}
              </span>
            </div>
          )}
          <div className="legend">
            <span className="legend-item">Solid: true for that period</span>
            <span className="legend-item muted">Faded: superseded · Hollow: forgotten · Thin: expired · Arrow: still true</span>
          </div>
        </div>
      )}
    </div>
  );
}
