import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — the dine-in Table display fact Sales needs
 * at Fire (FR-KDS-020 "table or customer reference") but does not own.
 *
 * `sales.orders.table_id` is a bare, FK-less UUID (Sales and Organisation are
 * different bounded contexts/schemas — the same pattern as
 * `identity.terminals.branch_id`); Sales has no human-readable table text of
 * its own. `org.tables.label` (`BranchTable.label`, unique per branch,
 * VARCHAR(16)) IS the unambiguous, source-backed, user-visible display
 * representation — this contract exposes exactly that field and nothing
 * else (`section`/`seatCapacity` stay private; Fire has no use for them and
 * the SRS names no requirement for them at Fire time).
 *
 * This file is INTERFACE + DTOs ONLY (SRS §5.4). The Prisma-backed
 * implementation lives at `organisation/tables/table-display.query.service.ts`
 * — a PRIVATE Organisation path — bound to `TABLE_DISPLAY_QUERY` only inside
 * `OrganisationModule`. A consumer (Sales) injects the token and depends on
 * the `TableDisplayQuery` interface below; it never imports the concrete
 * implementation or `tables/tables.service` (`module-boundaries.spec.ts`'s
 * contract-purity assertions, mirroring the P1E-3A `RoutingConfigQuery`
 * pattern).
 *
 * `find()` is transaction-aware: the CALLER's own `Prisma.TransactionClient`,
 * no second transaction — a lookup taken mid-Fire reads inside that same
 * atomic unit of work (SRS §5.5.1).
 *
 * Returns `null` when the table id does not resolve (unknown id, or — the
 * common non-dine-in case — no `tableId` at all; the caller simply does not
 * call `find()` when `tableId` is `null`). The caller (Sales) is the one that
 * decides `serviceReference = null` for non-dine-in orders; this contract
 * only ever answers "what does this specific table display as", never a
 * business decision about which order types get one.
 */
export const TABLE_DISPLAY_QUERY = Symbol('TABLE_DISPLAY_QUERY');

export interface TableDisplayQueryInput {
  readonly tenantId: string;
  readonly tableId: string;
}

export interface TableDisplayResult {
  readonly label: string;
}

export interface TableDisplayQuery {
  find(
    tx: Prisma.TransactionClient,
    input: TableDisplayQueryInput,
  ): Promise<TableDisplayResult | null>;
}
