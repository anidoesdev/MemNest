import { describe, expect, it } from 'vitest';
import { approxTokenCounter, chunkContent, normalizeContent } from '../src/index';

const opts = { targetTokens: 50, overlapTokens: 15 };

describe('normalizeContent', () => {
  it('detects kinds', () => {
    expect(normalizeContent([{ role: 'user', content: 'hi' }]).kind).toBe('conversation');
    expect(normalizeContent('# Title\n\nBody').kind).toBe('markdown');
    expect(normalizeContent('Just prose.').kind).toBe('text');
  });

  it('normalizes whitespace and line endings', () => {
    expect(normalizeContent('a  \r\n\r\n\r\n\r\nb\t').text).toBe('a\n\nb');
  });
});

describe('chunkContent', () => {
  it('splits conversations on turn boundaries only', () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `Turn ${i} talks about topic ${i} in a sentence long enough to matter.`,
    }));
    const chunks = chunkContent(normalizeContent(turns), approxTokenCounter, opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/^(user|assistant): Turn \d+/);
      expect(chunk.content).toMatch(/matter\.$/);
      expect(chunk.tokens).toBeLessThanOrEqual(opts.targetTokens);
    }
    // No overlap between conversation chunks: every turn appears exactly once.
    const all = chunks.map((c) => c.content).join('\n\n');
    for (let i = 0; i < 12; i++) expect(all.match(new RegExp(`Turn ${i} `, 'g'))).toHaveLength(1);
  });

  it('keeps the speaker on every piece of an oversized turn', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} is here.`).join(' ');
    const chunks = chunkContent(normalizeContent([{ role: 'user', content: long }]), approxTokenCounter, opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.startsWith('user: ')).toBe(true);
  });

  it('chunks markdown on headings and keeps the heading on split sections', () => {
    const body = Array.from({ length: 30 }, (_, i) => `Line ${i} of the long section.`).join('\n\n');
    const md = `# Guide\n\n## Short\n\nA short section.\n\n## Long\n\n${body}`;
    const chunks = chunkContent(normalizeContent(md), approxTokenCounter, opts);
    expect(chunks[0]!.content).toBe('# Guide\n## Short\n\nA short section.');
    const longChunks = chunks.slice(1);
    expect(longChunks.length).toBeGreaterThan(1);
    for (const chunk of longChunks) expect(chunk.content.startsWith('## Long\n')).toBe(true);
  });

  it('packs prose paragraphs with overlap', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} has a few words.`).join('\n\n');
    const chunks = chunkContent(normalizeContent(text), approxTokenCounter, opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]!.content;
      const opening = chunks[i]!.content.split('\n\n')[0]!;
      // Each chunk opens with a tail of the previous one, and still ends where the previous one ended.
      expect(previous).toContain(opening);
      expect(chunks[i]!.content).toContain(previous.split('\n\n').at(-1)!);
    }
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(opts.targetTokens);
  });
});
