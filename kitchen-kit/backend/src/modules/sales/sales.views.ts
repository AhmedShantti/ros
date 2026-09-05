import {
  Discount,
  Order,
  OrderLine,
  OrderPayment,
  PostFireVoidRecord,
  Refund,
} from '../../generated/prisma/client';

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

/**
 * P1F-1 §22 — FR-POS-061's running balance, DERIVED, never stored. No
 * `remaining_balance` column exists; this is the only place the
 * subtraction happens, and the result carries no independent state to
 * drift out of sync with `paid_total`/`grand_total`.
 */
export function orderRemainingBalance(
  order: Pick<Order, 'grandTotal' | 'paidTotal'>,
): bigint {
  return order.grandTotal - order.paidTotal;
}

/**
 * P1F-1 — a captured Payment. BigInt money as a STRING of minor units, same
 * discipline as `toOrderView`/`toOrderLineView` (ADR-008, BR-FIN-005).
 * FR-POS-066: only the permitted card metadata is present here because it
 * is the only card metadata the row can hold at all.
 */
export function toPaymentView(payment: OrderPayment) {
  return {
    id: payment.id,
    orderId: payment.orderId,
    businessDay: payment.businessDay.toISOString().slice(0, 10),
    tender: payment.tender,
    currency: payment.currency,
    amount: payment.amount.toString(),
    roundingAdjustment: payment.roundingAdjustment.toString(),
    cashSessionId: payment.cashSessionId,
    employeeId: payment.employeeId,
    terminalId: payment.terminalId,
    tenderedAmount:
      payment.tenderedAmount === null
        ? null
        : payment.tenderedAmount.toString(),
    changeGiven:
      payment.changeGiven === null ? null : payment.changeGiven.toString(),
    paymentTerminalTxnRef: payment.paymentTerminalTxnRef,
    cardScheme: payment.cardScheme,
    cardLast4: payment.cardLast4,
    authorizationCode: payment.authorizationCode,
    processedAt: payment.processedAt,
    createdAt: payment.createdAt,
  };
}

/** POS-FIN-1 — FR-POS-049's seven facts, verbatim. */
export function toDiscountView(discount: Discount) {
  return {
    id: discount.id,
    orderId: discount.orderId,
    businessDay: discount.businessDay.toISOString().slice(0, 10),
    orderLineId: discount.orderLineId,
    kind: discount.kind,
    valueType: discount.valueType,
    percentageValueBp: discount.percentageValueBp?.toString() ?? null,
    fixedValueMinor: discount.fixedValueMinor?.toString() ?? null,
    amountMinor: discount.amountMinor.toString(),
    reasonCodeId: discount.reasonCodeId,
    appliedByEmployeeId: discount.appliedByEmployeeId,
    appliedByUserId: discount.appliedByUserId,
    approvalRequired: discount.approvalRequired,
    approvedByEmployeeId: discount.approvedByEmployeeId,
    approvedByUserId: discount.approvedByUserId,
    approvalRequestId: discount.approvalRequestId,
    orderVersionAfter: discount.orderVersionAfter,
    createdAt: discount.createdAt,
  };
}

/** POS-FIN-1 — FR-POS-075's facts for a post-fire void's disposition. */
export function toPostFireVoidRecordView(record: PostFireVoidRecord) {
  return {
    id: record.id,
    orderId: record.orderId,
    businessDay: record.businessDay.toISOString().slice(0, 10),
    orderLineId: record.orderLineId,
    disposition: record.disposition,
    reasonCodeId: record.reasonCodeId,
    financialAmountRemoved: record.financialAmountRemoved.toString(),
    inventoryMovementIds: record.inventoryMovementIds,
    actorUserId: record.actorUserId,
    createdAt: record.createdAt,
  };
}

/** POS-FIN-1 — the append-only compensating financial record (CR-04). */
export function toRefundView(refund: Refund) {
  return {
    id: refund.id,
    orderId: refund.orderId,
    businessDay: refund.businessDay.toISOString().slice(0, 10),
    refundBusinessDay: refund.refundBusinessDay.toISOString().slice(0, 10),
    originalPaymentId: refund.originalPaymentId,
    tender: refund.tender,
    amountMinor: refund.amountMinor.toString(),
    cashSessionId: refund.cashSessionId,
    reasonCodeId: refund.reasonCodeId,
    appliedByEmployeeId: refund.appliedByEmployeeId,
    appliedByUserId: refund.appliedByUserId,
    approvalRequired: refund.approvalRequired,
    approvedByEmployeeId: refund.approvedByEmployeeId,
    approvedByUserId: refund.approvedByUserId,
    approvalRequestId: refund.approvalRequestId,
    createdAt: refund.createdAt,
  };
}
