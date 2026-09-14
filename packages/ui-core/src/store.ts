/** What every controller exposes. Framework wrappers subscribe and read; they never mutate. */
export interface Observable<S> {
  getState(): S;
  /** Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface Store<S> extends Observable<S> {
  /** Replaces the state with a new object, so snapshot identity changes exactly when state does. */
  set(patch: Partial<S> | ((state: S) => Partial<S>)): void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * Drops results of superseded async work: `const token = seq.next()` before awaiting,
 * `if (!seq.isCurrent(token)) return` after.
 */
export function createSequencer() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (token: number) => token === current,
    /** Invalidates everything in flight (dispose). */
    cancel: () => {
      current++;
    },
  };
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
