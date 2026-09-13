import type { MemoryStore, MemoryStoreOps, TokenCounter } from '../ports';
import type { Document, Scope } from '../types';

export interface ExtractionGroup {
  /** Unextracted documents in the group, oldest version first. All become sources. */
  documents: Document[];
  /** The newest document: its date anchors relative time. */
  latest: Document;
  /** New content to extract from. Empty when nothing new remains. */
  transcript: string;
  /** Tail of content already extracted earlier, for resolving references only. */
  priorContext?: string;
}

export interface GroupOptions {
  /** Batched mode groups by customId; instant mode extracts the one document. */
  grouping: boolean;
  tokenCounter: TokenCounter;
  /** Default 1500. */
  priorContextTokens: number;
}

function tail(text: string, counter: TokenCounter, maxTokens: number): string {
  const paragraphs = text.split(/\n{2,}/);
  const kept: string[] = [];
  let used = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const tokens = counter.count(paragraphs[i]!);
    if (used + tokens > maxTokens && kept.length > 0) break;
    kept.unshift(paragraphs[i]!);
    used += tokens;
  }
  return kept.join('\n\n');
}

/**
 * Grouping is the quality lever. A session sent as successive versions of one
 * customId is extracted once, from the newest version, and only the part that has
 * not been extracted before.
 */
export async function loadExtractionGroup(
  store: MemoryStore | MemoryStoreOps,
  scope: Scope,
  documentId: string,
  options: GroupOptions,
): Promise<ExtractionGroup | null> {
  const doc = await store.getDocument(scope, documentId);
  if (!doc || doc.deletedAt || doc.status === 'extracted') return null;

  let pending: Document[] = [doc];
  let processed: Document | undefined;
  if (options.grouping && doc.customId !== undefined) {
    const versions = await store.findDocuments(scope, { customId: doc.customId });
    pending = versions.filter((d) => !d.deletedAt && d.status !== 'extracted').sort((a, z) => a.version - z.version);
    const oldestPending = pending[0]?.version ?? doc.version;
    processed = versions
      .filter((d) => !d.deletedAt && d.status === 'extracted' && d.version < oldestPending)
      .sort((a, z) => z.version - a.version)[0];
  }
  if (pending.length === 0) return null;

  // Cumulative transcripts: a version that starts with the previous one replaces it.
  const parts: Document[] = [];
  for (const d of pending) {
    while (parts.length > 0 && d.content.startsWith(parts.at(-1)!.content)) parts.pop();
    parts.push(d);
  }

  const texts = parts.map((p) => p.content);
  let priorContext: string | undefined;
  if (processed?.content && texts[0]!.startsWith(processed.content)) {
    texts[0] = texts[0]!.slice(processed.content.length).trim();
    priorContext = tail(processed.content, options.tokenCounter, options.priorContextTokens);
  }

  return {
    documents: pending,
    latest: pending.at(-1)!,
    transcript: texts.filter((t) => t.length > 0).join('\n\n---\n\n'),
    ...(priorContext ? { priorContext } : {}),
  };
}

/** Splits a long transcript into windows of paragraphs that each fit a completion call. */
export function transcriptWindows(transcript: string, counter: TokenCounter, maxTokens: number): string[] {
  const windows: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const paragraph of transcript.split(/\n{2,}/)) {
    const tokens = counter.count(paragraph);
    if (current.length > 0 && used + tokens > maxTokens) {
      windows.push(current.join('\n\n'));
      current = [];
      used = 0;
    }
    current.push(paragraph);
    used += tokens;
  }
  if (current.length > 0) windows.push(current.join('\n\n'));
  return windows;
}
