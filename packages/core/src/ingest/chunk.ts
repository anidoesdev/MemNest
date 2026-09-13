import type { TokenCounter } from '../ports';
import { renderTurn, type NormalizedContent } from './normalize';

export interface ChunkOptions {
  /** Soft ceiling per chunk. Default 400. */
  targetTokens: number;
  /** Prose overlap carried into the next chunk. Default 60. */
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetTokens: 400, overlapTokens: 60 };

export interface ChunkDraft {
  content: string;
  tokens: number;
}

/** Type-aware chunking: turns for conversations, headings for markdown, paragraphs for prose. */
export function chunkContent(
  content: NormalizedContent,
  counter: TokenCounter,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkDraft[] {
  let pieces: string[];
  switch (content.kind) {
    case 'conversation':
      pieces = chunkConversation(content, counter, options);
      break;
    case 'markdown':
      pieces = chunkMarkdown(content.text, counter, options);
      break;
    case 'text':
      pieces = chunkProse(content.text, counter, options);
      break;
  }
  return pieces
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ content: p, tokens: counter.count(p) }));
}

function chunkConversation(
  content: NormalizedContent,
  counter: TokenCounter,
  options: ChunkOptions,
): string[] {
  const units: string[] = [];
  for (const turn of content.turns ?? []) {
    const rendered = renderTurn(turn);
    if (counter.count(rendered) <= options.targetTokens) {
      units.push(rendered);
      continue;
    }
    // An oversized turn is split, and every piece keeps its speaker.
    const prefix = rendered.slice(0, rendered.length - turn.content.length);
    const budget = { ...options, overlapTokens: 0, targetTokens: options.targetTokens - counter.count(prefix) };
    for (const piece of chunkProse(turn.content, counter, budget)) units.push(prefix + piece);
  }
  // Turn boundaries are hard boundaries: no overlap.
  return pack(units, '\n\n', counter, options.targetTokens, 0);
}

function chunkMarkdown(text: string, counter: TokenCounter, options: ChunkOptions): string[] {
  const sections: string[] = [];
  let pendingHeadings = '';
  for (const section of text.split(/\n(?=#{1,6}\s)/)) {
    const lines = section.split('\n');
    const isHeadingOnly = /^#{1,6}\s/.test(lines[0] ?? '') && lines.slice(1).join('').trim() === '';
    if (isHeadingOnly) {
      // A bare heading introduces the next section rather than standing alone.
      pendingHeadings += `${section.trim()}\n`;
      continue;
    }
    sections.push(pendingHeadings + section);
    pendingHeadings = '';
  }
  if (pendingHeadings) sections.push(pendingHeadings);

  const out: string[] = [];
  for (const section of sections) {
    if (counter.count(section) <= options.targetTokens) {
      out.push(section);
      continue;
    }
    const firstLineEnd = section.indexOf('\n');
    const heading = /^#{1,6}\s/.test(section) && firstLineEnd > 0 ? section.slice(0, firstLineEnd) : '';
    const body = heading ? section.slice(firstLineEnd + 1).trimStart() : section;
    const budget = { ...options, targetTokens: options.targetTokens - counter.count(heading) };
    for (const piece of chunkProse(body, counter, budget)) out.push(heading ? `${heading}\n${piece}` : piece);
  }
  return out;
}

function chunkProse(text: string, counter: TokenCounter, options: ChunkOptions): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    if (counter.count(paragraph) <= options.targetTokens) units.push(paragraph);
    else units.push(...splitOversized(paragraph, counter, options.targetTokens));
  }
  return pack(units, '\n\n', counter, options.targetTokens, options.overlapTokens);
}

function splitOversized(text: string, counter: TokenCounter, target: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const units: string[] = [];
  for (const sentence of sentences) {
    if (counter.count(sentence) <= target) {
      units.push(sentence);
      continue;
    }
    let current = '';
    for (const word of sentence.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (current && counter.count(next) > target) {
        units.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) units.push(current);
  }
  return pack(units, ' ', counter, target, 0);
}

/** Greedily packs units up to `target`, carrying trailing units worth up to `overlap` tokens forward. */
function pack(
  units: string[],
  separator: string,
  counter: TokenCounter,
  target: number,
  overlap: number,
): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fresh = 0;

  for (const unit of units) {
    const candidate = [...current, unit].join(separator);
    if (fresh > 0 && counter.count(candidate) > target) {
      out.push(current.join(separator));
      const carried: string[] = [];
      let carriedTokens = 0;
      for (let i = current.length - 1; i > 0 && overlap > 0; i--) {
        const tokens = counter.count(current[i]!);
        if (carriedTokens + tokens > overlap) break;
        carried.unshift(current[i]!);
        carriedTokens += tokens;
      }
      current = counter.count([...carried, unit].join(separator)) <= target ? [...carried, unit] : [unit];
      fresh = 1;
    } else {
      current.push(unit);
      fresh++;
    }
  }
  if (fresh > 0) out.push(current.join(separator));
  return out;
}
