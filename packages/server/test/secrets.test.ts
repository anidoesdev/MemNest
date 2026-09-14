import { existsSync, readFileSync } from 'node:fs';
import { parseApiKey } from '@memnest/core';
import { CREDENTIAL_FIXTURES, credentialTranscript } from '@memnest/core/testing';
import type { SqliteStore } from '@memnest/store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

/** Every byte SQLite may have written: the database, its WAL and shared memory files. */
function persistedBytes(filename: string): string {
  return ['', '-wal', '-shm', '-journal']
    .map((suffix) => filename + suffix)
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1'))
    .join('\n');
}

describe('security: secrets never reach storage (server)', () => {
  let h: Harness;

  afterEach(async () => {
    await h?.cleanup();
  });

  it('persists no credential fixture, API key, key secret or session token sent through the API', async () => {
    h = await createHarness('sqlite');
    const { key } = await h.server.keyring.issue({ name: 'leaky', containerTag: 'user:123' });
    const session = await h.request('POST', '/v1/session', { json: { apiKey: key } });
    const token = session.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    const cookie = `memnest_session=${token}`;

    const responses = [
      await h.request('POST', '/v1/documents', {
        key,
        json: {
          customId: 'leaky-session',
          extraction: 'none',
          content: [...credentialTranscript(), { role: 'user', content: `Our Memnest key is ${key}, keep it handy.` }],
          metadata: { apiToken: CREDENTIAL_FIXTURES[7], source: `export KEY=${CREDENTIAL_FIXTURES[0]}` },
        },
      }),
      await h.request('POST', '/v1/documents', {
        cookie,
        json: { content: `# Setup\n\n\`\`\`\nAWS_SECRET_ACCESS_KEY=${CREDENTIAL_FIXTURES[2]}\npassword: ${CREDENTIAL_FIXTURES[6]}\n\`\`\``, extraction: 'none' },
      }),
      await h.request('POST', '/v1/memories', {
        key,
        json: { memories: [{ content: `The user's staging token: ${CREDENTIAL_FIXTURES[4]}` }], metadata: { note: `Bearer ${CREDENTIAL_FIXTURES[3]}` } },
      }),
      await h.request('POST', '/v1/search', { key, json: { query: `find ${CREDENTIAL_FIXTURES[1]}` } }),
    ];
    for (const response of responses) expect(response.status, await response.clone().text()).toBeLessThan(300);

    const sqlite = h.store as SqliteStore;
    sqlite.db.pragma('wal_checkpoint(TRUNCATE)');
    await h.memnest.close();
    const persisted = persistedBytes(h.filename!);

    expect(persisted).toContain('Postgres over MongoDB');
    expect(persisted).toContain('$argon2id$');
    for (const fixture of CREDENTIAL_FIXTURES) expect(persisted).not.toContain(fixture);
    expect(persisted).not.toContain(key);
    expect(persisted).not.toContain(parseApiKey(key)!.secret);
    expect(persisted).not.toContain(token);
  });
});
