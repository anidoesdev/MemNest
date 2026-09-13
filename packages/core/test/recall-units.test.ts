import { describe, expect, it } from 'vitest';
import { exclusionReason, packByBudget, queryTerms, type Memory } from '../src/index';

const base: Memory = {
  id: 'mem_1',
  containerTag: 'user:1',
  content: 'x',
  kind: 'fact',
  confidence: 1,
  isLatest: true,
  version: 1,
  extendsIds: [],
  sourceDocumentIds: ['doc_1'],
  extractionRunId: 'run_1',
  validFrom: '2026-01-01T00:00:00.000Z',
  reinforcementCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const now = '2026-02-01T00:00:00.000Z';

describe('exclusionReason', () => {
  it('serves latest, unexpired, remembered memories', () => {
    expect(exclusionReason(base, now)).toBeUndefined();
    expect(exclusionReason({ ...base, validUntil: '2026-03-01T00:00:00.000Z' }, now)).toBeUndefined();
  });

  it('ranks forgotten over not-latest over expired', () => {
    const everything = { ...base, isLatest: false, forgottenAt: now, validUntil: '2026-01-02T00:00:00.000Z' };
    expect(exclusionReason(everything, now)).toBe('forgotten');
    expect(exclusionReason({ ...everything, forgottenAt: undefined }, now)).toBe('not-latest');
    expect(exclusionReason({ ...base, validUntil: now }, now)).toBe('expired');
  });
});

describe('packByBudget', () => {
  it('takes items in value order and skips ones that no longer fit', () => {
    const result = packByBudget([{ tokens: 60 }, { tokens: 50 }, { tokens: 30 }, { tokens: 10 }], 100);
    expect([...result.included]).toEqual([0, 2, 3]);
    expect(result.used).toBe(100);
  });

  it('respects budget already used', () => {
    expect(packByBudget([{ tokens: 10 }], 15, 10).included.size).toBe(0);
  });
});

describe('queryTerms', () => {
  it('drops stopwords but never returns nothing for a real query', () => {
    expect(queryTerms('What database does this user use?')).toEqual(['database', 'use']);
    expect(queryTerms('what is it')).toEqual(['what', 'is', 'it']);
  });
});
