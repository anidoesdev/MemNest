import { createInMemoryStore } from '@memnest/core/testing';
import { TransactionsUnsupportedError, createInMemoryAuthStore } from '@memnest/core';
import { describe, expect, it } from 'vitest';
import { defineAuthStoreContract, defineStoreContract } from '../src/index';

defineAuthStoreContract('in-memory', async () => ({ auth: createInMemoryAuthStore() }));

for (const vector of [false, true]) {
  defineStoreContract(vector ? 'in-memory (vector)' : 'in-memory', async () => {
    const store = createInMemoryStore({ vector });
    return {
      store,
      closeAndDump: async () => {
        const dump = store.dump();
        await store.close();
        return dump;
      },
    };
  });
}

describe('in-memory store without transactions', () => {
  it('refuses to write rather than write partial graphs', async () => {
    const store = createInMemoryStore({ transactions: false });
    await expect(store.transaction(async () => undefined)).rejects.toBeInstanceOf(TransactionsUnsupportedError);
  });
});
