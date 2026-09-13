import { ProviderError } from '../errors';
import type { Redactor } from '../ports';
import { MEMORY_KINDS, type CandidateRejection, type MemoryKind } from '../types';

export interface Candidate {
  content: string;
  kind: MemoryKind;
  confidence: number;
  validUntil?: string;
}

export interface ScreenedCandidates {
  accepted: Candidate[];
  rejected: Array<{ content: string; reason: CandidateRejection }>;
  total: number;
}

export interface ScreenOptions {
  /** Provider id, for errors. */
  provider: string;
  now: string;
  redactor: Redactor;
  /** Default 0.5. */
  minConfidence: number;
  /** Default 400. */
  maxChars: number;
}

// First and second person are unresolved by definition in a stored memory; so are
// personal third-person pronouns. "it", "this" and "that" are too often legitimate to reject.
const PRONOUNS =
  /\b(I|me|my|mine|myself|we|our|ours|ourselves|you|your|yours|yourself|yourselves|he|him|his|himself|she|her|hers|herself|they|them|their|theirs|themselves)\b/gi;

/** Pronouns that leave a memory dependent on a transcript it will never be shown with. */
export function unresolvedPronouns(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(PRONOUNS)) {
    const word = match[0];
    // "US" the country, "I" as in "Series I" / roman numerals stay; lowercase "us" and a standalone "I" do not.
    if (word === 'US') continue;
    found.add(word.toLowerCase());
  }
  return [...found];
}

/** For duplicate detection: case, whitespace and trailing punctuation do not make a fact different. */
export function comparableContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?;,]+$/, '').trim();
}

function isCandidateShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deterministic screening after the model. The prompt asks for all of this; this
 * enforces it, because a store full of noise is worse than an empty one.
 */
export function screenCandidates(json: unknown, options: ScreenOptions): ScreenedCandidates {
  if (!isCandidateShape(json) || !Array.isArray(json.candidates)) {
    throw new ProviderError(options.provider, 'extraction output does not match the schema: missing "candidates" array', {
      retryable: true,
    });
  }
  const accepted: Candidate[] = [];
  const rejected: ScreenedCandidates['rejected'] = [];
  const seen = new Set<string>();
  const reject = (content: unknown, reason: CandidateRejection) =>
    rejected.push({ content: options.redactor.redact(typeof content === 'string' ? content : JSON.stringify(content)), reason });

  for (const raw of json.candidates) {
    if (!isCandidateShape(raw) || typeof raw.content !== 'string' || typeof raw.confidence !== 'number') {
      reject(raw, 'malformed');
      continue;
    }
    const content = raw.content.replace(/\s+/g, ' ').trim();
    if (!MEMORY_KINDS.includes(raw.kind as MemoryKind)) {
      reject(content, 'malformed');
      continue;
    }
    if (content.split(' ').length < 3) {
      reject(content, 'empty');
      continue;
    }
    if (content.length > options.maxChars) {
      reject(content, 'too-long');
      continue;
    }
    if (content.includes('[REDACTED') || options.redactor.redact(content) !== content) {
      reject(content, 'secret');
      continue;
    }
    if (unresolvedPronouns(content).length > 0) {
      reject(content, 'unresolved-pronoun');
      continue;
    }
    const confidence = Math.min(1, Math.max(0, raw.confidence));
    if (confidence < options.minConfidence) {
      reject(content, 'low-confidence');
      continue;
    }
    let validUntil: string | undefined;
    if (typeof raw.validUntil === 'string' && raw.validUntil.trim() !== '') {
      const parsed = Date.parse(raw.validUntil);
      if (Number.isNaN(parsed)) {
        reject(content, 'malformed');
        continue;
      }
      if (parsed <= Date.parse(options.now)) {
        reject(content, 'already-expired');
        continue;
      }
      validUntil = new Date(parsed).toISOString();
    }
    const key = comparableContent(content);
    if (seen.has(key)) {
      reject(content, 'duplicate-in-batch');
      continue;
    }
    seen.add(key);
    accepted.push({ content, kind: raw.kind as MemoryKind, confidence, ...(validUntil ? { validUntil } : {}) });
  }
  return { accepted, rejected, total: json.candidates.length };
}
