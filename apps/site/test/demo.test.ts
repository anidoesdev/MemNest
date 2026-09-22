import { describe, expect, it } from 'vitest';
import { createDemo, DEMO_SECRET } from '../src/demo';

// The landing page promises this story; these assertions keep the promise true.
describe('landing page preview', () => {
  it('runs the Acme story through the real engine', async () => {
    const demo = createDemo();

    const onboarding = await demo.ingest('onboarding');
    expect(onboarding.stored).not.toContain(DEMO_SECRET);
    expect(onboarding.run.stats!.rejected.map((r) => r.reason).sort()).toEqual(['low-confidence', 'secret', 'unresolved-pronoun']);
    expect(onboarding.run.stats!.created).toBe(3);

    const ticket = await demo.ingest('ticket');
    const relations = ticket.run.stats!.decisions.map((d) => `${d.relation}/${d.via}`);
    expect(relations).toEqual(['updates/model', 'extends/model', 'duplicate/exact']);

    const recalled = await demo.recall('What database does the payments service use?', 200);
    const contents = recalled.memories.map((m) => m.memory.content);
    expect(contents.some((c) => c.includes('MySQL'))).toBe(true);
    expect(contents.some((c) => c.includes('on Postgres.'))).toBe(false);
    expect(recalled.trace.candidates.some((c) => c.excludedReason === 'not-latest')).toBe(true);

    await demo.ingest('followup');
    const all = await demo.memories();
    const wrong = all.find((m) => m.content.includes('Enterprise'))!;
    await demo.forget(wrong.id);
    expect((await demo.recall('Enterprise plan', 500)).memories.map((m) => m.memory.id)).not.toContain(wrong.id);
    expect((await demo.profile()).text).not.toContain('Enterprise');

    expect((await demo.recall('incident review', 500)).memories.some((m) => m.memory.kind === 'episode')).toBe(true);
    demo.advanceTo('2026-07-01T09:00:00.000Z');
    const later = await demo.recall('incident review', 500);
    expect(later.memories.some((m) => m.memory.kind === 'episode')).toBe(false);
    expect(later.trace.candidates.some((c) => c.excludedReason === 'expired')).toBe(true);

    const direct = await demo.remember('Acme moved incident updates to a shared Slack channel.', { kind: 'preference' });
    expect(direct.id).toMatch(/^mem_/);
  });
});
