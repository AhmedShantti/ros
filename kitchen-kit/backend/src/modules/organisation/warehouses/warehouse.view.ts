import { Warehouse, WarehouseType } from '../../../generated/prisma/client';

export interface WarehouseSummary {
  id: string;
  name: string;
  warehouseType: WarehouseType;
  branchId: string | null;
  createdAt: Date;
}

export function toWarehouseSummary(w: Warehouse): WarehouseSummary {
  return {
    id: w.id,
    name: w.name,
    warehouseType: w.warehouseType,
    branchId: w.branchId,
    createdAt: w.createdAt,
  };
}
