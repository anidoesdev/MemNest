import { createMemnestClient } from '@memnest/client';
import { createInMemoryAuthStore, createInMemoryJobQueue, createMemnest, scopeOf, type Memnest, type MemnestApi } from '@memnest/core';
import { createInMemoryStore, fixedClock, hashEmbedder, sequentialIds } from '@memnest/core/testing';
import { createServer } from '@memnest/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_RESOURCE_URI, createMemnestMcpServer, type MemnestMcpOptions } from '../src/index';

const USER = 'user:123';
const OTHER = 'user:456';

function engine(): Memnest {
  const clock = fixedClock('2026-03-01T09:00:00.000Z');
  return createMemnest({
    store: createInMemoryStore({ vector: true }),
    queue: createInMemoryJobQueue({ clock }),
    clock,
    ids: sequentialIds(),
    embedder: hashEmbedder(),
    profile: { builder: 'deterministic' },
  });
}

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function connect(memnest: MemnestApi, options: Partial<MemnestMcpOptions> = {}) {
  const server = createMemnestMcpServer({ memnest, containerTag: USER, sessionId: 'session-1', ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  open.push(client, server);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    return { text, isError: result.isError === true };
  };
  return { client, call };
}

const idsIn = (text: string) => [...text.matchAll(/\b(mem_[\w-]+)/g)].map((m) => m[1]!);

describe('memnest MCP server', () => {
  it('lists the tools, the profile resource and the prompt, with server instructions', async () => {
    const { client } = await connect(engine());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['forget', 'history', 'ingest', 'profile', 'recall', 'remember']);
    expect(tools.find((t) => t.name === 'recall')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'forget')!.annotations?.destructiveHint).toBe(true);
    // The container is fixed by configuration; no tool lets the model pick one.
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/container/i);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([PROFILE_RESOURCE_URI]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['with-memory']);
    expect(client.getInstructions()).toContain(USER);
  });

  it('remembers, recalls, and serves only the latest version after a supersede', async () => {
    const { call } = await connect(engine());

    const first = await call('remember', { memories: [{ content: 'The user prefers Postgres for the payments database.' }] });
    expect(first.isError).toBe(false);
    const [postgresId] = idsIn(first.text);
    expect(postgresId).toBeDefined();

    const recalled = await call('recall', { query: 'which database for payments?' });
    expect(recalled.text).toContain('Postgres');
    expect(recalled.text).toContain(postgresId);

    const second = await call('remember', {
      memories: [{ content: 'The user moved the payments database to MySQL.', supersedes: postgresId }],
    });
    expect(second.text).toContain(`replaces ${postgresId}`);

    const after = await call('recall', { query: 'which database for payments?' });
    expect(after.text).toContain('MySQL');
    expect(after.text).not.toContain('prefers Postgres');
    expect(after.text).toMatch(/left out: 1 not-latest/);

    const history = await call('history', { memoryId: idsIn(second.text)[0]! });
    expect(history.text).toContain(`${idsIn(second.text)[0]} updates ${postgresId}`);
    expect(history.text).toMatch(new RegExp(`${postgresId} \\[superseded`));
  });

  it('skips exact duplicates, in the store and within one call', async () => {
    const memnest = engine();
    const { call } = await connect(memnest);
    await call('remember', { memories: [{ content: 'The user drinks oat lattes.' }] });

    const again = await call('remember', {
      memories: [{ content: 'the user drinks oat lattes' }, { content: 'The user plays chess.' }, { content: 'The user plays chess.' }],
    });
    expect(again.text).toContain('Remembered (1)');
    expect(again.text).toContain('already remembered as');
    expect(again.text).toContain('appears twice');
    expect(await memnest.listMemories(scopeOf(USER))).toHaveLength(2);
  });

  it('forgets a memory so recall stops serving it, and keeps it in history', async () => {
    const { call } = await connect(engine());
    const written = await call('remember', { memories: [{ content: 'The user is on the Enterprise plan.' }] });
    const [id] = idsIn(written.text);

    const forgotten = await call('forget', { memoryId: id });
    expect(forgotten.text).toContain(`Forgot ${id}`);
    expect((await call('recall', { query: 'Enterprise plan' })).text).not.toContain(id!);
    expect((await call('history', { memoryId: id })).text).toMatch(new RegExp(`${id} \\[forgotten`));
  });

  it('never reaches another container, even with a valid id from it', async () => {
    const memnest = engine();
    const [foreign] = await memnest.addMemories({ containerTag: OTHER, memories: [{ content: 'The other user lives in Lisbon.' }] });
    const { call } = await connect(memnest);

    expect((await call('recall', { query: 'Lisbon' })).text).not.toContain('Lisbon');
    const forget = await call('forget', { memoryId: foreign!.id });
    expect(forget.isError).toBe(true);
    const history = await call('history', { memoryId: foreign!.id });
    expect(history.isError).toBe(true);
    expect(history.text).not.toContain('Lisbon');
    const supersede = await call('remember', { memories: [{ content: 'The user lives in Porto.', supersedes: foreign!.id }] });
    expect(supersede.isError).toBe(true);
    expect((await memnest.getMemory(scopeOf(OTHER), foreign!.id))!.isLatest).toBe(true);
  });

  it('ingests raw content under the connection session, searchable right away', async () => {
    const memnest = engine();
    const { call } = await connect(memnest);
    const result = await call('ingest', { turns: [{ role: 'user', content: 'Our payments cluster runs in eu-west-1.' }] });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/extraction job \S+ queued/);

    const documents = await memnest.searchDocuments('eu-west-1', scopeOf(USER));
    expect(documents).toHaveLength(1);
    expect((await memnest.getDocument(scopeOf(USER), documents[0]!.chunk.documentId))!.document.customId).toBe('session-1');
    expect((await call('recall', { query: 'eu-west-1' })).text).toContain('eu-west-1');

    const both = await call('ingest', { content: 'x', turns: [{ role: 'user', content: 'y' }] });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('validation');
  });

  it('serves the profile as a tool, a resource and inside the prompt', async () => {
    const memnest = engine();
    const { client, call } = await connect(memnest);
    expect((await call('profile')).text).toContain('No profile yet');

    await call('remember', { memories: [{ content: 'The user works at Stripe as a product manager.', kind: 'fact' }] });
    expect((await call('profile', { rebuild: true })).text).toContain('Stripe');

    const resource = await client.readResource({ uri: PROFILE_RESOURCE_URI });
    expect((resource.contents[0] as { text: string }).text).toContain('Stripe');

    const prompt = await client.getPrompt({ name: 'with-memory', arguments: { task: 'Plan my week.' } });
    const body = (prompt.messages[0]!.content as { text: string }).text;
    expect(body).toContain('Stripe');
    expect(body).toContain('Task: Plan my week.');
  });

  it('read-only mode exposes no way to write', async () => {
    const { client, call } = await connect(engine(), { readOnly: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['history', 'profile', 'recall']);
    expect(client.getInstructions()).not.toContain('remember');
    await expect(call('remember', { memories: [{ content: 'x' }] })).rejects.toThrow(/not found/);
  });

  it('reports invalid input as a tool error the model can read', async () => {
    const { call } = await connect(engine());
    const bad = await call('remember', { memories: [{ content: 'The user has a dentist appointment.', validUntil: 'next week' }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^validation: /);
  });

  it('works the same through @memnest/client against a server', async () => {
    const memnest = engine();
    const server = createServer({
      memnest,
      auth: createInMemoryAuthStore(),
      keyring: { argon2: { algorithm: 2 as const, memoryCost: 1024, timeCost: 1, parallelism: 1 } },
    });
    const { key } = await server.keyring.issue({ name: 'mcp', containerTag: USER });
    const client = createMemnestClient({
      baseUrl: 'http://memnest.test/',
      apiKey: key,
      fetch: async (input, init) => server.app.request(input, init),
    });
    const { call } = await connect(client);

    const first = await call('remember', { memories: [{ content: 'The user prefers Postgres for the payments database.' }] });
    const [postgresId] = idsIn(first.text);
    await call('remember', { memories: [{ content: 'The user moved the payments database to MySQL.', supersedes: postgresId }] });
    const recalled = await call('recall', { query: 'payments database' });
    expect(recalled.text).toContain('MySQL');
    expect(recalled.text).not.toContain('prefers Postgres');
    expect((await memnest.listMemories(scopeOf(USER), undefined, { latestOnly: true })).map((m) => m.content)).toEqual([
      'The user moved the payments database to MySQL.',
    ]);
    expect((await call('forget', { memoryId: 'mem_nope' })).text).toMatch(/^not_found: /);
  });
});
