import { Order, OrderLine } from '../../generated/prisma/client';

/**
 * Sales read models.
 *
 * BigInt money is serialised as a STRING of minor units. A JSON number would be
 * IEEE-754 and would corrupt a large total silently, which ADR-008 forbids —
 * and the client is the Dart POS, which must read the same exact integer the
 * server wrote (BR-FIN-005).
 *
 * Every value is a PERSISTED SNAPSHOT read straight off the row. Nothing is
 * recomputed from live master data, which is the whole point of BR-POS-004.
 */
export function toOrderView(order: Order & { lines?: OrderLine[] }) {
  return {
    id: order.id,
    branchId: order.branchId,
    terminalId: order.terminalId,
    orderNumber: order.orderNumber,
    businessDay: order.businessDay.toISOString().slice(0, 10),
    orderType: order.orderType,
    channel: order.channel,
    state: order.state,
    tableId: order.tableId,
    guestCount: order.guestCount,
    openedBy: order.openedBy,
    servedBy: order.servedBy,
    closedBy: order.closedBy,
    currency: order.currency,
    subtotal: order.subtotal.toString(),
    discountTotal: order.discountTotal.toString(),
    serviceChargeTotal: order.serviceChargeTotal.toString(),
    taxTotal: order.taxTotal.toString(),
    roundingAdjustment: order.roundingAdjustment.toString(),
    grandTotal: order.grandTotal.toString(),
    paidTotal: order.paidTotal.toString(),
    tipTotal: order.tipTotal.toString(),
    openedAt: order.openedAt,
    firstFiredAt: order.firstFiredAt,
    completedAt: order.completedAt,
    originDeviceTime: order.originDeviceTime,
    /** FR-LOC-021 — the pack version this order was priced under, pinned. */
    countryPackVersion: order.countryPackVersion,
    notes: order.notes,
    /** §24.6.4 optimistic concurrency; also the ETag validator. */
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...(order.lines ? { lines: order.lines.map(toOrderLineView) } : {}),
  };
}

export function toOrderLineView(line: OrderLine) {
  return {
    id: line.id,
    sequence: line.sequence,
    menuItemId: line.menuItemId,
    variantId: line.variantId,
    itemNameSnapshot: line.itemNameSnapshot,
    quantity: line.quantity.toString(),
    unitPrice: line.unitPrice.toString(),
    modifierTotal: line.modifierTotal.toString(),
    lineDiscount: line.lineDiscount.toString(),
    lineSubtotal: line.lineSubtotal.toString(),
    taxClassId: line.taxClassId,
    taxAmount: line.taxAmount.toString(),
    lineTotal: line.lineTotal.toString(),
    unitCostSnapshot:
      line.unitCostSnapshot === null ? null : line.unitCostSnapshot.toString(),
    recipeVersionId: line.recipeVersionId,
    priceListId: line.priceListId,
    priceEntryId: line.priceEntryId,
    priceRule: line.priceRule,
    course: line.course,
    seatNumber: line.seatNumber,
    state: line.state,
    firedAt: line.firedAt,
    readyAt: line.readyAt,
    isComp: line.isComp,
    notes: line.notes,
    createdAt: line.createdAt,
  };
}

/**
 * §26 "If-Match with ETag on updates" — the validator for an order.
 *
 * Derived from the row's optimistic-concurrency version, so the ETag and the
 * version assertion can never disagree. Weak validation is correct here: the
 * representation may differ byte-for-byte between requests (timestamps render
 * identically, but a future field may not) while still being the same revision.
 */
export function orderETag(order: Pick<Order, 'id' | 'version'>): string {
  return `W/"${order.id}.${order.version}"`;
}
