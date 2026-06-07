import type { IdempotencyStore } from '../ports/index'

// Wrap a side-effecting operation so a retry with the same key returns the cached result instead of
// running again, and concurrent duplicates collapse onto one execution. Used by every money-moving
// mutation. The single-flight + dedup + release-on-failure guarantees live in the store (§6.1); this
// is the stable call site every caller imports so the contract is enforced uniformly.
export const withIdempotency = <T>(
  store: IdempotencyStore,
  scope: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> => store.execute(scope, key, fn)
