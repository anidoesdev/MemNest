import { describe, expect, it } from 'vitest';
import { EVAL_CASES, formatReport, runCase, runEvals, type EvalCase } from '../src/index';

const databaseUrl = process.env.MEMNEST_TEST_DATABASE_URL;
const stores = ['memory', 'sqlite', ...(databaseUrl ? (['postgres'] as const) : [])] as const;

describe.each(stores)('eval suite (mock mode, %s store)', (store) => {
  it('passes every case, including resolution', async () => {
    const report = await runEvals({ mode: 'mock', store, ...(databaseUrl ? { databaseUrl } : {}) });
    const failures = report.results.filter((r) => r.status === 'failed');
    expect(failures.map((r) => `${r.name}: ${r.failures.join('; ')}`)).toEqual([]);
    expect(report.pending).toBe(0);
    expect(report.results.filter((r) => r.status === 'skipped').map((r) => r.name)).toEqual(['semantic-recall']);
    expect(report.passed).toBe(EVAL_CASES.length - 1);
    expect(report.results.map((r) => r.name)).toEqual(expect.arrayContaining(['contradiction', 'duplicate', 'extends', 'session-growth']));
    expect(formatReport(report)).toContain(`${report.passed} passed, 0 failed, 0 pending, 1 skipped`);
  }, 60_000);
});

describe('eval harness', () => {
  const base: EvalCase = {
    name: 'harness-check',
    summary: 'harness self-test',
    steps: [{ add: { content: [{ role: 'user', content: 'I live in Berlin.' }], extraction: 'instant' } }, { settle: true }],
    mock: { extraction: [{ candidates: [{ content: 'The user lives in Berlin.', kind: 'fact', confidence: 0.9, validUntil: null }] }] },
    assertions: [],
  };

  it('reports each failed assertion with a reason', async () => {
    const result = await runCase(
      {
        ...base,
        query: { text: 'where does the user live' },
        assertions: [
          { type: 'memory-count', eq: 5 },
          { type: 'memory-exists', matches: 'Paris' },
          { type: 'completion-calls', eq: 2 },
          { type: 'recall-excludes', matches: 'Berlin' },
          { type: 'no-secrets-persisted', secrets: ['Berlin'] },
        ],
      },
      { mode: 'mock' },
    );
    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([
      'expected 5 memories, got 1',
      'no memory matching /Paris/i',
      'expected 2 extraction call(s), got 1',
      'recall served "The user lives in Berlin."',
      'secret persisted: Berlin…',
    ]);
  });

  it('turns thrown errors and failed extraction into failures instead of crashing', async () => {
    const result = await runCase({ ...base, mock: { extraction: [] }, assertions: [{ type: 'memory-count', eq: 1 }] }, { mode: 'mock' });
    expect(result.status).toBe('failed');
    expect(result.failures.join('\n')).toMatch(/failed/);
  });

  it('skips mock-only assertions in live mode', async () => {
    const live = { id: 'fake-live', complete: async () => ({ json: { candidates: [] }, model: 'fake-live' }) };
    const result = await runCase(
      { ...base, assertions: [{ type: 'memory-count', eq: 0 }, { type: 'rejected', reason: 'secret', mockOnly: true }] },
      { mode: 'live', completion: live },
    );
    expect(result).toMatchObject({ status: 'passed', skipped: 1, completionCalls: { extraction: 1, resolution: 0 } });
  });
});
