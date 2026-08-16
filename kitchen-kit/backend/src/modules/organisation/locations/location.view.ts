import { Location, LocationType } from '../../../generated/prisma/client';

export interface LocationSummary {
  id: string;
  locationType: LocationType;
  /** The concrete org entity this registry row points at. */
  refId: string;
  createdAt: Date;
}

/** tenantId is never exposed: it is server-derived, never client data. */
export function toLocationSummary(l: Location): LocationSummary {
  return {
    id: l.id,
    locationType: l.locationType,
    refId: l.refId,
    createdAt: l.createdAt,
  };
}
