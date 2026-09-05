/**
 * Production PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * `production.recipes` carries `scope` with `brand_id` / `branch_id`
 * (D-17-03, `ck_recipe_scope`), so a recipe already knows what it belongs to.
 * Every version, line and publish route addresses the recipe by its own id.
 */
export const PRODUCTION_RECIPE_TARGET_RESOLVER = Symbol(
  'PRODUCTION_RECIPE_TARGET_RESOLVER',
);
