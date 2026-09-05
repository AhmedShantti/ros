/**
 * Workforce PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/workforce/contract` and nothing else. The
 * `module-boundaries.spec.ts` architecture test enforces that mechanically,
 * which is what SRS §5.2.3 requires of the rule.
 */
export * from './commands';
export * from './types';
export * from './attendance-summary.query';
export * from './scope-target.resolvers';
/**
 * SIGNUP-1 — thin re-export of the existing Workforce permission catalog,
 * mirroring Kitchen's `KDS_PERMISSIONS` re-export pattern (a pass-through of an
 * existing constant, not new permission surface). Consumed by Identity's
 * production-safe permission-catalog aggregator.
 */
export { WORKFORCE_PERMISSIONS, WORKFORCE_PERMISSION_DEFS } from '../workforce.permissions';
