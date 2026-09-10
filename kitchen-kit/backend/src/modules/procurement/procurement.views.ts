import type {
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
