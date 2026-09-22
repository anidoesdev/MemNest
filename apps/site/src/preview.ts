import type { ExtractionRun, LineageGraph, Memory, SearchResponse } from '@memnest/core';
import { createDemo, SESSIONS, type Demo, type IngestResult, type Session } from './demo';

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

interface State {
  demo: Demo;
  runs: Map<Session['id'], IngestResult>;
  memories: Memory[];
  fresh: Set<string>;
  open: Map<string, LineageGraph | null>;
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

  function fresh(): State {
    return {
      demo: createDemo(),
      runs: new Map(),
      memories: [],
      fresh: new Set(),
      open: new Map(),
      tab: 'memories',
      query: SUGGESTIONS[0]!,
      budget: 200,
      result: null,
      forgotten: false,
      jumped: false,
      busy: false,
    };
  }

  const byId = () => new Map(state.memories.map((m) => [m.id, m]));
  const isExpired = (m: Memory) => !!m.validUntil && Date.parse(m.validUntil) <= Date.parse(state.demo.now());
  const statusOf = (m: Memory) => (m.forgottenAt ? 'forgotten' : !m.isLatest ? 'superseded' : isExpired(m) ? 'expired' : 'latest');

  async function refresh(options: { recall?: boolean } = {}) {
    const before = new Set(state.memories.map((m) => m.id));
    state.memories = await state.demo.memories();
    state.fresh = new Set(state.memories.filter((m) => !before.has(m.id)).map((m) => m.id));
    for (const id of state.open.keys()) state.open.set(id, await state.demo.lineage(id));
    if (options.recall !== false && state.query.trim()) state.result = await state.demo.recall(state.query, state.budget);
    await render();
  }

  async function act(fn: () => Promise<unknown>, options?: { recall?: boolean }) {
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
      ? ['Step 2', 'Ingest Ticket #4411. Priya mentions a migration in passing. Watch Memnest work out how it relates to what it already knows.']
      : !state.runs.has('followup')
        ? ['Step 3', 'Ask again: the answer is MySQL now. The Postgres fact is still stored, but recall leaves it out as not-latest. Then ingest the chat follow-up.']
        : !state.forgotten
          ? ['Step 4', 'The Enterprise plan "fact" came from a question, not an answer. Forget it in Memories, then ask "Is Acme on the Enterprise plan?"']
          : !state.jumped
            ? ['Step 5', 'Jump to 1 July: the incident review is in the past, so its memory expires and recall drops it.']
            : ['Your turn', 'Remember a fact of your own, replace one, and ask about it. Or reset and replay.'];
    els.hint.replaceChildren(h('span', { class: 'step' }, step), h('span', {}, text));
  }

  function summary(run: ExtractionRun): string {
    const s = run.stats;
    if (!s) return run.status;
    const parts = [
      s.created && `${s.created} new`,
      s.updated && `${s.updated} updated`,
      s.extended && `${s.extended} extended`,
      s.reinforced && `${s.reinforced} reinforced`,
      s.rejected.length && `${s.rejected.length} rejected`,
    ].filter(Boolean);
    return parts.join(' · ');
  }

  function renderSessions() {
    const next = SESSIONS.find((s) => !state.runs.has(s.id));
    els.sessions.replaceChildren(
      ...SESSIONS.map((session) => {
        const run = state.runs.get(session.id);
        const button = h('button', { class: `pv-btn${session === next ? ' go' : ''}`, type: 'button', disabled: session !== next }, run ? 'Ingested' : 'Ingest');
        button.addEventListener('click', () =>
          act(async () => {
            state.runs.set(session.id, await state.demo.ingest(session.id));
            state.tab = 'log';
            if (session.id === 'ticket') state.query = SUGGESTIONS[0]!;
            if (session.id === 'followup') state.query = SUGGESTIONS[2]!;
          }),
        );
        return h(
          'article',
          { class: `session${run ? ' done' : ''}` },
          h('header', {}, h('b', {}, session.title), h('span', {}, `${day(session.at)} · ${session.channel}`)),
          h('ul', { class: 'turns' }, ...session.turns.map((t) => h('li', { class: t.role }, t.content))),
          h('footer', {}, run ? h('span', { class: 'ok' }, `✓ ${summary(run.run)}`) : h('span', {}, `${session.turns.length} turns`), button),
        );
      }),
    );
  }

  async function renderPanel(): Promise<Node[]> {
    if (state.tab === 'log') return renderLog();
    if (state.tab === 'profile') return [await renderProfile()];
    return renderMemories();
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
              act(async () => {
                if (state.open.has(m.id)) state.open.delete(m.id);
                else state.open.set(m.id, null);
              }, { recall: false }),
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
      { class: `mem ${status}${state.fresh.has(m.id) ? ' fresh' : ''}`, 'data-kind': m.kind },
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
    const graph = state.open.get(m.id);
    if (state.open.has(m.id) && graph) card.append(renderLineage(graph));
    return card;
  }

  function renderLineage(graph: LineageGraph): HTMLElement {
    const memories = new Map(graph.memories.map((x) => [x.id, x]));
    const lines: Child[] = [h('span', {}, h('b', {}, 'History'))];
    for (const e of graph.edges.filter((edge) => edge.relation !== 'source')) {
      const from = memories.get(e.from);
      const to = memories.get(e.to);
      lines.push(h('span', {}, `${e.from} ${e.relation} ${e.to}: "${short(to?.content ?? '', 48)}"${from && !from.isLatest ? ' (itself superseded)' : ''}`));
    }
    for (const d of graph.documents) {
      lines.push(h('span', {}, `source ${d.id}: ${d.customId ?? d.kind} (${d.kind}, ${day(d.documentDate ?? d.createdAt)})`));
    }
    return h('div', { class: 'lineage' }, ...lines);
  }

  function renderMemories(): Node[] {
    const nodes: Node[] = [renderRemember()];
    if (state.memories.length === 0) nodes.push(h('p', { class: 'empty' }, 'Nothing remembered yet. Ingest a session.'));
    // Newest first, so what a session just wrote is on top.
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
    const submit = h('button', { class: 'pv-btn go', type: 'submit' }, 'Remember');
    const form = h(
      'form',
      { class: 'remember' },
      h('span', { class: 'pv-label' }, h('span', {}, 'Remember a fact directly'), h('span', {}, 'like the MCP tool')),
      input,
      h('div', { class: 'row' }, replaces, submit),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const content = input.value.trim();
      if (!content) return input.focus();
      void act(async () => {
        await state.demo.remember(content, replaces.value ? { supersedes: replaces.value } : {});
        state.query = content;
      });
    });
    return form;
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
      const reason = c.included ? 'included' : c.excludedReason ?? 'excluded';
      rows.push(
        h(
          'tr',
          { class: c.included ? '' : 'out' },
          h('td', {}, short(names.get(c.memoryId)?.content ?? c.memoryId, 46)),
          h('td', { class: 'n' }, c.lexicalRank ? String(c.lexicalRank) : '–'),
          h('td', { class: 'n' }, c.vectorRank ? String(c.vectorRank) : '–'),
          h('td', { class: 'n' }, c.rrfScore.toFixed(4)),
          h('td', { class: 'n' }, String(c.tokens)),
          h('td', {}, pill(reason)),
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
    if (state.query) void act(async () => undefined);
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
  els.jump.addEventListener('click', () =>
    act(async () => {
      state.demo.advanceTo('2026-07-01T09:00:00.000Z');
      state.jumped = true;
      state.query = SUGGESTIONS[3]!;
    }),
  );
  els.reset.addEventListener('click', () => {
    state = fresh();
    void start();
  });

  async function start() {
    // Open in a working state: the onboarding call is already in memory.
    await act(async () => {
      state.runs.set('onboarding', await state.demo.ingest('onboarding'));
    });
    state.fresh.clear();
  }

  void start();
}
