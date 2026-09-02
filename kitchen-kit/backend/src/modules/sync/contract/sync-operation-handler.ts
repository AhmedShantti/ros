import { Prisma } from '../../../generated/prisma/client';
import {
  SyncOperationStatus,
  SyncReasonCode,
} from '../protocol/protocol.constants';

/**
 * Sync PUBLIC contract — the operation-handler seam (SRS §5.4).
 *
 * D4-1A ships the protocol kernel, NOT the domains. A domain that wants its
 * offline operations applied registers a handler through this contract; the
 * kernel owns everything around it — envelope validation, HLC, causal order,
 * dedup, history, chunking, savepoints, results, acknowledgement — and calls
 * `apply` exactly once per operation, inside a transaction it controls.
 *
 * ── THE ATOMICITY RULE THIS INTERFACE EXISTS TO ENFORCE ────────────────────
 * `apply` receives the kernel's OWN `Prisma.TransactionClient`. Everything the
 * handler writes through `tx` commits, or rolls back, together with the
 * operation's authoritative dedup row — there is no window between the two, so
 * neither forbidden state of the ratified atomicity invariant is reachable:
 *
 *   business effect committed + dedup missing   -> retry applies it twice
 *   dedup present + business effect missing     -> client told `accepted` falsely
 *
 * A handler that opens its own transaction, spawns work, or writes through any
 * client other than `tx` breaks that guarantee. The safe path is the easy path
 * precisely because `tx` is the only handle offered.
 *
 * ── WHAT A HANDLER MUST NOT DO ────────────────────────────────────────────
 * Do not catch-and-swallow: THROW to reject an operation. The kernel rolls the
 * operation back to its savepoint, records a definitive `rejected` result, and
 * carries on with the rest of the batch — `FR-OFF-023`'s "a single failing
 * operation SHALL NOT fail the batch" is the kernel's job, not the handler's.
 */
export interface SyncOperationContext {
  /** The kernel's transaction. The ONLY legitimate write handle. */
  readonly tx: Prisma.TransactionClient;
  readonly tenantId: string;
  /** Server-derived from the authenticated terminal — never client-supplied. */
  readonly terminalId: string;
  /** Server-derived from the terminal's live branch — never client-supplied. */
  readonly branchId: string;
  readonly opId: string;
  readonly entityId: string;
  /** Asserted by the terminal, not authenticated by the server. See §17.4. */
  readonly actorEmployeeId: string | null;
  readonly causedBy: string | null;
  /** The client's HLC, verbatim. */
  readonly hlc: string;
  /** The device's own wall clock at the time of the operation. */
  readonly occurredAt: Date;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

/** What a handler may return. Omitting it means `accepted` with no detail. */
export interface SyncOperationOutcome {
  readonly status?: Extract<SyncOperationStatus, 'accepted' | 'conflict'>;
  /** A known code, or any other string a handler needs — see call sites in
   * `revalidation-exception.service.ts`/`device-state.service.ts`. `string &
   * {}` keeps `SyncReasonCode`'s literal autocomplete instead of collapsing
   * the union to bare `string`. */
  readonly reasonCode?: SyncReasonCode | (string & {});
  readonly reasonDetail?: string;
  /** Echoed back to the client inside the per-operation result. */
  readonly detail?: Record<string, unknown>;
  /** Set when the handler recorded a `sync.conflict_records` row. */
  readonly conflictId?: string;
}

export interface SyncOperationHandler {
  /** `<aggregate>.<operation>`, e.g. `order.create`. */
  readonly operationType: string;
  /**
   * Payload schema versions this handler understands. A version ABOVE the
   * highest supported one is `rejected/schema_version_unsupported` — never
   * silently coerced, because silently dropping a field of a financial payload
   * is exactly the loss `NFR-REL-010` forbids.
   */
  readonly supportedSchemaVersions: readonly number[];
  apply(context: SyncOperationContext): Promise<SyncOperationOutcome | void>;
}

/** DI token for the handler multi-provider set. */
export const SYNC_OPERATION_HANDLERS = Symbol('SYNC_OPERATION_HANDLERS');
