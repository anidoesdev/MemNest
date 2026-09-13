const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does doing for from had has have he her hers him his how i if in into is it its ' +
    'me my of on or our she so than that the their them then there these they this those to too was we were what when where which ' +
    'who whom why will with would you your ' +
    // Extraction writes every memory about "the user", so the word carries no signal.
    's user'
  ).split(' '),
);

/** Lowercased word terms. */
export function terms(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Query terms for lexical retrieval: stopwords removed, unless that would leave
 * nothing. Deduplicated, order preserved.
 */
export function queryTerms(query: string): string[] {
  const all = terms(query);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return [...new Set(meaningful.length > 0 ? meaningful : all)];
}
