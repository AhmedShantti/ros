import { Prisma } from '../../../generated/prisma/client';

/**
 * Kitchen (KDS) PUBLIC contract — a branch/business-day-scoped ticket
 * summary for the Reporting Overview (RPT-DEMO-1).
 *
 * `kitchen.tickets` carries a real `business_day` column (unlike Workforce's
 * `AttendanceRecord` or Inventory's `waste_records`), so this query uses the
 * SAME business-day value the caller resolved for Sales/Cash — genuine
 * business-day alignment, not a calendar-day substitute.
 *
 * `averagePrepDurationSeconds` is computed ONLY from tickets whose
 * `startedAt` AND `bumpedAt` are BOTH persisted — `servedAt` is a schema
 * placeholder that no write path in this codebase ever populates, so a
 * "time to serve" metric is NEVER computed or implied here (RPT-DEMO-1 §2E
 * — "Never derive fake prep-time data"). `readyAt` and `bumpedAt` are set to
 * the identical instant by the only write path that sets either
 * (`kds-operations.service.ts`), so `bumpedAt - startedAt` and
 * `readyAt - startedAt` are the same measurement; this contract reads
 * `bumpedAt` since it is the one KDS operators actually act on (the bump).
 *
 * `tx`-FIRST — composed inside the Reporting overview's own RepeatableRead
 * transaction, sharing its MVCC snapshot.
 */
export const KDS_SUMMARY_QUERY = Symbol('KDS_SUMMARY_QUERY');

export interface KdsSummaryQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly businessDay: Date;
}

export interface KdsSummaryFacts {
  readonly ticketCount: number;
  /** Keyed by `TicketStatus` (`queued`/`in_progress`/`ready`/`bumped`/`served`/`recalled`); only statuses actually observed are present. */
  readonly statusCounts: Readonly<Record<string, number>>;
  /** Count of tickets with both `startedAt` and `bumpedAt` persisted — the population `averagePrepDurationSeconds` is computed over. */
  readonly measuredPrepDurationCount: number;
  /** `null` when `measuredPrepDurationCount === 0` — never a fabricated 0. */
  readonly averagePrepDurationSeconds: number | null;
}

export interface KdsSummaryQuery {
  forBranch(
    tx: Prisma.TransactionClient,
    input: KdsSummaryQueryInput,
  ): Promise<KdsSummaryFacts>;
}
