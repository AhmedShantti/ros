import { BranchTable } from '../../../generated/prisma/client';

export interface BranchTableSummary {
  id: string;
  branchId: string;
  label: string;
  section: string | null;
  seatCapacity: number | null;
}

export function toBranchTableSummary(t: BranchTable): BranchTableSummary {
  return {
    id: t.id,
    branchId: t.branchId,
    label: t.label,
    section: t.section,
    seatCapacity: t.seatCapacity,
  };
}
