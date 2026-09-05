export * from './sale-depletion.contract';
export * from './sale-depletion.errors';
export * from './post-fire-void-disposition.contract';
export * from './branch-inventory-snapshot.query';
export * from './scope-target.resolvers';
/**
 * SIGNUP-1 — thin re-export of the existing Inventory permission catalog,
 * mirroring Kitchen's `KDS_PERMISSIONS` re-export pattern. Consumed by
 * Identity's production-safe permission-catalog aggregator.
 */
export { INVENTORY_PERMISSIONS, INVENTORY_PERMISSION_DEFS } from '../inventory.permissions';
