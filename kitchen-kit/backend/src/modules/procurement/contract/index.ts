/**
 * Procurement PUBLIC contract — SRS §5.4.
 *
 * Other modules import `modules/procurement/contract` and nothing else.
 * `module-boundaries.spec.ts` enforces that mechanically.
 */
export * from './procurement-facts.query';
/**
 * FULL-SRS-PRC-PURCHASE-ORDERS-P2 — the `purchase_order.approved` domain
 * event this module publishes.
 */
export * from './events';
/**
 * Thin re-export of the Procurement permission catalog, mirroring
 * Inventory/Kitchen/Workforce's own `contract/index.ts` re-export pattern.
 * Consumed by Identity's production-safe permission-catalog aggregator
 * (`identity/authz/permission-catalog.ts`).
 */
export {
  PROCUREMENT_PERMISSIONS,
  PROCUREMENT_PERMISSION_DEFS,
  PURCHASE_ORDER_CREATE_PERMISSION,
} from '../procurement.permissions';
