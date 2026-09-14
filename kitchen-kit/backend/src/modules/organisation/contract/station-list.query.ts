import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — KDS-STATION-DISCOVERY-AUTH-FIX-P0.
 *
 * The minimal "which stations exist at my branch" picker read a KDS session
 * needs before it can select one to view a queue for. Deliberately NOT
 * `StationSummary` (`stations/station.view.ts`) — that carries
 * `capacityConfig`/`displayTerminalId`, management/config fields with no
 * business on a KDS operator's picker, which is read-only and carries no
 * `BRANCH_READ` grant. Kitchen must reach `org.stations` only through this
 * contract, never `tx.station` directly — the same split `RoutingConfigQuery`
 * and `KdsBranchConfigQuery` already establish for the tables they own.
 */
export const STATION_LIST_QUERY = Symbol('STATION_LIST_QUERY');

export interface StationListItem {
  readonly id: string;
  readonly name: string;
  readonly displayColour: string | null;
}

export interface StationListQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface StationListQuery {
  listForBranch(
    tx: Prisma.TransactionClient,
    input: StationListQueryInput,
  ): Promise<readonly StationListItem[]>;
}
