/**
 * Reporting PUBLIC contract barrel — SRS §5.4.
 *
 * Reporting's FIRST published `contract/`. Other modules MUST import only this
 * barrel, never a private Reporting path — `module-boundaries.spec.ts`
 * enforces that mechanically.
 *
 * SIGNUP-1 — thin re-export of the existing Reporting permission catalog,
 * mirroring Kitchen's `KDS_PERMISSIONS` re-export pattern (a pass-through of an
 * existing constant, not new permission surface). Consumed by Identity's
 * production-safe permission-catalog aggregator.
 */
export {
  REPORTING_PERMISSIONS,
  REPORTING_PERMISSION_DEFS,
} from '../reporting.permissions';
