import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  StationDisplayBinding,
  StationDisplayBindingQuery,
} from '../contract/station-display-binding.query';

/**
 * PRIVATE Organisation implementation of `StationDisplayBindingQuery`. Bound
 * to `STATION_DISPLAY_BINDING_QUERY` inside `OrganisationModule` only.
 *
 * No explicit `tenantId` filter: `org.stations` carries no `tenant_id` column
 * at all (tenant scope is inherited through its branch, ADR 0008 D-08) and is
 * RLS-protected via a branch-traversal predicate — the caller's own
 * `withAuthContext` tenant context already makes a foreign-tenant station
 * invisible, exactly as `StationsService`'s own queries rely on.
 */
@Injectable()
export class StationDisplayBindingQueryService implements StationDisplayBindingQuery {
  async stationsForTerminal(
    tx: Prisma.TransactionClient,
    terminalId: string,
  ): Promise<readonly StationDisplayBinding[]> {
    const stations = await tx.station.findMany({
      where: { displayTerminalId: terminalId },
      select: { id: true, branchId: true },
    });
    return stations.map((s) => ({ stationId: s.id, branchId: s.branchId }));
  }
}
