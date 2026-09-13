import { createHash, randomBytes } from 'node:crypto';
import { hash, verify, type Options as Argon2Options } from '@node-rs/argon2';
import {
  UnauthorizedError,
  ValidationError,
  formatApiKey,
  parseApiKey,
  scopeOf,
  systemClock,
  type ApiKeyRecord,
  type AuthStore,
  type Clock,
  type SessionRecord,
} from '@memnest/core';

/** OWASP's argon2id baseline: 19 MiB, 2 iterations, 1 lane. `2` is Algorithm.Argon2id (a const enum). */
export const ARGON2_OPTIONS: Argon2Options = { algorithm: 2 as Argon2Options['algorithm'], memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export interface KeyringOptions {
  auth: AuthStore;
  clock?: Clock;
  /** Default 12 hours. */
  sessionTtlMs?: number;
  /** `lastUsedAt` is written at most this often per key. Default 60s. */
  touchIntervalMs?: number;
  /** Overrides for tests; production uses ARGON2_OPTIONS. */
  argon2?: Argon2Options;
}

export interface IssuedKey {
  /** Shown once. Only its argon2id hash is stored. */
  key: string;
  record: ApiKeyRecord;
}

export interface CreatedSession {
  /** The cookie value. Only its SHA-256 is stored. */
  token: string;
  session: SessionRecord;
  key: ApiKeyRecord;
}

export interface Keyring {
  issue(input: { name: string; containerTag?: string }): Promise<IssuedKey>;
  /** The key's record, or UnauthorizedError. Unknown, revoked and wrong keys are indistinguishable. */
  verify(key: string): Promise<ApiKeyRecord>;
  revoke(id: string): Promise<boolean>;
  list(): Promise<ApiKeyRecord[]>;
  createSession(key: string): Promise<CreatedSession>;
  /** The session and its key, or UnauthorizedError when either is gone, expired or revoked. */
  resolveSession(token: string): Promise<{ session: SessionRecord; key: ApiKeyRecord }>;
  endSession(token: string): Promise<void>;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const INVALID_KEY = 'invalid API key';
const MAX_VERIFIED = 1000;

export function createKeyring(options: KeyringOptions): Keyring {
  const { auth } = options;
  const clock = options.clock ?? systemClock;
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const touchIntervalMs = options.touchIntervalMs ?? 60_000;
  const argon2 = options.argon2 ?? ARGON2_OPTIONS;

  // argon2 is deliberately slow. Remember which exact key matched which stored hash, so a client
  // sending the same key on every request pays for it once. The stored record is still read on
  // every request, so a revocation takes effect immediately.
  const verified = new Map<string, string>();
  const touched = new Map<string, number>();
  // Unknown key ids still cost one argon2 verification, so response time does not reveal which ids exist.
  let decoy: Promise<string> | undefined;

  async function touch(record: ApiKeyRecord): Promise<void> {
    const now = clock.now();
    const last = touched.get(record.id);
    if (last !== undefined && Date.parse(now) - last < touchIntervalMs) return;
    touched.set(record.id, Date.parse(now));
    await auth.touchApiKey(record.id, now);
  }

  async function verifyKey(key: string): Promise<ApiKeyRecord> {
    const parsed = typeof key === 'string' ? parseApiKey(key) : null;
    if (!parsed) throw new UnauthorizedError(INVALID_KEY);
    const record = await auth.getApiKey(parsed.id);
    if (!record) {
      decoy ??= hash(randomBytes(32).toString('base64url'), argon2);
      await verify(await decoy, parsed.secret, argon2).catch(() => false);
      throw new UnauthorizedError(INVALID_KEY);
    }
    const fingerprint = sha256(key);
    if (verified.get(fingerprint) !== record.secretHash) {
      if (!(await verify(record.secretHash, parsed.secret, argon2).catch(() => false))) throw new UnauthorizedError(INVALID_KEY);
      if (verified.size >= MAX_VERIFIED) verified.delete(verified.keys().next().value!);
      verified.set(fingerprint, record.secretHash);
    }
    if (record.revokedAt) throw new UnauthorizedError(INVALID_KEY);
    await touch(record);
    return record;
  }

  return {
    async issue({ name, containerTag }) {
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
        throw new ValidationError('key name must be 1-200 characters');
      }
      if (containerTag !== undefined) scopeOf(containerTag);
      const id = randomBytes(6).toString('hex');
      const secret = randomBytes(32).toString('base64url');
      const record: ApiKeyRecord = {
        id,
        name: name.trim(),
        secretHash: await hash(secret, argon2),
        ...(containerTag !== undefined ? { containerTag } : {}),
        createdAt: clock.now(),
      };
      await auth.putApiKey(record);
      return { key: formatApiKey(id, secret), record };
    },

    verify: verifyKey,

    revoke: (id) => auth.revokeApiKey(id, clock.now()),

    list: () => auth.listApiKeys(),

    async createSession(key) {
      const record = await verifyKey(key);
      const now = clock.now();
      await auth.deleteExpiredSessions(now);
      const token = randomBytes(32).toString('base64url');
      const session: SessionRecord = {
        id: sha256(token),
        keyId: record.id,
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + sessionTtlMs).toISOString(),
      };
      await auth.putSession(session);
      return { token, session, key: record };
    },

    async resolveSession(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 256) throw new UnauthorizedError('invalid session');
      const session = await auth.getSession(sha256(token));
      if (!session) throw new UnauthorizedError('invalid session');
      if (session.expiresAt <= clock.now()) {
        await auth.deleteSession(session.id);
        throw new UnauthorizedError('session expired');
      }
      const key = await auth.getApiKey(session.keyId);
      if (!key || key.revokedAt) throw new UnauthorizedError('invalid session');
      await touch(key);
      return { session, key };
    },

    async endSession(token) {
      if (typeof token === 'string' && token.length > 0 && token.length <= 256) await auth.deleteSession(sha256(token));
    },
  };
}
