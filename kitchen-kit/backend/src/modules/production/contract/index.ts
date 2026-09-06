export * from './consumption.contract';
export * from './consumption-gap.errors';
// Re-exported (not moved — Inventory's pre-existing `inventory->production`
// KNOWN_DEVIATIONS entry for `costing/recipe-cost.port` is untouched) so a
// NEW consumer (Sales, P1F-2) reaches it through the public contract path
// instead of adding a second private import and growing KNOWN_DEVIATIONS.
export { RECIPE_COST_RECOMPUTER } from '../costing/recipe-cost.port';
export type { RecipeCostRecomputer } from '../costing/recipe-cost.port';
export * from './scope-target.resolvers';
/**
 * SIGNUP-1 — thin re-export of the existing Production permission catalog,
 * mirroring Kitchen's `KDS_PERMISSIONS` re-export pattern. Consumed by
 * Identity's production-safe permission-catalog aggregator.
 */
export { PRODUCTION_PERMISSIONS, PRODUCTION_PERMISSION_DEFS } from '../production.permissions';
