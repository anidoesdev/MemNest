import {
  comparableContent,
  scopeOf,
  type LineageGraph,
  type Memory,
  type MemnestApi,
  type Profile,
  type SearchResponse,
} from '@memnest/core';
import { GRAPH_APP_HTML } from '@memnest/mcp-app';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const MCP_SERVER_NAME = 'memnest';
export const MCP_SERVER_VERSION = '0.1.0';
export const PROFILE_RESOURCE_URI = 'memnest://profile';
/** The interactive memory graph, an MCP App that hosts such as Claude render inline. */
export const GRAPH_APP_URI = 'ui://memnest/graph';

/** Most nodes the graph app may load in one call. Matches the dashboard's load limit. */
const MAX_GRAPH_NODES = 10_000;

/** Upper bounds that keep one tool call from flooding the prompt or the store. */
const MAX_REMEMBER = 20;
const MAX_RECALL_BUDGET = 8000;
const DEFAULT_RECALL_BUDGET = 1000;
const EXCERPT_CHARS = 280;

export interface MemnestMcpOptions {
  /** The embedded engine or `@memnest/client`: anything implementing `MemnestApi`. */
  memnest: MemnestApi;
  /**
   * The one container this server reads and writes. Fixed by whoever starts the server,
   * never chosen by the model: a tool argument could be steered into another container.
   */
  containerTag: string;
  /** Registers only recall, history and profile. Default false. */
  readOnly?: boolean;
  /**
   * `customId` for `ingest` calls that name no session, so everything one server
   * instance ingests is extracted as one conversation. Default: random per instance.
   */
  sessionId?: string;
  /** Default token budget for `recall`. Default 1000. */
  recallBudget?: number;
}

/** A tool failure the model can read and act on, instead of a protocol error. */
function failure(error: unknown): CallToolResult {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'error';
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

/** Data for the graph app, which parses it; hidden from the model by the tool's visibility. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function notFound(memoryId: string): CallToolResult {
  return failure(Object.assign(new Error(`no memory ${memoryId}`), { code: 'not_found' }));
}

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return failure(error);
  }
}

const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : undefined);

function status(memory: Memory): string {
  if (memory.forgottenAt) return 'forgotten';
  return memory.isLatest ? 'latest' : 'superseded';
}

function formatMemory(memory: Memory): string {
  const details = [`id ${memory.id}`, `since ${day(memory.validFrom)}`];
  if (memory.validUntil) details.push(`until ${day(memory.validUntil)}`);
  return `[${memory.kind}] ${memory.content}  (${details.join(', ')})`;
}

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

export function formatRecall(response: SearchResponse): string {
  const { memories, chunks, trace } = response;
  const lines: string[] = [];
  if (memories.length === 0 && chunks.length === 0) {
    lines.push('Nothing relevant is remembered.');
  }
  if (memories.length > 0) {
    lines.push(`Memories (${memories.length}):`);
    for (const m of memories) lines.push(`- ${formatMemory(m.memory)}`);
  }
  if (chunks.length > 0) {
    lines.push(`Source excerpts (${chunks.length}):`);
    for (const c of chunks) lines.push(`- "${excerpt(c.chunk.content)}"  (document ${c.chunk.documentId})`);
  }

  // Say what was held back and why, without repeating stale content into the prompt.
  const excluded = new Map<string, number>();
  for (const c of trace.candidates) {
    if (!c.included && c.excludedReason) excluded.set(c.excludedReason, (excluded.get(c.excludedReason) ?? 0) + 1);
  }
  const notes: string[] = [`${trace.budget.used}/${trace.budget.limit} tokens used`];
  if (excluded.size > 0) {
    notes.push(`left out: ${[...excluded].map(([reason, n]) => `${n} ${reason}`).join(', ')}`);
  }
  if (trace.degraded) notes.push(`search degraded: ${trace.degraded}`);
  lines.push('', `(${notes.join('; ')})`);
  return lines.join('\n');
}

export function formatLineage(graph: LineageGraph): string {
  const byId = new Map(graph.memories.map((m) => [m.id, m]));
  const lines = [`Lineage of ${graph.rootId}`, 'Memories:'];
  const ordered = [...graph.memories].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const m of ordered) {
    lines.push(`- ${m.id} [${status(m)}, ${day(m.createdAt)}] ${m.content}`);
  }
  const relations = graph.edges.filter((e) => e.relation !== 'source' && byId.has(e.from));
  if (relations.length > 0) {
    lines.push('Relations:');
    for (const e of relations) lines.push(`- ${e.from} ${e.relation} ${e.to}`);
  }
  if (graph.documents.length > 0) {
    lines.push('Sources:');
    for (const d of graph.documents) {
      const name = d.customId ? ` "${d.customId}"` : '';
      const gone = d.deletedAt ? ', deleted' : '';
      lines.push(`- ${d.id}${name} (${d.kind}, v${d.version}, ${day(d.documentDate ?? d.createdAt)}${gone})`);
    }
  }
  return lines.join('\n');
}

export function formatProfile(profile: Profile): string {
  if (profile.text.trim().length === 0) return 'No profile yet: nothing is remembered in this container.';
  const note = profile.stale ? '\n\n(A rebuild is due; every line is still current.)' : '';
  return `${profile.text}${note}`;
}

function instructions(containerTag: string, readOnly: boolean): string {
  const lines = [
    `Memnest is the long-term memory for "${containerTag}".`,
    'Call `recall` before answering anything that may depend on what was learned in earlier sessions: preferences, facts about the user, project decisions.',
  ];
  if (!readOnly) {
    lines.push(
      'When you learn a durable fact or preference, call `remember` with one self-contained sentence per fact. Name the subject ("The user…", "The billing service…"); no pronouns, no secrets.',
      'If the new fact replaces a memory that `recall` returned, pass that memory\'s id as `supersedes`, so the old one is kept as history and stops being served. If it adds detail, pass the id in `extends`.',
      'Use `ingest` for raw material (notes, transcripts) that Memnest should extract facts from itself.',
      'Use `forget` only for a memory that is wrong, not for one that changed.',
    );
  }
  return lines.join('\n');
}

/**
 * An MCP server over one Memnest container: tools to recall, remember, ingest, forget and
 * inspect memories, the container profile as a resource, and a `with-memory` prompt.
 * Transport-agnostic; connect it with `serveStdio(() => createMemnestMcpServer(…))` or any
 * other MCP transport.
 */
export function createMemnestMcpServer(options: MemnestMcpOptions): McpServer {
  const { memnest } = options;
  const scope = scopeOf(options.containerTag);
  const readOnly = options.readOnly ?? false;
  const sessionId = options.sessionId ?? `mcp-${globalThis.crypto.randomUUID()}`;
  const defaultBudget = options.recallBudget ?? DEFAULT_RECALL_BUDGET;

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: instructions(scope.containerTag, readOnly) },
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      description:
        'Search long-term memory for facts relevant to a question. Returns only current facts (superseded, forgotten and expired ones are left out), with their ids, plus source excerpts when they fit the token budget.',
      inputSchema: z.object({
        query: z.string().min(1).describe('A natural-language question or topic, e.g. "which database does the payments service use?"'),
        tokenBudget: z
          .number()
          .int()
          .min(50)
          .max(MAX_RECALL_BUDGET)
          .optional()
          .describe(`Most tokens to return. Default ${defaultBudget}.`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, tokenBudget }) =>
      guarded(async () => text(formatRecall(await memnest.search(query, scope, { tokenBudget: tokenBudget ?? defaultBudget })))),
  );

  server.registerTool(
    'history',
    {
      title: 'Memory history',
      description:
        'Show where a memory came from and how it changed: the versions it replaced or was replaced by, memories that extend it, and its source documents.',
      inputSchema: z.object({ memoryId: z.string().min(1).describe('An id returned by recall or remember.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ memoryId }) =>
      guarded(async () => {
        const graph = await memnest.getLineage(scope, memoryId);
        return graph ? text(formatLineage(graph)) : notFound(memoryId);
      }),
  );

  server.registerTool(
    'profile',
    {
      title: 'Profile',
      description: 'A short, prompt-ready summary of everything durable that is remembered, plus recent activity.',
      inputSchema: z.object({
        rebuild: z.boolean().optional().describe('Build it now instead of reading the cached one. Slower; rarely needed.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ rebuild }) =>
      guarded(async () => text(formatProfile(rebuild ? await memnest.rebuildProfile(scope) : await memnest.profile(scope)))),
  );

  server.registerResource(
    'profile',
    PROFILE_RESOURCE_URI,
    {
      title: `Memnest profile of ${scope.containerTag}`,
      description: 'What is remembered, summarised for a prompt.',
      mimeType: 'text/plain',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: formatProfile(await memnest.profile(scope)) }] }),
  );

  registerAppResource(
    server,
    'graph',
    GRAPH_APP_URI,
    {
      title: `Memnest graph of ${scope.containerTag}`,
      description: 'An interactive map of the memories: kinds, reinforcement, and how they update and extend each other.',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: GRAPH_APP_HTML, _meta: { ui: { prefersBorder: true } } }],
    }),
  );

  registerAppTool(
    server,
    'show_graph',
    {
      title: 'Show memory graph',
      description:
        'Open an interactive graph of everything remembered, for the user to explore. Use when the user asks to see, visualise or browse their memories. Optionally narrow it to memories containing some words, or highlight one memory\'s history.',
      inputSchema: z.object({
        search: z.string().optional().describe('Show only memories containing all these words.'),
        memoryId: z.string().optional().describe('Highlight this memory and the versions it replaced or was replaced by.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: GRAPH_APP_URI } },
    },
    async ({ search, memoryId }) =>
      guarded(async () => {
        const snapshot = await memnest.graph(scope, { limit: 1 });
        const focus = [search ? `filtered to "${search}"` : '', memoryId ? `highlighting ${memoryId}` : ''].filter(Boolean).join(', ');
        return text(
          `Showing the memory graph of ${scope.containerTag}: ${snapshot.totalMemories} memories${focus ? `, ${focus}` : ''}. ` +
            'The user can filter, zoom and click a memory to see its history.',
        );
      }),
  );

  registerAppTool(
    server,
    'graph_snapshot',
    {
      title: 'Graph data',
      description: 'Memories and their relations as JSON, for the graph view.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(MAX_GRAPH_NODES).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: GRAPH_APP_URI, visibility: ['app'] } },
    },
    async ({ limit }) =>
      guarded(async () =>
        json(await memnest.graph(scope, { limit: limit ?? MAX_GRAPH_NODES, includeSuperseded: true, includeForgotten: true })),
      ),
  );

  registerAppTool(
    server,
    'graph_lineage',
    {
      title: 'Lineage data',
      description: 'One memory\'s lineage as JSON, for the graph view.',
      inputSchema: z.object({ memoryId: z.string().min(1) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: GRAPH_APP_URI, visibility: ['app'] } },
    },
    async ({ memoryId }) =>
      guarded(async () => {
        const graph = await memnest.getLineage(scope, memoryId);
        return graph ? json(graph) : notFound(memoryId);
      }),
  );

  server.registerPrompt(
    'with-memory',
    {
      title: 'Work with memory',
      description: 'Start a task with the current profile loaded and instructions for using memory.',
      argsSchema: z.object({ task: z.string().optional().describe('What you want to do.') }),
    },
    async ({ task }) => {
      const profile = formatProfile(await memnest.profile(scope));
      const body = [
        instructions(scope.containerTag, readOnly),
        '',
        'What is remembered so far:',
        profile,
        ...(task ? ['', `Task: ${task}`] : []),
      ].join('\n');
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }] };
    },
  );

  if (readOnly) return server;

  server.registerTool(
    'remember',
    {
      title: 'Remember facts',
      description:
        'Store durable facts or preferences, one self-contained sentence each. Exact duplicates of current memories are skipped. To record a change, call recall first and pass the outdated memory\'s id as supersedes: the old version is kept as history and no longer served.',
      inputSchema: z.object({
        memories: z
          .array(
            z.object({
              content: z.string().min(1).describe('One fact, naming its subject. No pronouns, no secrets.'),
              kind: z.enum(['fact', 'preference', 'episode']).optional().describe('Default fact.'),
              supersedes: z.string().optional().describe('Id of the current memory this replaces.'),
              extends: z.array(z.string()).optional().describe('Ids of memories this adds detail to.'),
              validUntil: z.string().optional().describe('ISO date or datetime after which this stops being true, e.g. for an appointment.'),
            }),
          )
          .min(1)
          .max(MAX_REMEMBER),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ memories }) =>
      guarded(async () => {
        const toWrite: typeof memories = [];
        const skipped: string[] = [];
        const seen = new Set<string>();
        for (const m of memories) {
          const key = comparableContent(m.content);
          if (seen.has(key)) {
            skipped.push(`- "${m.content}" appears twice in this call`);
            continue;
          }
          seen.add(key);
          if (!m.supersedes) {
            const existing = (await memnest.searchMemories(m.content, scope, { candidates: 10 })).find(
              (r) => comparableContent(r.memory.content) === key,
            );
            if (existing) {
              skipped.push(`- "${m.content}" is already remembered as ${existing.memory.id}`);
              continue;
            }
          }
          toWrite.push(m);
        }

        const written =
          toWrite.length === 0
            ? []
            : await memnest.addMemories({
                containerTag: scope.containerTag,
                metadata: { via: 'mcp' },
                memories: toWrite.map((m) => ({
                  content: m.content,
                  ...(m.kind ? { kind: m.kind } : {}),
                  ...(m.supersedes ? { supersedes: m.supersedes } : {}),
                  ...(m.extends?.length ? { extendsIds: m.extends } : {}),
                  ...(m.validUntil ? { validUntil: m.validUntil } : {}),
                })),
              });

        const lines: string[] = [];
        if (written.length > 0) {
          lines.push(`Remembered (${written.length}):`);
          for (const m of written) {
            const relation = m.supersedes ? `, replaces ${m.supersedes}` : m.extendsIds.length ? `, extends ${m.extendsIds.join(', ')}` : '';
            lines.push(`- ${m.id}${relation}: ${m.content}`);
          }
        }
        if (skipped.length > 0) lines.push(`Skipped (${skipped.length}):`, ...skipped);
        return text(lines.join('\n'));
      }),
  );

  server.registerTool(
    'ingest',
    {
      title: 'Ingest content',
      description:
        'Hand raw material (notes, a transcript, a document) to Memnest, which extracts the facts and resolves them against what is already known in the background. The text is searchable by recall right away; extracted memories appear once extraction has run. Needs a completion model on the Memnest side for extraction.',
      inputSchema: z.object({
        content: z.string().min(1).optional().describe('Plain text or markdown.'),
        turns: z
          .array(z.object({ role: z.string().min(1), content: z.string().min(1) }))
          .min(1)
          .optional()
          .describe('A conversation, as { role, content } turns. Use instead of content.'),
        session: z
          .string()
          .optional()
          .describe('Content sent under the same session is extracted together as one conversation. Default: this connection.'),
        documentDate: z.string().optional().describe('ISO date the content is about, if not today.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ content, turns, session, documentDate }) =>
      guarded(async () => {
        if ((content === undefined) === (turns === undefined)) {
          return failure(Object.assign(new Error('pass exactly one of content or turns'), { code: 'validation' }));
        }
        const result = await memnest.add({
          containerTag: scope.containerTag,
          content: turns ?? content!,
          customId: session ?? sessionId,
          metadata: { via: 'mcp' },
          ...(documentDate ? { documentDate } : {}),
        });
        if (result.deduplicated) return text(`Already ingested as document ${result.documentId}; nothing new was written.`);
        const queued = result.jobId ? `extraction job ${result.jobId} queued` : 'no extraction queued';
        return text(`Ingested as document ${result.documentId} (version ${result.version}, ${queued}). It is searchable now; extracted memories appear once extraction has run.`);
      }),
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget a memory',
      description:
        'Stop serving a memory that is wrong. It stays visible in history for audit. For a fact that changed, use remember with supersedes instead.',
      inputSchema: z.object({ memoryId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ memoryId }) =>
      guarded(async () => {
        const memory = await memnest.forget(scope, memoryId);
        return text(`Forgot ${memory.id}: ${memory.content}`);
      }),
  );

  return server;
}
