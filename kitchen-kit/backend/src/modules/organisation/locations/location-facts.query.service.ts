import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  LocationFacts,
  LocationFactsQuery,
  LocationFactsQueryInput,
} from '../contract/location-facts.query';

/**
 * PRIVATE Prisma-backed implementation of `LocationFactsQuery`
 * (`organisation/contract/location-facts.query.ts`). Bound to
 * `LOCATION_FACTS_QUERY` only inside `OrganisationModule` (`useExisting`) —
 * never imported directly by a consumer.
 *
 * `org.locations` carries a real `tenant_id` and is RLS-protected; the
 * caller's `Prisma.TransactionClient` is already inside a tenant-scoped
 * `withAuthContext` session, so a cross-tenant `locationId` resolves to
 * `null` via RLS, exactly as `BranchCurrencyQueryService` (its own
 * precedent) relies on.
 */
@Injectable()
export class LocationFactsQueryService implements LocationFactsQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: LocationFactsQueryInput,
  ): Promise<LocationFacts | null> {
    const row = await tx.location.findUnique({
      where: { id: input.locationId },
      select: { id: true, locationType: true, refId: true },
    });
    return row
      ? { id: row.id, locationType: row.locationType, refId: row.refId }
      : null;
  }
}
