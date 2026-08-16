import { OperatingHours } from '../../../generated/prisma/client';
import { formatTimeOfDay } from './time-of-day';

export interface OperatingHoursSummary {
  id: string;
  branchId: string;
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  businessDayCutover: string;
  /** True when the interval crosses midnight (SRS glossary, "Business Day"). */
  overnight: boolean;
}

export function toOperatingHoursSummary(
  h: OperatingHours,
): OperatingHoursSummary {
  const opensAt = formatTimeOfDay(h.opensAt);
  const closesAt = formatTimeOfDay(h.closesAt);
  return {
    id: h.id,
    branchId: h.branchId,
    dayOfWeek: h.dayOfWeek,
    opensAt,
    closesAt,
    businessDayCutover: formatTimeOfDay(h.businessDayCutover),
    overnight: closesAt <= opensAt,
  };
}
