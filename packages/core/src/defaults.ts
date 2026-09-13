import type { Clock, IdGenerator, TokenCounter } from './ports';

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const randomIds: IdGenerator = {
  next: (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`,
};

/**
 * ~4 characters per token. Good enough for budget packing without a tokenizer
 * dependency; inject a real TokenCounter when budgets are tight.
 */
export const approxTokenCounter: TokenCounter = {
  count: (text) => (text.length === 0 ? 0 : Math.ceil(text.length / 4)),
};
