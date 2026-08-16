import { Station } from '../../../generated/prisma/client';

export interface StationSummary {
  id: string;
  branchId: string;
  name: string;
  capacityConfig: unknown;
  displayTerminalId: string | null;
  createdAt: Date;
}

export function toStationSummary(s: Station): StationSummary {
  return {
    id: s.id,
    branchId: s.branchId,
    name: s.name,
    capacityConfig: s.capacityConfig,
    displayTerminalId: s.displayTerminalId,
    createdAt: s.createdAt,
  };
}
