export interface Packable {
  tokens: number;
}

export interface PackResult {
  /** Indexes of `items` that fit, in input order. */
  included: Set<number>;
  used: number;
}

/**
 * `items` must already be ordered by value, highest first. Takes each item that
 * still fits; an item too large for the remainder is skipped, not a stopping
 * point, so a smaller lower-ranked item can still use the space.
 */
export function packByBudget(items: readonly Packable[], limit: number, alreadyUsed = 0): PackResult {
  const included = new Set<number>();
  let used = alreadyUsed;
  items.forEach((item, index) => {
    if (used + item.tokens <= limit) {
      included.add(index);
      used += item.tokens;
    }
  });
  return { included, used };
}
