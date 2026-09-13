import { MemnestError, type ApiKeyRecord, type AuthStore, type SessionRecord } from '@memnest/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export interface AuthStoreHarness {
  auth: AuthStore;
  cleanup?(): Promise<void>;
}

const key = (id: string, extra: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  id,
  name: `key ${id}`,
  secretHash: `$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$${id}`,
  createdAt: '2026-03-01T09:00:00.000Z',
  ...extra,
});

const session = (id: string, keyId: string, expiresAt = '2026-03-02T09:00:00.000Z'): SessionRecord => ({
  id,
  keyId,
  createdAt: '2026-03-01T09:00:00.000Z',
  expiresAt,
});

export function defineAuthStoreContract(name: string, createHarness: () => Promise<AuthStoreHarness>): void {
  describe(`AuthStore contract: ${name}`, () => {
    let harness: AuthStoreHarness;
    let auth: AuthStore;

    beforeEach(async () => {
      harness = await createHarness();
      auth = harness.auth;
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('stores keys with and without a container scope, and never overwrites one', async () => {
      await auth.putApiKey(key('aaaaaaaaaaaa', { containerTag: 'user:123' }));
      await auth.putApiKey(key('bbbbbbbbbbbb', { createdAt: '2026-03-01T10:00:00.000Z' }));

      expect(await auth.getApiKey('aaaaaaaaaaaa')).toEqual(key('aaaaaaaaaaaa', { containerTag: 'user:123' }));
      expect(await auth.getApiKey('bbbbbbbbbbbb')).toEqual(key('bbbbbbbbbbbb', { createdAt: '2026-03-01T10:00:00.000Z' }));
      expect(await auth.getApiKey('cccccccccccc')).toBeNull();
      expect((await auth.listApiKeys()).map((k) => k.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);

      const error = await auth.putApiKey(key('aaaaaaaaaaaa', { name: 'overwrite' })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemnestError);
      expect((error as MemnestError).code).toBe('validation');
      expect((await auth.getApiKey('aaaaaaaaaaaa'))!.name).toBe('key aaaaaaaaaaaa');
    });

    it('records use, and revokes once, ending the key’s sessions', async () => {
      await auth.putApiKey(key('aaaaaaaaaaaa'));
      await auth.putApiKey(key('bbbbbbbbbbbb'));
      await auth.putSession(session('s1', 'aaaaaaaaaaaa'));
      await auth.putSession(session('s2', 'bbbbbbbbbbbb'));

      await auth.touchApiKey('aaaaaaaaaaaa', '2026-03-01T11:00:00.000Z');
      expect((await auth.getApiKey('aaaaaaaaaaaa'))!.lastUsedAt).toBe('2026-03-01T11:00:00.000Z');

      expect(await auth.revokeApiKey('aaaaaaaaaaaa', '2026-03-01T12:00:00.000Z')).toBe(true);
      expect(await auth.revokeApiKey('aaaaaaaaaaaa', '2026-03-01T13:00:00.000Z')).toBe(false);
      expect(await auth.revokeApiKey('cccccccccccc', '2026-03-01T13:00:00.000Z')).toBe(false);
      expect((await auth.getApiKey('aaaaaaaaaaaa'))!.revokedAt).toBe('2026-03-01T12:00:00.000Z');
      expect(await auth.getSession('s1')).toBeNull();
      expect(await auth.getSession('s2')).toEqual(session('s2', 'bbbbbbbbbbbb'));
    });

    it('stores, deletes and expires sessions', async () => {
      await auth.putApiKey(key('aaaaaaaaaaaa'));
      await auth.putSession(session('s1', 'aaaaaaaaaaaa', '2026-03-01T10:00:00.000Z'));
      await auth.putSession(session('s2', 'aaaaaaaaaaaa', '2026-03-03T10:00:00.000Z'));
      await auth.putSession(session('s3', 'aaaaaaaaaaaa', '2026-03-03T10:00:00.000Z'));

      expect(await auth.getSession('s1')).toEqual(session('s1', 'aaaaaaaaaaaa', '2026-03-01T10:00:00.000Z'));
      await auth.deleteSession('s3');
      expect(await auth.getSession('s3')).toBeNull();

      expect(await auth.deleteExpiredSessions('2026-03-02T00:00:00.000Z')).toBe(1);
      expect(await auth.getSession('s1')).toBeNull();
      expect(await auth.getSession('s2')).not.toBeNull();
    });

    it('refuses a session for a key that does not exist', async () => {
      await expect(auth.putSession(session('s1', 'cccccccccccc'))).rejects.toThrow();
      expect(await auth.getSession('s1')).toBeNull();
    });
  });
}
