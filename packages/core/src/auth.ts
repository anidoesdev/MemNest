import { ValidationError } from './errors';
import type { AuthStore } from './ports';
import type { ApiKeyRecord, SessionRecord } from './types';

/**
 * `mnk_<12 hex id>_<secret>`. The id is public and locates the stored hash; only the secret
 * is verified. The prefix lets the redactor, secret scanners and humans recognise a key.
 */
export const API_KEY_PATTERN = /\bmnk_([0-9a-f]{12})_([A-Za-z0-9_-]{32,128})/;
const EXACT_API_KEY = /^mnk_([0-9a-f]{12})_([A-Za-z0-9_-]{32,128})$/;

export interface ParsedApiKey {
  id: string;
  secret: string;
}

export function formatApiKey(id: string, secret: string): string {
  const key = `mnk_${id}_${secret}`;
  if (!parseApiKey(key)) throw new ValidationError('API key id must be 12 hex characters and the secret 32-128 base64url characters');
  return key;
}

/** Null for anything that is not exactly one well-formed key. */
export function parseApiKey(value: string): ParsedApiKey | null {
  const match = EXACT_API_KEY.exec(value);
  return match ? { id: match[1]!, secret: match[2]! } : null;
}

export interface InMemoryAuthStore extends AuthStore {
  /** Every stored record, for tests that grep what was persisted. */
  dump(): { keys: ApiKeyRecord[]; sessions: SessionRecord[] };
}

/** Process-local credentials, for tests. Persistent stores ship `authStore()` on their own tables. */
export function createInMemoryAuthStore(): InMemoryAuthStore {
  const keys = new Map<string, ApiKeyRecord>();
  const sessions = new Map<string, SessionRecord>();
  const copy = <T>(value: T): T => ({ ...value });

  return {
    async putApiKey(key) {
      if (keys.has(key.id)) throw new ValidationError(`API key ${key.id} already exists`);
      keys.set(key.id, copy(key));
    },
    async getApiKey(id) {
      const key = keys.get(id);
      return key ? copy(key) : null;
    },
    async listApiKeys() {
      return [...keys.values()].map(copy);
    },
    async revokeApiKey(id, at) {
      const key = keys.get(id);
      if (!key || key.revokedAt) return false;
      key.revokedAt = at;
      for (const [sessionId, session] of sessions) if (session.keyId === id) sessions.delete(sessionId);
      return true;
    },
    async touchApiKey(id, at) {
      const key = keys.get(id);
      if (key) key.lastUsedAt = at;
    },
    async putSession(session) {
      if (!keys.has(session.keyId)) throw new ValidationError(`API key ${session.keyId} does not exist`);
      sessions.set(session.id, copy(session));
    },
    async getSession(id) {
      const session = sessions.get(id);
      return session ? copy(session) : null;
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async deleteExpiredSessions(now) {
      let deleted = 0;
      for (const [id, session] of sessions) {
        if (session.expiresAt <= now) {
          sessions.delete(id);
          deleted++;
        }
      }
      return deleted;
    },
    dump: () => ({ keys: [...keys.values()].map(copy), sessions: [...sessions.values()].map(copy) }),
  };
}
