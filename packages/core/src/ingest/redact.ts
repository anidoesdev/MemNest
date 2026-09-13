import type { Redactor } from '../ports';
import type { ConversationTurn, Metadata } from '../types';

const SENSITIVE_KEY = /pass|secret|token|key|auth|credential/i;

// Words that contain a sensitive fragment but name ordinary things.
const BENIGN_KEYS = new Set([
  'author',
  'authors',
  'authored',
  'authority',
  'keyboard',
  'keynote',
  'keyword',
  'keywords',
  'passage',
  'passenger',
  'passengers',
  'compass',
  'monkey',
  'turkey',
  'donkey',
  'hockey',
  'jockey',
  'whiskey',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !BENIGN_KEYS.has(key.toLowerCase());
}

const PATTERNS: Array<[RegExp, string]> = [
  // JWTs: header.payload.signature, header and payload are base64url JSON.
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED:jwt]'],
  // Bearer tokens.
  [/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, 'Bearer [REDACTED:bearer]'],
  // sk- / sk_ prefixed secret keys (OpenAI, Anthropic, Stripe, ...).
  [/\b(?:sk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED:secret-key]'],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, '[REDACTED:aws-key]'],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED:github-token]'],
  // "my password is hunter2"
  [/\b(pass(?:word|code|phrase))(\s+(?:is|was)\s+)\S+/gi, '$1$2[REDACTED]'],
];

// key <sep> value, where key may be quoted and value may be quoted or run to a delimiter.
const KEY_VALUE =
  /(^|[\s{,;(\[])((["']?)([A-Za-z0-9_.-]{1,64})\3)(\s*(?:=>|:|=)\s*)(\[REDACTED[^\]\n]*\]|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|(?:\[REDACTED[^\]\n]*\]|[^\n,;}\]])+)/g;

function redactKeyValues(text: string): string {
  return text.replace(
    KEY_VALUE,
    (match, lead: string, quotedKey: string, _q: string, key: string, sep: string, value: string) => {
      if (value.startsWith('[REDACTED')) return match;
      if (!isSensitiveKey(key)) {
        return lead + quotedKey + sep + redactKeyValues(value);
      }
      if (value.startsWith('"')) return `${lead}${quotedKey}${sep}"[REDACTED]"`;
      if (value.startsWith("'")) return `${lead}${quotedKey}${sep}'[REDACTED]'`;
      const trailing = /\s*$/.exec(value)?.[0] ?? '';
      return `${lead}${quotedKey}${sep}[REDACTED]${trailing}`;
    },
  );
}

/**
 * Default redactor. Biased toward over-redaction: a lost word costs less than a
 * persisted credential. Runs before anything is written.
 */
export const defaultRedactor: Redactor = {
  redact(text: string): string {
    let out = text;
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return redactKeyValues(out);
  },
};

export function redactContent(
  content: string | ConversationTurn[],
  redactor: Redactor,
): string | ConversationTurn[] {
  if (typeof content === 'string') return redactor.redact(content);
  return content.map((turn) => {
    const out: ConversationTurn = { role: turn.role, content: redactor.redact(turn.content) };
    if (turn.name !== undefined) out.name = redactor.redact(turn.name);
    if (turn.at !== undefined) out.at = turn.at;
    return out;
  });
}

export function redactMetadata(metadata: Metadata | undefined, redactor: Redactor): Metadata {
  const out: Metadata = {};
  if (!metadata) return out;
  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitiveKey(key)) out[key] = '[REDACTED]';
    else out[key] = typeof value === 'string' ? redactor.redact(value) : value;
  }
  return out;
}
