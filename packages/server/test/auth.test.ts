import { createInMemoryAuthStore, createMemnest, parseApiKey } from '@memnest/core';
import { createInMemoryStore, fixedClock } from '@memnest/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS, CSRF_HEADER, createKeyring, createServer } from '../src/index';
import { createHarness, errorOf, type Harness } from './harness';

describe('keyring', () => {
  it('issues keys hashed with production argon2id parameters and never stores the key', async () => {
    const auth = createInMemoryAuthStore();
    const keyring = createKeyring({ auth });
    const { key, record } = await keyring.issue({ name: 'ci', containerTag: 'user:123' });

    const parsed = parseApiKey(key)!;
    expect(parsed.id).toBe(record.id);
    expect(record.secretHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const persisted = JSON.stringify(auth.dump());
    expect(persisted).not.toContain(key);
    expect(persisted).not.toContain(parsed.secret);

    expect(await keyring.verify(key)).toMatchObject({ id: record.id, containerTag: 'user:123' });
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('rejects malformed, unknown, wrong and revoked keys with the same error', async () => {
    const auth = createInMemoryAuthStore();
    const keyring = createKeyring({ auth, argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } });
    const { key, record } = await keyring.issue({ name: 'one' });
    const { id, secret } = parseApiKey(key)!;
    const tampered = `mnk_${id}_${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    const unknown = `mnk_${'0'.repeat(12)}_${secret}`;

    const messages: string[] = [];
    for (const attempt of ['nope', unknown, tampered]) {
      const error = await keyring.verify(attempt).catch((e: Error & { code?: string }) => e);
      expect(error).toMatchObject({ code: 'unauthorized' });
      messages.push((error as Error).message);
    }
    await keyring.verify(key);
    expect(await keyring.revoke(record.id)).toBe(true);
    const revoked = await keyring.verify(key).catch((e: Error) => e);
    messages.push((revoked as Error).message);
    expect(new Set(messages)).toEqual(new Set(['invalid API key']));
  });

  it('records key use at most once per interval', async () => {
    const auth = createInMemoryAuthStore();
    const clock = fixedClock('2026-03-01T09:00:00.000Z');
    const keyring = createKeyring({ auth, clock, argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } });
    const { key, record } = await keyring.issue({ name: 'one' });
    await keyring.verify(key);
    expect((await auth.getApiKey(record.id))!.lastUsedAt).toBe('2026-03-01T09:00:00.000Z');
    clock.advance(30_000);
    await keyring.verify(key);
    expect((await auth.getApiKey(record.id))!.lastUsedAt).toBe('2026-03-01T09:00:00.000Z');
    clock.advance(31_000);
    await keyring.verify(key);
    expect((await auth.getApiKey(record.id))!.lastUsedAt).toBe('2026-03-01T09:01:01.000Z');
  });

  it('refuses invalid names and container tags', async () => {
    const keyring = createKeyring({ auth: createInMemoryAuthStore() });
    await expect(keyring.issue({ name: '' })).rejects.toMatchObject({ code: 'validation' });
    await expect(keyring.issue({ name: 'x', containerTag: 'not a tag' })).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('server auth', () => {
  let h: Harness;
  let key: string;
  let keyId: string;

  beforeEach(async () => {
    h = await createHarness('memory');
    const issued = await h.server.keyring.issue({ name: 'dashboard', containerTag: 'user:123' });
    key = issued.key;
    keyId = issued.record.id;
  });

  afterEach(async () => {
    await h.cleanup();
  });

  const sessionCookie = async () => {
    const response = await h.request('POST', '/v1/session', { json: { apiKey: key } });
    expect(response.status).toBe(201);
    return response;
  };

  it('accepts only "Bearer <key>"', async () => {
    expect((await h.request('GET', '/v1/memories', { key })).status).toBe(200);
    expect((await h.request('GET', '/v1/memories', { headers: { authorization: key } })).status).toBe(401);
    expect((await h.request('GET', '/v1/memories', { headers: { authorization: `Basic ${key}` } })).status).toBe(401);
    expect((await h.request('GET', '/v1/memories', { key: `${key}x` })).status).toBe(401);
  });

  it('issues an HttpOnly, SameSite=Strict, Secure session cookie from a key', async () => {
    const response = await sessionCookie();
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^memnest_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/Max-Age=43200/);
    expect(await response.json()).toEqual({
      keyId,
      name: 'dashboard',
      containerTag: 'user:123',
      via: 'session',
      expiresAt: '2026-03-01T21:00:00.000Z',
    });

    const cookie = setCookie.split(';')[0]!;
    expect(await (await h.request('GET', '/v1/session', { cookie })).json()).toMatchObject({ via: 'session', containerTag: 'user:123' });
    expect(await (await h.request('GET', '/v1/session', { key })).json()).toMatchObject({ via: 'key' });
  });

  it('refuses a session for a bad key', async () => {
    const response = await h.request('POST', '/v1/session', { json: { apiKey: 'mnk_000000000000_' + 'A'.repeat(43) } });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await h.request('POST', '/v1/session', { json: {} })).status).toBe(400);
  });

  it('requires the CSRF header on cookie-authenticated writes, not reads', async () => {
    const cookie = (await sessionCookie()).headers.get('set-cookie')!.split(';')[0]!;
    const withoutHeader = await h.server.app.request('http://memnest.test/v1/memories', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ memories: [{ content: 'Forged by another site.' }] }),
    });
    expect(withoutHeader.status).toBe(401);
    expect((await errorOf(withoutHeader)).message).toContain(CSRF_HEADER);
    expect((await h.memnest.listMemories({ containerTag: 'user:123' } as never)).length).toBe(0);

    const read = await h.server.app.request('http://memnest.test/v1/memories', { headers: { cookie } });
    expect(read.status).toBe(200);
    const write = await h.request('POST', '/v1/memories', { cookie, json: { memories: [{ content: 'The user likes tea.' }] } });
    expect(write.status).toBe(201);
  });

  it('expires sessions, ends them on logout, and ends them all when the key is revoked', async () => {
    const first = (await sessionCookie()).headers.get('set-cookie')!.split(';')[0]!;
    const second = (await sessionCookie()).headers.get('set-cookie')!.split(';')[0]!;

    const logout = await h.request('DELETE', '/v1/session', { cookie: first });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toMatch(/memnest_session=;/);
    expect((await h.request('GET', '/v1/session', { cookie: first })).status).toBe(401);
    expect((await h.request('GET', '/v1/session', { cookie: second })).status).toBe(200);

    h.clock.advance(12 * 60 * 60 * 1000);
    const expired = await h.request('GET', '/v1/session', { cookie: second });
    expect(expired.status).toBe(401);
    expect((await errorOf(expired)).message).toBe('session expired');

    const third = (await sessionCookie()).headers.get('set-cookie')!.split(';')[0]!;
    await h.server.keyring.revoke(keyId);
    expect((await h.request('GET', '/v1/session', { cookie: third })).status).toBe(401);
    expect((await h.request('GET', '/v1/memories', { key })).status).toBe(401);
  });

  it('prefers the Authorization header over a cookie', async () => {
    const cookie = (await sessionCookie()).headers.get('set-cookie')!.split(';')[0]!;
    expect((await h.request('GET', '/v1/session', { cookie, key: 'mnk_bad' })).status).toBe(401);
  });

  it('can issue non-Secure cookies when configured', async () => {
    const auth = createInMemoryAuthStore();
    const server = createServer({
      memnest: createMemnest({ store: createInMemoryStore() }),
      auth,
      session: { secureCookie: false, ttlMs: 60_000 },
      keyring: { argon2: { memoryCost: 1024, timeCost: 1, parallelism: 1 } },
    });
    const { key: plain } = await server.keyring.issue({ name: 'local' });
    const response = await server.app.request('http://memnest.test/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: plain }),
    });
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).not.toMatch(/Secure/);
    expect(setCookie).toMatch(/Max-Age=60/);
  });
});
