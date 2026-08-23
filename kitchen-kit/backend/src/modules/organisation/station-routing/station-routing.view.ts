import { StationRoutingRule } from '../../../generated/prisma/client';

export interface StationRoutingRuleSummary {
  id: string;
  branchId: string;
  stationId: string;
  menuItemId: string | null;
  categoryId: string | null;
  modifierId: string | null;
  priority: number;
}

export function toStationRoutingRuleSummary(
  r: StationRoutingRule,
): StationRoutingRuleSummary {
  return {
    id: r.id,
    branchId: r.branchId,
    stationId: r.stationId,
    menuItemId: r.menuItemId,
    categoryId: r.categoryId,
    modifierId: r.modifierId,
    priority: r.priority,
  };
}
