import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — resolves the `org.locations` row(s) that
 * belong to one branch (Operational Analytics / Reporting Demo Pack,
 * RPT-DEMO-1).
 *
 * A branch's own storage location is exactly the ONE `org.locations` row
 * with `locationType = 'branch'` and `branchId` equal to it —
 * `ck_location_target` (branch/warehouse/central-kitchen XOR) and
 * `@@unique([tenantId, locationType, refId])` together guarantee this is
 * unique and that `branchId` is set on no other kind of location row. This
 * deliberately answers "what inventory is physically stored at this
 * branch", not a supply-chain question — a standalone warehouse or a
 * central kitchen is never branch-scoped stock, even if this branch draws
 * from it.
 *
 * `tx`-FIRST: the Reporting overview composes this inside its own
 * RepeatableRead transaction, sharing that snapshot — the SAME convention
 * `DAILY_TRADING_SALES_QUERY`/`DAILY_CASH_RECONCILIATION_QUERY` already use.
 * The CALLER resolves `locationIds` and passes them into Inventory's own
 * contract query; Inventory never reaches into `org.locations` itself. This
 * keeps composition at the orchestrating (Reporting) layer, exactly as
 * `DailyTradingReportService` already composes Sales + Treasury facts rather
 * than having either module query the other's tables.
 */
export const BRANCH_LOCATIONS_QUERY = Symbol('BRANCH_LOCATIONS_QUERY');

export interface BranchLocationsQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface BranchLocationsQuery {
  listLocationIds(
    tx: Prisma.TransactionClient,
    input: BranchLocationsQueryInput,
  ): Promise<readonly string[]>;
}
