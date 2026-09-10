import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — FULL-SRS-PRC-PURCHASE-ORDERS-P2 §5.
 *
 * `org.locations` is ALREADY the unified branch/warehouse/central-kitchen
 * registry `BRANCH_LOCATIONS_QUERY` keys Inventory lookups by (see that
 * file's own doc comment). No prior Organisation contract answered "does
 * this location id exist in this tenant, and what kind is it" for an
 * arbitrary location id (only "list a branch's own locations" existed) —
 * this is the narrow, additive query a Purchase Order's delivery-location
 * validation needs, and exactly what a future Goods Receipt slice can reuse
 * without guessing (mission brief §5/§15).
 *
 * `tx`-FIRST, `null`-on-invisible (wrong tenant or nonexistent, indistinguishable
 * — the caller's own 404), matching every other Organisation contract query.
 */
export const LOCATION_FACTS_QUERY = Symbol('LOCATION_FACTS_QUERY');

export interface LocationFacts {
  readonly id: string;
  readonly locationType: 'branch' | 'warehouse' | 'central_kitchen';
  /** The branch/warehouse/central-kitchen id this location row denotes. */
  readonly refId: string;
}

export interface LocationFactsQueryInput {
  readonly tenantId: string;
  readonly locationId: string;
}

export interface LocationFactsQuery {
  find(
    tx: Prisma.TransactionClient,
    input: LocationFactsQueryInput,
  ): Promise<LocationFacts | null>;
}
