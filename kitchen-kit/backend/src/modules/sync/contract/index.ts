/**
 * Sync PUBLIC contract barrel — SRS §5.4.
 *
 * Other modules import `modules/sync/contract` and nothing else;
 * `module-boundaries.spec.ts` enforces that mechanically.
 */
export * from './sync-operation-handler';
export * from './sync-authorization.port';
/**
 * D4-1B — publishing the handler-registration decorator itself.
 *
 * D4-1A's own docblock on `SyncOperationHandlerFor` (`operations/sync-
 * operation-handler.decorator.ts`) says a domain "adds offline support by
 * adding a provider" in its OWN module — but the decorator lived OUTSIDE
 * `contract/`, so no domain module could actually reach it without a private
 * `modules/sync/operations/...` import (`module-boundaries.spec.ts` forbids
 * exactly that). This is a THIN re-export, same pattern as Identity's
 * `contract/http.ts` and Governance's `contract/audit.ts` — the decorator's
 * own implementation (`DiscoveryService.createDecorator`) is a one-line
 * NestJS primitive with no persistence behaviour of its own.
 */
export * from '../operations/sync-operation-handler.decorator';
/**
 * D4-1B — the reason-code vocabulary a handler needs to construct a precise
 * `SyncOperationRejectedError`/`conflict` outcome. Only `SYNC_REASON` (and its
 * type) is re-exported here, not the rest of `protocol.constants.ts` (batch
 * limits, chunk size, the finality-status enum) — those are kernel-internal
 * tuning values a domain handler has no legitimate reason to read.
 */
export { SYNC_REASON } from '../protocol/protocol.constants';
export type { SyncReasonCode } from '../protocol/protocol.constants';
/**
 * D4-1B — `FR-OFF-043` conflict register writer. A handler returning a
 * `conflict` outcome for a REAL domain conflict (not a bare rejection) calls
 * this directly, in the SAME transaction as its own read/write, rather than
 * the kernel inferring a conflict record from the outcome alone — only the
 * handler knows the domain-specific `conflictClass`, and both the local
 * (offline-assumed) and server (current) states worth recording.
 */
export { ConflictRecordService } from '../conflict/conflict-record.service';
export type { RecordConflictInput } from '../conflict/conflict-record.service';
