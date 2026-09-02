/**
 * Treasury PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * A cash session is addressed by its own id on every movement and close route;
 * the branch it belongs to appears nowhere in the path. `treasury.cash_sessions`
 * carries a real `branch_id` with a tenant-safe composite FK, so the owning
 * branch is read from the row rather than accepted from the caller.
 */
export const TREASURY_CASH_SESSION_TARGET_RESOLVER = Symbol(
  'TREASURY_CASH_SESSION_TARGET_RESOLVER',
);
