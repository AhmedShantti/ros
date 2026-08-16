import { CentralKitchen } from '../../../generated/prisma/client';

export interface CentralKitchenSummary {
  id: string;
  name: string;
  warehouseId: string;
}

export function toCentralKitchenSummary(
  ck: CentralKitchen,
): CentralKitchenSummary {
  return { id: ck.id, name: ck.name, warehouseId: ck.warehouseId };
}
