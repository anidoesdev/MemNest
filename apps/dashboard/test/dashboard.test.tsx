// @vitest-environment jsdom
import { createMemnestClient, type MemnestClient } from '@memnest/client';
import { createInMemoryAuthStore, createMemnest, scopeOf, type Memnest } from '@memnest/core';
import { createInMemoryStore, sequentialIds } from '@memnest/core/testing';
import { createServer } from '@memnest/server';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';

const USER = 'user:123';
const FAST_ARGON2 = { algorithm: 2 as const, memoryCost: 1024, timeCost: 1, parallelism: 1 };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

/** A browser-like client: the session cookie from login authenticates every later request. */
function browserClient(server: ReturnType<typeof createServer>): MemnestClient {
  let cookie = '';
  return createMemnestClient({
    baseUrl: 'http://memnest.test',
    fetch: async (input, init) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      const response = await server.app.request(input, { ...init, headers });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return response;
    },
  });
}

describe('dashboard (M7): a wrong memory can be found and forgotten through the UI', () => {
  let memnest: Memnest;
  let key: string;
  let client: MemnestClient;
  let ids: { postgres: string; mysql: string; wrong: string };

  beforeEach(async () => {
    memnest = createMemnest({ store: createInMemoryStore(), ids: sequentialIds(), profile: { builder: 'deterministic' } });
    const [postgres] = await memnest.addMemories({
      containerTag: USER,
      memories: [{ content: 'The user prefers Postgres over MongoDB as the database for the payments service.', kind: 'preference', validFrom: '2026-03-01T09:00:00.000Z' }],
    });
    const [wrong] = await memnest.addMemories({ containerTag: USER, memories: [{ content: 'The user dislikes every database ever made.' }] });
    const [mysql] = await memnest.addMemories({
      containerTag: USER,
      memories: [{ content: 'The user moved the payments service database to MySQL.', supersedes: postgres!.id, validFrom: '2026-03-08T09:00:00.000Z' }],
    });
    ids = { postgres: postgres!.id, mysql: mysql!.id, wrong: wrong!.id };
    const server = createServer({ memnest, auth: createInMemoryAuthStore(), keyring: { argon2: FAST_ARGON2 } });
    key = (await server.keyring.issue({ name: 'dashboard test', containerTag: USER })).key;
    client = browserClient(server);
  });

  async function signIn() {
    const user = userEvent.setup();
    render(<App client={client} />);
    await user.type(await screen.findByLabelText('API key'), key);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(USER, { selector: '.container-tag' });
    return user;
  }

  it('refuses a wrong key and signs in with a right one', async () => {
    const user = userEvent.setup();
    render(<App client={client} />);
    await user.type(await screen.findByLabelText('API key'), 'mnk_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('invalid API key');
    await user.clear(screen.getByLabelText('API key'));
    await user.type(screen.getByLabelText('API key'), key);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(USER, { selector: '.container-tag' });
    expect(screen.getByText('dashboard test')).toBeTruthy();
  });

  it('finds the wrong memory, confirms, forgets it, and the views follow', async () => {
    const user = await signIn();
    const finder = await screen.findByRole('complementary', { name: 'Memories' });
    await within(finder).findByText('The user dislikes every database ever made.');

    await user.type(within(finder).getByRole('searchbox', { name: 'Search memories' }), 'dislikes');
    await user.click(await within(finder).findByText('The user dislikes every database ever made.'));

    const detail = await screen.findByRole('complementary', { name: 'Memory detail' });
    await within(detail).findByText('The user dislikes every database ever made.', { selector: '.detail-content' });
    expect(within(detail).getByText('Direct write', { exact: false })).toBeTruthy();

    // Nothing happens until confirmed.
    await user.click(within(detail).getByRole('button', { name: 'Forget…' }));
    const dialog = within(detail).getByRole('alertdialog', { name: 'Forget this memory?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((await memnest.getMemory(scopeOf(USER), ids.wrong))!.forgottenAt).toBeUndefined();

    await user.click(within(detail).getByRole('button', { name: 'Forget…' }));
    await user.click(within(detail).getByRole('button', { name: 'Forget memory' }));
    await within(detail).findByText(/Forgotten .* It is no longer recalled/);
    expect((await memnest.getMemory(scopeOf(USER), ids.wrong))!.forgottenAt).toBeDefined();
    await waitFor(() => expect(within(finder).queryByText('The user dislikes every database ever made.')).toBeNull());

    // The trace now says why it is not recalled.
    await user.click(screen.getByRole('tab', { name: 'Retrieval trace' }));
    await user.type(screen.getByRole('searchbox', { name: 'Query' }), 'every database');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const row = (await screen.findByText('The user dislikes every database ever made.', { selector: '.memory-cell span' })).closest('tr')!;
    expect(within(row).getByText('Forgotten')).toBeTruthy();
  });

  it('explains recall within a budget, dates the switch on the timeline, and shows lineage', async () => {
    const user = await signIn();

    await user.click(await screen.findByRole('tab', { name: 'Retrieval trace' }));
    await user.type(screen.getByRole('searchbox', { name: 'Query' }), 'what database does the payments service use?');
    const budget = screen.getByRole('spinbutton');
    await user.clear(budget);
    await user.type(budget, '20');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const table = await screen.findByRole('table');
    const mysqlRow = within(table).getByText('The user moved the payments service database to MySQL.').closest('tr')!;
    expect(within(mysqlRow).getByText('Included')).toBeTruthy();
    const postgresRow = within(table).getByText(/prefers Postgres over MongoDB/).closest('tr')!;
    expect(within(postgresRow).getByText('Superseded')).toBeTruthy();
    expect(within(table).getByText(/Budget of 20 tokens reached/)).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    await user.type(screen.getByRole('searchbox', { name: 'Topic' }), 'payments database');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    const timeline = await screen.findByRole('img', { name: 'Timeline of payments database' });
    expect(within(timeline).getByRole('button', { name: /moved the payments service database to MySQL.*true now, from Mar 8, 2026/ })).toBeTruthy();
    expect(within(timeline).getByRole('button', { name: /prefers Postgres.*superseded, from Mar 1, 2026 to Mar 8, 2026/ })).toBeTruthy();
    expect(within(timeline).getByText(/Mar 8, 2026/, { selector: '.switch-date' })).toBeTruthy();

    // Clicking the MySQL fact selects it; lineage shows what it replaced.
    await user.click(within(timeline).getByRole('button', { name: /moved the payments service database to MySQL/ }));
    await user.click(screen.getByRole('tab', { name: 'Lineage' }));
    const lineage = await screen.findByRole('img', { name: 'Lineage graph' });
    expect(within(lineage).getByRole('button', { name: /^Fact: The user moved the payments service database to MySQL\.$/ })).toBeTruthy();
    expect(within(lineage).getByRole('button', { name: /^Preference: The user prefers Postgres.*\(Superseded\)$/ })).toBeTruthy();
    const detail = screen.getByRole('complementary', { name: 'Memory detail' });
    expect(within(detail).getByRole('heading', { name: 'Version history' })).toBeTruthy();
  });
});
