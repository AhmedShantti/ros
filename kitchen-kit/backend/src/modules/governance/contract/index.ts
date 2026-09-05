/**
 * Governance PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/governance/contract` and nothing else.
 * `module-boundaries.spec.ts` enforces that mechanically, which is what SRS
 * §5.2.3 requires of the rule.
 */
export * from './approval.contract';
export * from './approval.errors';
export * from './audit';
/**
 * SIGNUP-1 — thin re-export of the existing Audit permission catalog, mirroring
 * Kitchen's `KDS_PERMISSIONS` re-export pattern: a pass-through of an existing
 * constant, not new permission surface. Consumed by Identity's production-safe
 * permission-catalog aggregator (`identity/authz/permission-catalog.ts`).
 */
export { AUDIT_PERMISSIONS, AUDIT_PERMISSION_DEFS } from '../audit/audit.permissions';
