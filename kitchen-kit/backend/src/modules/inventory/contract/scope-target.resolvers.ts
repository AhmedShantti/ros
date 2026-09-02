/**
 * Inventory PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * A count session and a count line name no location and no branch in the path,
 * yet posting one writes `count_adjustment` movements against a real location's
 * stock. The owning location — and through it the owning branch — is read from
 * the row.
 */
export const INVENTORY_COUNT_SESSION_TARGET_RESOLVER = Symbol(
  'INVENTORY_COUNT_SESSION_TARGET_RESOLVER',
);

export const INVENTORY_COUNT_LINE_TARGET_RESOLVER = Symbol(
  'INVENTORY_COUNT_LINE_TARGET_RESOLVER',
);
