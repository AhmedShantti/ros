import { Prisma, TicketStatus } from '../../../generated/prisma/client';

/**
 * Kitchen Ops PUBLIC contract — the OFFLINE-SAFE domain-operation seam.
 *
 * ── D4-1B ACCEPTANCE CORRECTION — MODULE BOUNDARY DIRECTION ────────────────
 * The first D4-1B implementation put a `kds.ticket.bump_line`
 * `@SyncOperationHandlerFor` PROVIDER inside `modules/kitchen`, reimplementing
 * the bump-line CAS/legal-transition logic a second time against
 * `SyncOperationContext.tx` (never reusing `KdsOperationsService.bumpLine`,
 * which opens its own `UnitOfWork` transaction a sync handler must never
 * nest inside another). That made Kitchen — a DOMAIN module — depend on
 * Sync's registration mechanism and authorization port
 * (`SyncOperationHandlerFor`, `SyncOperationContext`, `SYNC_AUTHORIZATION_PORT`,
 * `SYNC_REASON`) to do so, which is backwards: a protocol/integration concern
 * should depend on a published domain contract, not the other way round.
 *
 * The correction: Kitchen publishes ONLY this — a transaction-scoped domain
 * operation with NO Sync vocabulary in it at all (no operation envelope, no
 * reason codes, no handler decorator). The Sync-side adapter
 * (`modules/sync/integration/kds-ticket-bump-line.sync-handler.ts`) is the
 * ONLY place that imports both this contract and Sync's own contract, and it
 * contains no ticket/line business rule of its own — it only maps a sync
 * envelope to this call and this call's result back to a sync outcome.
 *
 * `bumpLine` accepts a plain, externally-supplied `Prisma.TransactionClient`
 * and NEVER opens a transaction/`UnitOfWork` of its own — the caller (online
 * `KdsOperationsService`, in a future refactor, OR the offline Sync adapter
 * today) owns the transaction boundary. This is the same "no nested
 * UnitOfWork" invariant the first implementation's docblocks already
 * identified; it is now enforced by the SHAPE of the contract (the method
 * takes `tx` as a parameter) rather than by a comment asking a reimplementation
 * to remember it.
 */
export interface OfflineBumpLineInput {
  readonly tenantId: string;
  readonly ticketId: string;
  readonly lineId: string;
  /** Asserted actor — never authenticated here; the caller authorizes BEFORE calling this. */
  readonly actorEmployeeId: string | null;
  readonly terminalId: string;
  readonly occurredAt: Date;
  /** Correlation id recorded on the audit entry only — never interpreted as domain data. */
  readonly correlationId: string;
}

export type OfflineBumpLineResult =
  | { readonly kind: 'ticket_not_found' }
  | { readonly kind: 'line_not_found' }
  | { readonly kind: 'line_cancelled' }
  | {
      readonly kind: 'applied';
      readonly ticketStatus: TicketStatus;
      readonly lineStatus: 'bumped';
    };

export interface KdsOfflineTicketOperations {
  /**
   * Resolve a ticket's CURRENT, server-authoritative branch — for a caller
   * that must authorize a target-scoped permission BEFORE mutating anything
   * (P-D4-01 revalidation rule: current server state wins over any
   * capture-time assumption). `null` when the ticket does not exist in this
   * tenant — the caller decides how to report that; this method never throws
   * for a missing ticket.
   */
  findTicketBranch(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketId: string,
  ): Promise<{ readonly branchId: string } | null>;

  /**
   * Apply a bump-line mutation against the SUPPLIED `tx`. Mirrors
   * `KdsOperationsService.bumpLine`'s CAS / legal-transition / no-op rules
   * exactly, and writes the SAME `TICKET_LINE_BUMPED` audit entry atomically
   * with the mutation, inside `tx`. Performs NO authorization check of its
   * own — the caller is responsible for authorizing against the branch
   * `findTicketBranch` returned before calling this.
   */
  bumpLine(
    tx: Prisma.TransactionClient,
    input: OfflineBumpLineInput,
  ): Promise<OfflineBumpLineResult>;
}

export const KDS_OFFLINE_TICKET_OPERATIONS = Symbol(
  'KDS_OFFLINE_TICKET_OPERATIONS',
);
