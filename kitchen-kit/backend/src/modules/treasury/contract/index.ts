/**
 * Treasury PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/treasury/contract` and nothing else.
 * `module-boundaries.spec.ts` enforces that mechanically, which is what SRS
 * §5.2.3 requires of the rule.
 */
export * from './cash-session-facts.query';
export * from './cash-movement-totals.query';
export * from './daily-cash-reconciliation.query';
export * from './day-close-state.query';
export * from './events';
export * from './scope-target.resolvers';
/**
 * SIGNUP-1 — thin re-export of the existing Treasury permission catalog,
 * mirroring Kitchen's `KDS_PERMISSIONS` re-export pattern. Consumed by
 * Identity's production-safe permission-catalog aggregator.
 */
export { TREASURY_PERMISSIONS, TREASURY_PERMISSION_DEFS } from '../treasury.permissions';
