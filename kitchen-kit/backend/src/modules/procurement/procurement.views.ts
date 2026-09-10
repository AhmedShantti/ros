import type {
  PurchaseOrder,
  PurchaseOrderAmendment,
  PurchaseOrderLine,
  PurchaseRequisition,
  PurchaseRequisitionLine,
  Supplier,
  SupplierItemLink,
  SupplierPriceEntry,
} from '../../generated/prisma/client';

/** BigInt/Decimal fields never survive `JSON.stringify` — every response
 *  crosses through one of these view functions, never a raw Prisma row. */
export function toSupplierView(s: Supplier) {
  return {
    id: s.id,
    code: s.code,
    legalName: s.legalName,
    tradingName: s.tradingName,
    taxRegistrationNumber: s.taxRegistrationNumber,
    addresses: s.addresses,
    contacts: s.contacts,
    paymentTermsNetDays: s.paymentTermsNetDays,
    currency: s.currency,
    deliveryLeadTimeDays: s.deliveryLeadTimeDays,
    minimumOrderValue: s.minimumOrderValue.toString(),
    deliveryDays: s.deliveryDays,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function toSourcingLinkView(l: SupplierItemLink) {
  return {
    id: l.id,
    supplierId: l.supplierId,
    stockItemId: l.stockItemId,
    supplierItemCode: l.supplierItemCode,
    supplierBarcodes: l.supplierBarcodes,
    preferenceRank: l.preferenceRank,
    isActive: l.isActive,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

export function toPriceEntryView(e: SupplierPriceEntry) {
  return {
    id: e.id,
    supplierId: e.supplierId,
    supplierItemLinkId: e.supplierItemLinkId,
    purchaseUnitId: e.purchaseUnitId,
    packSize: e.packSize.toString(),
    unitPrice: e.unitPrice.toString(),
    currency: e.currency,
    validFrom: e.validFrom,
    validUntil: e.validUntil,
    volumeTiers: e.volumeTiers,
    createdAt: e.createdAt,
  };
}

// ── FULL-SRS-PRC-PURCHASE-ORDERS-P2 ────────────────────────────────────────

export function toRequisitionLineView(l: PurchaseRequisitionLine) {
  return {
    id: l.id,
    requisitionId: l.requisitionId,
    stockItemId: l.stockItemId,
    quantity: l.quantity.toString(),
    purchaseUnitId: l.purchaseUnitId,
    preferredSupplierId: l.preferredSupplierId,
    notes: l.notes,
    createdAt: l.createdAt,
  };
}

export function toRequisitionView(
  r: PurchaseRequisition & { lines?: PurchaseRequisitionLine[] },
) {
  return {
    id: r.id,
    requestingBranchId: r.requestingBranchId,
    requestedBy: r.requestedBy,
    status: r.status,
    notes: r.notes,
    createdAt: r.createdAt,
    submittedAt: r.submittedAt,
    lines: r.lines?.map(toRequisitionLineView) ?? [],
  };
}

export function toPurchaseOrderLineView(l: PurchaseOrderLine) {
  return {
    id: l.id,
    purchaseOrderId: l.purchaseOrderId,
    stockItemId: l.stockItemId,
    purchaseUnitId: l.purchaseUnitId,
    quantity: l.quantity.toString(),
    unitPrice: l.unitPrice.toString(),
    netAmount: l.netAmount.toString(),
    taxAmount: l.taxAmount.toString(),
    lineTotal: l.lineTotal.toString(),
    supplierPriceEntryId: l.supplierPriceEntryId,
    sourceRequisitionLineId: l.sourceRequisitionLineId,
    attributionBranchId: l.attributionBranchId,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

export function toPurchaseOrderView(
  po: PurchaseOrder & { lines?: PurchaseOrderLine[] },
) {
  return {
    id: po.id,
    supplierId: po.supplierId,
    deliveryLocationType: po.deliveryLocationType,
    deliveryLocationId: po.deliveryLocationId,
    expectedDeliveryDate: po.expectedDeliveryDate,
    currency: po.currency,
    status: po.status,
    requestedBy: po.requestedBy,
    subtotal: po.subtotal.toString(),
    taxTotal: po.taxTotal.toString(),
    grandTotal: po.grandTotal.toString(),
    approvalBand: po.approvalBand,
    approvalRequiredPermission: po.approvalRequiredPermission,
    approvalThresholdsSnapshot: po.approvalThresholdsSnapshot,
    evaluatedTotalAtSubmission:
      po.evaluatedTotalAtSubmission?.toString() ?? null,
    approvalRequestId: po.approvalRequestId,
    approvedBand: po.approvedBand,
    approvedAt: po.approvedAt,
    approvedBy: po.approvedBy,
    rejectedAt: po.rejectedAt,
    rejectedBy: po.rejectedBy,
    receivingStartedAt: po.receivingStartedAt,
    version: po.version,
    createdAt: po.createdAt,
    updatedAt: po.updatedAt,
    lines: po.lines?.map(toPurchaseOrderLineView) ?? [],
  };
}

export function toPurchaseOrderAmendmentView(a: PurchaseOrderAmendment) {
  return {
    id: a.id,
    purchaseOrderId: a.purchaseOrderId,
    amendmentNumber: a.amendmentNumber,
    changedBy: a.changedBy,
    changedAt: a.changedAt,
    reason: a.reason,
    beforeSnapshot: a.beforeSnapshot,
    afterSnapshot: a.afterSnapshot,
    oldTotal: a.oldTotal.toString(),
    newTotal: a.newTotal.toString(),
    oldApprovalBand: a.oldApprovalBand,
    newApprovalBand: a.newApprovalBand,
  };
}
