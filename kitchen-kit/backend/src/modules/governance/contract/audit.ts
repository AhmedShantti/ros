/**
 * Governance PUBLIC contract — the audit writer.
 *
 * KDS operator-lifecycle acceptance correction (2026-08-31), Blocker A.
 * Every module needs `AuditService.record(tx, event)` inside its own
 * transaction (FR-AUD-001, every state-changing operation). Before this
 * correction every module reached it through a PRIVATE
 * `governance/audit/audit.service`/`audit.constants` path — recorded as a
 * pre-existing `<module>->governance` `KNOWN_DEVIATIONS` entry for
 * sales/catalogue/inventory/organisation/production/treasury alike.
 * `AuditService` is registered `@Global()` precisely because it is meant to
 * be consumed everywhere; this file makes that intent explicit as a
 * published contract rather than an ad hoc private import. THIN re-export
 * only — `AuditService`'s implementation, and its hash-chain/advisory-lock
 * behaviour, stay exactly where they are (`governance/audit/audit.service.ts`).
 *
 * Does not retroactively clean up any OTHER module's pre-existing
 * `<module>->governance` entry (out of scope) — it only means a module
 * importing exclusively from `governance/contract` adds none of its own.
 */
export { AuditService } from '../audit/audit.service';
export type { AuditEvent } from '../audit/audit.service';
export {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  SENTINEL_TENANT_ID,
} from '../audit/audit.constants';
export type { AuditActorType } from '../audit/audit.constants';
