/**
 * Sales PUBLIC contract barrel — SRS §5.4.
 *
 * `events.ts` was the only export before P1G-1. `cash-session-tender-
 * totals.query.ts` (P1G-1 migration 34) is Sales' FIRST published `contract/`
 * QUERY — the CashSession tender totals a CashSession Close needs
 * (FR-FIN-004/010), mirroring `treasury/contract`'s
 * `CASH_SESSION_FACTS_QUERY` in the opposite direction. Other modules
 * (Treasury included) MUST import only this barrel, never a private path
 * under `modules/sales/orders/` — `module-boundaries.spec.ts` is the
 * mechanical enforcement §5.2.3 requires.
 */
export * from './events';
export * from './cash-session-tender-totals.query';
export * from './daily-trading-sales.query';
export * from './day-close-sales-facts.query';
export * from './scope-target.resolvers';
/**
 * SIGNUP-1 — thin re-export of the existing Sales permission catalog, mirroring
 * Kitchen's `KDS_PERMISSIONS` re-export pattern. Consumed by Identity's
 * production-safe permission-catalog aggregator.
 */
export { SALES_PERMISSIONS, SALES_PERMISSION_DEFS } from '../sales.permissions';
