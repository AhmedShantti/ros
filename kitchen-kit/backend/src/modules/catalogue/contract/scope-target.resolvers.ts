/**
 * Catalogue PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * `catalogue.price_lists` carries its own `scope_type` + `scope_id`
 * (tenant/brand/branch — `branch_group` is deliberately absent, C-06), and
 * `catalogue.availability_rules.branch_id` is nullable with NULL meaning "every
 * branch" (FR-MNU-030). Both are read from the row: a price list's scope is
 * what it already IS, not what a caller says it is.
 */
export const CATALOGUE_PRICE_LIST_TARGET_RESOLVER = Symbol(
  'CATALOGUE_PRICE_LIST_TARGET_RESOLVER',
);

export const CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER = Symbol(
  'CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER',
);
