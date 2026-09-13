import type { ConversationTurn } from '../types';

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Stable serialization so identical content always hashes identically. */
export function canonicalContent(content: string | ConversationTurn[]): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(
    content.map((t) => [t.role, t.content, t.name ?? null, t.at ?? null]),
  );
}
