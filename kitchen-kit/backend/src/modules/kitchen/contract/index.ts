/**
 * Kitchen Ops PUBLIC contract barrel — SRS §5.4.
 */
export * from './events';
export * from './scope-target.resolvers';
export * from './kds-summary.query';
/**
 * D4-1B ACCEPTANCE CORRECTION — the offline-safe domain-operation seam Sync's
 * integration adapter consumes (see `offline-ticket-operations.ts`'s own
 * docblock for the module-boundary correction this exists to make).
 */
export * from './offline-ticket-operations';
/**
 * Thin re-export of the ONE permission code Kitchen's offline adapter (in
 * `modules/sync/integration/`) needs to authorize against, mirroring
 * `governance/contract/audit.ts` and `sync/contract`'s own `SYNC_REASON`
 * re-export pattern — a THIN pass-through of an existing constant, not new
 * permission surface.
 */
export { KDS_PERMISSIONS } from '../kitchen.permissions';
