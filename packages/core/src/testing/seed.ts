import type { Memnest } from '../engine';
import type { Memory, MemoryKind } from '../types';

export interface SeedOptions {
  containerTag: string;
  count: number;
  /** Memories per direct write. Default 1000. */
  batchSize?: number;
}

const PEOPLE = ['Alex', 'Sam', 'Priya', 'Jordan', 'Mei', 'Tomás', 'Aisha', 'Lars', 'Kenji', 'Zoe'];
const TOPICS = [
  ['works at', ['Stripe', 'Google', 'Figma', 'Shopify', 'Notion', 'Datadog']],
  ['lives in', ['Seattle', 'Berlin', 'Lisbon', 'Toronto', 'Singapore', 'Austin']],
  ['prefers', ['Postgres', 'MySQL', 'SQLite', 'MongoDB', 'DynamoDB', 'Redis']],
  ['is learning', ['Rust', 'Go', 'Elixir', 'Zig', 'OCaml', 'Kotlin']],
  ['drinks', ['espresso', 'green tea', 'oat lattes', 'cold brew', 'chai', 'matcha']],
  ['plays', ['chess', 'tennis', 'the cello', 'go', 'football', 'the piano']],
] as const;
const KINDS: MemoryKind[] = ['fact', 'preference', 'episode'];

/**
 * Deterministic synthetic memories with real structure: ~80% base facts, ~10%
 * updates superseding a base fact, ~10% extending one, and every 50th forgotten.
 */
export async function seedMemories(memnest: Memnest, options: SeedOptions): Promise<Memory[]> {
  const batchSize = options.batchSize ?? 1000;
  const updates = Math.floor(options.count * 0.1);
  const extensions = Math.floor(options.count * 0.1);
  const baseCount = options.count - updates - extensions;
  const written: Memory[] = [];

  const fact = (i: number, shift = 0) => {
    const person = PEOPLE[i % PEOPLE.length]!;
    const [verb, objects] = TOPICS[Math.floor(i / PEOPLE.length) % TOPICS.length]!;
    return `${person} #${i} ${verb} ${objects[(i + shift) % objects.length]}.`;
  };

  for (let start = 0; start < baseCount; start += batchSize) {
    const size = Math.min(batchSize, baseCount - start);
    written.push(
      ...(await memnest.addMemories({
        containerTag: options.containerTag,
        memories: Array.from({ length: size }, (_, j) => ({
          content: fact(start + j),
          kind: KINDS[(start + j) % KINDS.length]!,
          confidence: 0.6 + (((start + j) * 7) % 40) / 100,
        })),
      })),
    );
  }

  const base = written.slice();
  const step = updates > 0 ? Math.max(1, Math.floor(base.length / updates)) : 1;
  const derived: Array<{ content: string; supersedes?: string; extendsIds?: string[] }> = [];
  for (let i = 0; i < updates && i * step < base.length; i++) {
    derived.push({ content: fact(i * step, 1), supersedes: base[i * step]!.id });
  }
  for (let i = 0; i < extensions && base.length > 0; i++) {
    const target = base[(i * step + Math.floor(step / 2)) % base.length]!;
    derived.push({ content: `${target.content.replace(/\.$/, '')}, and has for ${2 + (i % 9)} years.`, extendsIds: [target.id] });
  }
  for (let start = 0; start < derived.length; start += batchSize) {
    written.push(
      ...(await memnest.addMemories({ containerTag: options.containerTag, memories: derived.slice(start, start + batchSize) })),
    );
  }

  const scope = { containerTag: options.containerTag };
  for (let i = 49; i < written.length; i += 50) await memnest.forget(scope, written[i]!.id);
  return written;
}
