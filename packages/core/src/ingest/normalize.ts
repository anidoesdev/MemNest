import { ValidationError } from '../errors';
import type { ConversationTurn } from '../types';

export type ContentKind = 'conversation' | 'markdown' | 'text';

export interface NormalizedContent {
  kind: ContentKind;
  /** Flattened text as persisted on the document. */
  text: string;
  /** Present for conversations; the chunker splits on these boundaries. */
  turns?: ConversationTurn[];
}

export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderTurn(turn: ConversationTurn): string {
  const speaker = turn.name ? `${turn.role} (${turn.name})` : turn.role;
  return `${speaker}: ${turn.content}`;
}

const MARKDOWN_HEADING = /^#{1,6}\s+\S/m;

export function normalizeContent(content: string | ConversationTurn[]): NormalizedContent {
  if (Array.isArray(content)) {
    const turns = content
      .map((t) => ({ ...t, role: normalizeText(t.role), content: normalizeText(t.content) }))
      .filter((t) => t.content.length > 0);
    if (turns.length === 0) throw new ValidationError('conversation has no non-empty turns');
    return { kind: 'conversation', text: turns.map(renderTurn).join('\n\n'), turns };
  }
  const text = normalizeText(content);
  if (text.length === 0) throw new ValidationError('content is empty');
  return { kind: MARKDOWN_HEADING.test(text) ? 'markdown' : 'text', text };
}
