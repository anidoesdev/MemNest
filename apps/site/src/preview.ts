import { MEMORY_KINDS, type ExtractionRun, type LineageGraph, type Memory, type MemoryKind, type SearchResponse } from '@memnest/core';
import { createGraphController, type GraphController } from '@memnest/ui-core';
import { createDemo, SESSIONS, type Demo, type IngestResult, type Session } from './demo';
import { mountGraphCanvas } from './graph';

type Child = Node | string | null | undefined | false;

/** Builds an element. Text is always set as text, never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const pill = (text: string, kind = text) => h('span', { class: `pill ${kind}` }, text);
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const short = (text: string, max = 64) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const SUGGESTIONS = [
  "What database does Acme's payments service use?",
  'How should we contact Priya during an incident?',
  'Is Acme on the Enterprise plan?',
  'When is the incident review?',
];

const KIND_LABEL: Record<MemoryKind, string> = { fact: 'Fact', preference: 'Preference', episode: 'Episode' };

interface State {
  demo: Demo;
  graph: GraphController;
  runs: Map<Session['id'], IngestResult>;
  memories: Memory[];
  open: Map<string, LineageGraph | null>;
  selected: string | null;
  tab: 'memories' | 'log' | 'profile';
  query: string;
  budget: number;
  result: SearchResponse | null;
  forgotten: boolean;
  jumped: boolean;
  busy: boolean;
}

export function mountPreview(root: HTMLElement): void {
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const els = {
    clock: $('[data-pv="clock"]'),
    hint: $('[data-pv="hint"]'),
    sessions: $('[data-pv="sessions"]'),
    jump: $<HTMLButtonElement>('[data-pv="jump"]'),
    reset: $<HTMLButtonElement>('[data-pv="reset"]'),
    canvas: $<HTMLCanvasElement>('[data-pv="canvas"]'),
    labels: $('[data-pv="labels"]'),
    legend: $('[data-pv="legend"]'),
    tooltip: $('[data-pv="tooltip"]'),
    graphNote: $('[data-pv="graph-note"]'),
    detail: $('[data-pv="detail"]'),
    fit: $<HTMLButtonElement>('[data-pv="fit"]'),
    tabs: [...root.querySelectorAll<HTMLButtonElement>('[data-pv-tab]')],
    counts: $('[data-pv="count"]'),
    panel: $('[data-pv="panel"]'),
    form: $<HTMLFormElement>('[data-pv="query-form"]'),
    query: $<HTMLInputElement>('[data-pv="query"]'),
    suggest: $('[data-pv="suggest"]'),
    budget: $<HTMLInputElement>('[data-pv="budget"]'),
    budgetOut: $<HTMLOutputElement>('[data-pv="budget-out"]'),
    answer: $('[data-pv="answer"]'),
  };

  let state: State = fresh();
  let unmountCanvas = mountCanvas();

  function fresh(): State {
    const demo = createDemo();
    return {
      demo,
      graph: createGraphController({
        client: demo.api,
        containerTag: demo.container,
        autoload: false,
        filter: { includeSuperseded: true, includeForgotten: true },
        onSelect: (id) => {
          state.selected = id;
          void render();
        },
      }),
      runs: new Map(),
      memories: [],
      open: new Map(),
      selected: null,
      tab: 'memories',
      query: SUGGESTIONS[0]!,
      budget: 200,
      result: null,
      forgotten: false,
      jumped: false,
      busy: false,
    };
  }

  function mountCanvas() {
    return mountGraphCanvas({
      canvas: els.canvas,
      controller: state.graph,
      labels: els.labels,
      onPick: (pick) => {
        if (pick?.type === 'cluster') state.graph.expandCluster(pick.id);
        else state.graph.select(pick?.id ?? null);
      },
      onHover: (pick, x, y) => {
        const node = pick?.type === 'node' ? state.graph.getState().nodes.find((n) => n.id === pick.id) : null;
        if (!node) {
          els.tooltip.hidden = true;
          return;
        }
        els.tooltip.hidden = false;
        els.tooltip.style.setProperty('--x', `${x}px`);
        els.tooltip.style.setProperty('--y', `${y}px`);
        els.tooltip.replaceChildren(
          h('b', {}, short(node.content, 90)),
          h('span', {}, `${node.kind}${node.isLatest ? '' : ' · superseded'}${node.forgotten ? ' · forgotten' : ''}`),
        );
      },
    });
  }

  const byId = () => new Map(state.memories.map((m) => [m.id, m]));
  const isExpired = (m: Memory) => !!m.validUntil && Date.parse(m.validUntil) <= Date.parse(state.demo.now());
  const statusOf = (m: Memory) => (m.forgottenAt ? 'forgotten' : !m.isLatest ? 'superseded' : isExpired(m) ? 'expired' : 'latest');

  /**
   * ui-core draws a node's label once its radius times the zoom reaches 9px. A handful of
   * memories fit at a lower zoom than that, so after fitting, zoom in as far as the nodes
   * still fit — a readable graph rather than unlabelled dots.
   */
  function fitAndLabel(): void {
    state.graph.fit();
    const { positions, size, viewport } = state.graph.getState();
    if (positions.size === 0 || size.width === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const { x, y } of positions.values()) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const padding = 120; // room for labels, which sit beside their node
    const fits = Math.min(
      (size.width - padding) / Math.max(maxX - minX, 1),
      (size.height - padding) / Math.max(maxY - minY, 1),
    );
    const target = Math.min(2.2, Math.max(viewport.k, Math.min(1.9, fits)));
    if (target > viewport.k * 1.02) {
      state.graph.zoomAt({ x: size.width / 2, y: size.height / 2 }, target / viewport.k);
    }
  }

  /** The layout runs after load() resolves, so fit once it has placed the nodes. */
  function fitWhenReady(): void {
    if (state.graph.getState().status === 'ready') {
      fitAndLabel();
      return;
    }
    const stop = state.graph.subscribe(() => {
      if (state.graph.getState().status !== 'ready') return;
      stop();
      fitAndLabel();
      renderGraphNote();
    });
  }

  async function refresh(options: { recall?: boolean; fit?: boolean } = {}) {
    state.memories = await state.demo.memories();
    for (const id of state.open.keys()) state.open.set(id, await state.demo.lineage(id));
    await state.graph.load();
    if (options.fit) fitWhenReady();
    if (options.recall !== false && state.query.trim()) state.result = await state.demo.recall(state.query, state.budget);
    await render();
  }

  async function act(fn: () => Promise<unknown>, options?: { recall?: boolean; fit?: boolean }) {
    if (state.busy) return;
    state.busy = true;
    try {
      await fn();
      await refresh(options);
    } finally {
      state.busy = false;
    }
  }

  // ---------- render ----------

  async function render() {
    els.clock.textContent = day(state.demo.now());
    renderHint();
    renderSessions();
    renderLegend();
    renderGraphNote();
    renderDetail();
    els.jump.disabled = !state.runs.has('followup') || state.jumped;
    els.tabs.forEach((tab) => {
      const on = tab.dataset.pvTab === state.tab;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    const latest = state.memories.filter((m) => statusOf(m) === 'latest').length;
    els.counts.textContent = `${latest} current · ${state.memories.length} stored`;
    els.panel.replaceChildren(...(await renderPanel()));
    els.query.value = state.query;
    els.budget.value = String(state.budget);
    els.budgetOut.value = `${state.budget} tok`;
    els.answer.replaceChildren(...renderAnswer());
  }

  function renderHint() {
    const [step, text] = !state.runs.has('ticket')
      ? ['Step 2', 'Ingest Ticket #4411. Priya mentions a migration in passing: watch a new node appear and an arrow point back at the fact it replaces.']
      : !state.runs.has('followup')
        ? ['Step 3', 'Ask again: the answer is MySQL now. The Postgres node is still there, faded, and the trace calls it not-latest. Then ingest the chat follow-up.']
        : !state.forgotten
          ? ['Step 4', 'The Enterprise plan "fact" came from a question, not an answer. Select it in the graph and forget it: the node goes hollow.']
          : !state.jumped
            ? ['Step 5', 'Jump to 1 July: the incident review has passed, so its memory expires and recall drops it.']
            : ['Your turn', 'Click any node for its history, ask your own questions, or add a fact below the graph. Reset to replay.'];
    els.hint.replaceChildren(h('span', { class: 'step' }, step), h('span', {}, text));
  }

  function summary(run: ExtractionRun): string {
    const s = run.stats;
    if (!s) return run.status;
    return [
      s.created && `${s.created} new`,
      s.updated && `${s.updated} updated`,
      s.extended && `${s.extended} extended`,
      s.reinforced && `${s.reinforced} reinforced`,
      s.rejected.length && `${s.rejected.length} rejected`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function renderSessions() {
    const next = SESSIONS.find((s) => !state.runs.has(s.id));
    els.sessions.replaceChildren(
      ...SESSIONS.map((session) => {
        const run = state.runs.get(session.id);
        const button = h('button', { class: `pv-btn${session === next ? ' go' : ''}`, type: 'button', disabled: session !== next }, run ? 'Ingested' : 'Ingest');
        button.addEventListener('click', (event) => {
          // The button lives in the <summary>, so keep the click from toggling the disclosure.
          event.preventDefault();
          event.stopPropagation();
          void act(
            async () => {
              state.runs.set(session.id, await state.demo.ingest(session.id));
              state.tab = 'log';
              if (session.id === 'ticket') state.query = SUGGESTIONS[0]!;
              if (session.id === 'followup') state.query = SUGGESTIONS[2]!;
            },
            { fit: true },
          );
        });
        return h(
          'details',
          { class: `session${run ? ' done' : ''}` },
          h(
            'summary',
            {},
            h(
              'span',
              { class: 'session-head' },
              h('span', { class: 'when' }, `${day(session.at)} · ${session.channel}`),
              h('b', {}, session.title),
              h('span', { class: 'state' }, run ? `✓ ${summary(run.run)}` : `${session.turns.length} turns · show`),
            ),
            button,
          ),
          h('ul', { class: 'turns' }, ...session.turns.map((t) => h('li', { class: t.role }, t.content))),
        );
      }),
    );
  }

  function renderLegend() {
    const graph = state.graph.getState();
    const active = (kind: MemoryKind) => graph.filter.kinds.length === 0 || graph.filter.kinds.includes(kind);
    const chips = MEMORY_KINDS.map((kind) => {
      const chip = h(
        'button',
        { class: `chip${active(kind) ? ' on' : ''}`, type: 'button', 'aria-pressed': String(active(kind)), 'data-kind': kind },
        h('i', { class: 'dot', 'aria-hidden': 'true' }),
        KIND_LABEL[kind],
      );
      chip.addEventListener('click', () => {
        const current = graph.filter.kinds.length === 0 ? [...MEMORY_KINDS] : graph.filter.kinds;
        const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
        state.graph.setFilter({ kinds: next.length === MEMORY_KINDS.length ? [] : next });
        void render();
      });
      return chip;
    });
    els.legend.replaceChildren(
      ...chips,
      h('span', { class: 'legend-key' }, h('i', { class: 'edge updates', 'aria-hidden': 'true' }), 'updates'),
      h('span', { class: 'legend-key' }, h('i', { class: 'edge extends', 'aria-hidden': 'true' }), 'extends'),
      h('span', { class: 'legend-key' }, h('i', { class: 'ring faded', 'aria-hidden': 'true' }), 'superseded'),
      h('span', { class: 'legend-key' }, h('i', { class: 'ring hollow', 'aria-hidden': 'true' }), 'forgotten'),
    );
  }

  function renderGraphNote() {
    const graph = state.graph.getState();
    const parts = [`${graph.matching} of ${graph.totalMemories} memories`];
    if (graph.mode === 'clusters') parts.push(`${graph.clusters.length} topic clusters — click one to expand`);
    if (graph.status === 'layout') parts.push('laying out…');
    els.graphNote.textContent = graph.totalMemories === 0 ? 'Nothing remembered yet. Ingest a conversation.' : parts.join(' · ');
  }

  function relationText(m: Memory): string | null {
    if (m.supersedes) return `updates ${m.supersedes}`;
    if (m.extendsIds.length) return `extends ${m.extendsIds.join(', ')}`;
    return null;
  }

  function memoryCard(m: Memory, options: { actions?: boolean } = {}): HTMLElement {
    const status = statusOf(m);
    const relation = relationText(m);
    const actions = options.actions
      ? h(
          'span',
          { class: 'actions' },
          (() => {
            const b = h('button', { class: 'link-btn', type: 'button', 'aria-expanded': String(state.open.has(m.id)) }, state.open.has(m.id) ? 'Hide history' : 'History');
            b.addEventListener('click', () =>
              act(
                async () => {
                  if (state.open.has(m.id)) state.open.delete(m.id);
                  else state.open.set(m.id, null);
                },
                { recall: false },
              ),
            );
            return b;
          })(),
          status === 'latest' || status === 'expired'
            ? (() => {
                const b = h('button', { class: 'link-btn danger', type: 'button' }, 'Forget');
                b.addEventListener('click', () =>
                  act(async () => {
                    await state.demo.forget(m.id);
                    state.forgotten = true;
                  }),
                );
                return b;
              })()
            : null,
        )
      : null;
    const card = h(
      'div',
      { class: `mem ${status}${state.selected === m.id ? ' selected' : ''}`, 'data-kind': m.kind },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'text' }, m.content),
      h(
        'span',
        { class: 'meta' },
        pill(status),
        h('span', {}, `${m.kind} · ${m.id}`),
        relation ? pill(relation.split(' ')[0]!) : null,
        relation ? h('span', {}, relation.split(' ').slice(1).join(' ')) : null,
        m.reinforcementCount > 1 ? h('span', {}, `reinforced ×${m.reinforcementCount}`) : null,
        m.validUntil ? h('span', {}, `until ${day(m.validUntil)}`) : null,
        actions,
      ),
    );
    card.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      state.graph.select(m.id);
    });
    const graph = state.open.get(m.id);
    if (state.open.has(m.id) && graph) card.append(renderLineage(graph));
    return card;
  }

  function renderLineage(graph: LineageGraph): HTMLElement {
    const memories = new Map(graph.memories.map((x) => [x.id, x]));
    const lines: Child[] = [h('span', {}, h('b', {}, 'History'))];
    for (const e of graph.edges.filter((edge) => edge.relation !== 'source')) {
      const to = memories.get(e.to);
      lines.push(h('span', {}, `${e.from} ${e.relation} ${e.to}: "${short(to?.content ?? '', 48)}"`));
    }
    for (const d of graph.documents) {
      lines.push(h('span', {}, `source ${d.id}: ${d.customId ?? d.kind} (${d.kind}, ${day(d.documentDate ?? d.createdAt)})`));
    }
    return h('div', { class: 'lineage' }, ...lines);
  }

  function renderDetail() {
    const selected = state.selected ? state.memories.find((m) => m.id === state.selected) : undefined;
    if (!selected) {
      els.detail.replaceChildren(h('p', { class: 'empty' }, 'Click a node to see the fact, where it came from, and what it replaced.'));
      return;
    }
    els.detail.replaceChildren(memoryCard(selected, { actions: true }));
  }

  async function renderPanel(): Promise<Node[]> {
    if (state.tab === 'log') return renderLog();
    if (state.tab === 'profile') return [await renderProfile()];
    return renderMemories();
  }

  function renderMemories(): Node[] {
    const nodes: Node[] = [renderRemember()];
    if (state.memories.length === 0) nodes.push(h('p', { class: 'empty' }, 'Nothing remembered yet.'));
    for (const m of [...state.memories].reverse()) nodes.push(memoryCard(m, { actions: true }));
    return nodes;
  }

  function renderRemember(): HTMLElement {
    const input = h('input', { type: 'text', id: 'pv-remember', placeholder: 'e.g. Acme wants incident updates in Slack.', 'aria-label': 'A fact to remember' });
    const replaces = h(
      'select',
      { id: 'pv-replaces', 'aria-label': 'Memory this replaces' },
      h('option', { value: '' }, 'Replaces nothing'),
      ...state.memories.filter((m) => statusOf(m) === 'latest').map((m) => h('option', { value: m.id }, `Replaces ${m.id}: ${short(m.content, 40)}`)),
    );
    const form = h(
      'form',
      { class: 'remember' },
      h('span', { class: 'pv-label' }, h('span', {}, 'Remember a fact directly'), h('span', {}, 'like the MCP tool')),
      input,
      h('div', { class: 'row' }, replaces, h('button', { class: 'pv-btn go', type: 'submit' }, 'Remember')),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const content = input.value.trim();
      if (!content) return input.focus();
      void act(
        async () => {
          const written = await state.demo.remember(content, replaces.value ? { supersedes: replaces.value } : {});
          state.query = content;
          state.selected = written.id;
        },
        { fit: true },
      );
    });
    return form;
  }

  function rejectionText(reason: string): string {
    switch (reason) {
      case 'unresolved-pronoun':
        return 'Who is "she"? A memory is shown without its conversation, so it must name its subject.';
      case 'secret':
        return 'The redactor caught a credential. Nothing secret is stored, whatever the model says.';
      case 'low-confidence':
        return 'Below the 0.5 confidence floor: small talk, not a fact.';
      default:
        return 'Dropped by deterministic screening.';
    }
  }

  function renderLog(): Node[] {
    if (state.runs.size === 0) return [h('p', { class: 'empty' }, 'No extraction runs yet.')];
    const names = byId();
    return SESSIONS.filter((s) => state.runs.has(s.id))
      .reverse()
      .map((session) => {
        const { run, stored } = state.runs.get(session.id)!;
        const s = run.stats!;
        const decisions = s.decisions.map((d) => {
          const via =
            d.via === 'model'
              ? `the model: ${d.reason ?? ''}`
              : d.via === 'exact'
                ? 'exact text match, no model call'
                : d.via === 'no-neighbors'
                  ? 'nothing similar stored, no model call'
                  : d.via;
          const target = d.memoryId ? names.get(d.memoryId) : undefined;
          return h(
            'li',
            {},
            pill(d.relation),
            h('span', {}, d.content, h('small', {}, target && d.relation !== 'new' ? `${d.relation} ${target.id} · via ${via}` : `via ${via}`)),
          );
        });
        const rejections = s.rejected.map((r) => h('li', {}, pill(r.reason, 'rej'), h('span', {}, r.content, h('small', {}, rejectionText(r.reason)))));
        const storedEl = h('div', { class: 'stored' });
        for (const part of stored.split(/(\[REDACTED[^\]]*\])/)) storedEl.append(part.startsWith('[REDACTED') ? h('mark', {}, part) : part);
        return h(
          'section',
          { class: 'run' },
          h('h4', {}, session.title, h('span', {}, `${s.calls} extraction call · ${s.resolutionCalls} resolution call${s.resolutionCalls === 1 ? '' : 's'}`)),
          h('span', { class: 'pv-label' }, h('span', {}, `Accepted ${s.accepted} of ${s.candidates} candidates`)),
          h('ul', {}, ...decisions),
          rejections.length ? h('span', { class: 'pv-label' }, h('span', {}, 'Rejected by the screen')) : null,
          rejections.length ? h('ul', {}, ...rejections) : null,
          h('span', { class: 'pv-label' }, h('span', {}, 'Source text as stored')),
          storedEl,
        );
      });
  }

  async function renderProfile(): Promise<HTMLElement> {
    const profile = await state.demo.profile();
    return h(
      'div',
      { class: 'answer' },
      h('span', { class: 'pv-label' }, h('span', {}, 'profile(scope).text'), h('span', {}, `${profile.tokens} tokens`)),
      h('div', { class: 'profile-text' }, profile.text.trim() || 'Nothing remembered yet.'),
      h('p', { class: 'empty' }, 'Drop this into a system prompt. Every line cites the memories it states, so forgetting or replacing one updates it immediately.'),
    );
  }

  function renderAnswer(): Node[] {
    const result = state.result;
    if (!result) return [h('p', { class: 'empty' }, 'Ask something to see what the agent would get.')];
    const names = byId();
    const nodes: Node[] = [];
    nodes.push(h('span', { class: 'pv-label' }, h('span', {}, 'What the agent gets'), h('span', {}, `${result.trace.budget.used} / ${result.trace.budget.limit} tokens`)));
    if (result.memories.length === 0) nodes.push(h('p', { class: 'empty' }, 'No current memory matches. (Superseded, forgotten and expired ones are never served.)'));
    for (const m of result.memories) nodes.push(memoryCard(m.memory));
    if (result.chunks.length) {
      nodes.push(h('p', { class: 'degraded' }, `+ ${result.chunks.length} source excerpt${result.chunks.length === 1 ? '' : 's'} for grounding, packed after the memories.`));
    }

    nodes.push(h('span', { class: 'pv-label' }, h('span', {}, 'Retrieval trace'), h('span', {}, `${result.trace.candidates.length} candidates`)));
    const rows: HTMLElement[] = [];
    let lineDrawn = false;
    for (const c of result.trace.candidates) {
      if (!lineDrawn && c.excludedReason === 'budget') {
        rows.push(h('tr', { class: 'budget-line' }, h('td', { colspan: '6' })));
        lineDrawn = true;
      }
      rows.push(
        h(
          'tr',
          { class: c.included ? '' : 'out' },
          h('td', {}, short(names.get(c.memoryId)?.content ?? c.memoryId, 46)),
          h('td', { class: 'n' }, c.lexicalRank ? String(c.lexicalRank) : '–'),
          h('td', { class: 'n' }, c.vectorRank ? String(c.vectorRank) : '–'),
          h('td', { class: 'n' }, c.rrfScore.toFixed(4)),
          h('td', { class: 'n' }, String(c.tokens)),
          h('td', {}, pill(c.included ? 'included' : (c.excludedReason ?? 'excluded'))),
        ),
      );
    }
    nodes.push(
      h(
        'div',
        { class: 'trace-wrap' },
        h(
          'table',
          { class: 'trace' },
          h('thead', {}, h('tr', {}, ...['Memory', 'Lex', 'Vec', 'RRF', 'Tok', 'Result'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, ...rows),
        ),
      ),
    );
    if (result.trace.degraded) nodes.push(h('p', { class: 'degraded' }, `Degraded: ${result.trace.degraded}`));
    return nodes;
  }

  // ---------- controls ----------

  els.tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.pvTab as State['tab'];
      void render();
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = els.tabs[(i + (event.key === 'ArrowRight' ? 1 : els.tabs.length - 1)) % els.tabs.length]!;
      state.tab = next.dataset.pvTab as State['tab'];
      void render().then(() => next.focus());
    });
  });

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    state.query = els.query.value.trim();
    if (state.query) void act(async () => undefined, { recall: true });
  });
  els.suggest.replaceChildren(
    ...SUGGESTIONS.map((text) => {
      const b = h('button', { type: 'button' }, text);
      b.addEventListener('click', () => {
        state.query = text;
        void act(async () => undefined);
      });
      return b;
    }),
  );
  els.budget.addEventListener('input', () => {
    state.budget = Number(els.budget.value);
    els.budgetOut.value = `${state.budget} tok`;
  });
  els.budget.addEventListener('change', () => void act(async () => undefined));
  els.fit.addEventListener('click', () => {
    fitAndLabel();
    void render();
  });
  els.jump.addEventListener('click', () =>
    act(async () => {
      state.demo.advanceTo('2026-07-01T09:00:00.000Z');
      state.jumped = true;
      state.query = SUGGESTIONS[3]!;
    }),
  );
  els.reset.addEventListener('click', () => {
    unmountCanvas();
    state.graph.dispose();
    state = fresh();
    unmountCanvas = mountCanvas();
    void start();
  });

  async function start() {
    // Open in a working state: the onboarding call is already in memory.
    await act(
      async () => {
        state.runs.set('onboarding', await state.demo.ingest('onboarding'));
      },
      { fit: true },
    );
  }

  void start();
}
