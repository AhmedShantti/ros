import { PrintRouting } from '../../../generated/prisma/client';

export interface PrintRoutingSummary {
  id: string;
  branchId: string;
  documentType: string;
  printerTarget: string;
  stationId: string | null;
}

export function toPrintRoutingSummary(p: PrintRouting): PrintRoutingSummary {
  return {
    id: p.id,
    branchId: p.branchId,
    documentType: p.documentType,
    printerTarget: p.printerTarget,
    stationId: p.stationId,
  };
}
