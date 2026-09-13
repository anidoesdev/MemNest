import { createInMemoryStore } from '@memnest/core/testing';
import { TransactionsUnsupportedError } from '@memnest/core';
import { describe, expect, it } from 'vitest';
import { defineStoreContract } from '../src/index';

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
