import {
  Order,
  OrderLine,
  OrderLineModifier,
  OrderPayment,
} from '../../generated/prisma/client';

/**
 * INTERNAL-MVP RECEIPT — pure read-side projection. RCPT-R1
 * (`docs/governance/GOVERNANCE_DECISION_REGISTER.md`).
 *
 * Every value here is read straight off ALREADY-PERSISTED, ALREADY-FROZEN
 * rows — never recomputed, never re-resolved against current Catalogue,
 * Localisation, Organisation or Production master data. That is the whole
 * historical-stability property the accepted design gate proves
 * (`docs/reports/claude/2026-09-01_INTERNAL-MVP-receipt-narrow-design-
 * gate.md` §H): `itemNameSnapshot`/`nameSnapshot` are BR-POS-004 sale-time
 * JSONB snapshots with no rewrite path, and every money/tax field is a
 * `BigInt` column written once at capture or settlement.
 *
 * BigInt money is serialised as a STRING of minor units — the same
 * discipline `sales.views.ts`'s `toOrderView`/`toPaymentView` already use
 * (ADR-008, BR-FIN-005): a JSON number would be IEEE-754 and could corrupt
 * a large total silently.
 */

export type TaxPresentation =
  'INCLUSIVE' | 'EXCLUSIVE' | 'NOT_APPLICABLE' | 'UNDETERMINED';

/**
 * FR-FIN-031 — tax-inclusive vs tax-exclusive pricing discriminator, derived
 * PURELY from the frozen order row. Deliberately does NOT consult the
 * pinned CountryPack: `requirePinned` needs `branch.countryCode`, which the
 * order does not store, and `branches.country_code` is mutable — resolving
 * it at read time would reintroduce exactly the historical-drift risk this
 * projection exists to avoid (design gate §J.2).
 *
 * `UNDETERMINED` is structurally unreachable under the current runtime
 * (Order.complete()'s own arithmetic guarantees one of the two equalities
 * holds whenever `taxTotal != 0`); it exists so a historically anomalous
 * row still yields an honest label instead of failing a read.
 */
export function deriveTaxPresentation(totals: {
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly grandTotal: bigint;
}): TaxPresentation {
  if (totals.taxTotal === 0n) return 'NOT_APPLICABLE';
  if (totals.grandTotal === totals.subtotal) return 'INCLUSIVE';
  if (totals.grandTotal === totals.subtotal + totals.taxTotal) {
    return 'EXCLUSIVE';
  }
  return 'UNDETERMINED';
}

export type ReceiptLine = OrderLine & { modifiers: OrderLineModifier[] };

/**
 * Assembles the receipt document from the three frozen inputs
 * `ReceiptService` reads. No arithmetic beyond `deriveTaxPresentation`'s
 * pure comparison — no pricing or tax recomputation.
 */
export function toReceiptView(
  order: Order,
  lines: readonly ReceiptLine[],
  payments: readonly OrderPayment[],
) {
  return {
    // ── non-fiscal discriminator (RCPT-R1) ─────────────────────────────
    documentType: 'INTERNAL_NON_FISCAL_RECEIPT' as const,
    fiscal: false as const,
    disclosureKey: 'receipt.internal.nonFiscal',

    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      businessDay: order.businessDay.toISOString().slice(0, 10),
      branchId: order.branchId,
      terminalId: order.terminalId,
      orderType: order.orderType,
      channel: order.channel,
      /**
       * `'completed'`, or `'partially_refunded'`/`'refunded'` (POS-FIN-1) —
       * `ReceiptService` refuses every other state. The frozen line/total
       * facts below are the ORIGINAL sale's, never rewritten by a later
       * refund (CR-04) — this field is the only signal a reader has that a
       * refund exists at all; refund line-item detail is out of this
       * receipt's scope (no SRS/RCPT-R1 requirement names it).
       */
      state: order.state,
      completedAt: order.completedAt,
      currency: order.currency,
      /** FR-LOC-021 pin — provenance only, never re-resolved. */
      countryPackVersion: order.countryPackVersion,
    },

    lines: lines.map(toReceiptLineView),

    totals: {
      subtotal: order.subtotal.toString(),
      discountTotal: order.discountTotal.toString(),
      serviceChargeTotal: order.serviceChargeTotal.toString(),
      taxTotal: order.taxTotal.toString(),
      grandTotal: order.grandTotal.toString(),
      paidTotal: order.paidTotal.toString(),
      tipTotal: order.tipTotal.toString(),
      /**
       * BR-FIN-004 — a SEPARATE cash-drawer-reconciliation figure. NEVER
       * part of `grandTotal` or `paidTotal` (see `OrderPayment`'s own doc
       * comment in `prisma/schema.prisma`). Named distinctly from the raw
       * `roundingAdjustment` column so its meaning is unmissable on a
       * document a person reads.
       */
      cashRoundingAdjustment: order.roundingAdjustment.toString(),
    },

    taxPresentation: deriveTaxPresentation({
      subtotal: order.subtotal,
      taxTotal: order.taxTotal,
      grandTotal: order.grandTotal,
    }),

    payments: payments.map(toReceiptPaymentView),
  };
}

function toReceiptLineView(line: ReceiptLine) {
  return {
    sequence: line.sequence,
    menuItemId: line.menuItemId,
    variantId: line.variantId,
    /** BR-POS-004 sale-time snapshot — never re-resolved from Catalogue. */
    itemNameSnapshot: line.itemNameSnapshot,
    quantity: line.quantity.toString(),
    unitPrice: line.unitPrice.toString(),
    modifiers: line.modifiers.map(toReceiptModifierView),
    modifierTotal: line.modifierTotal.toString(),
    /** Always `"0"` under the current runtime — discounts are not
     * implemented (`order-lines.service.ts`'s `recomputeOrderTotals`).
     * Reported verbatim, not invented. */
    lineDiscount: line.lineDiscount.toString(),
    lineSubtotal: line.lineSubtotal.toString(),
    taxClassId: line.taxClassId,
    taxAmount: line.taxAmount.toString(),
    lineTotal: line.lineTotal.toString(),
  };
}

function toReceiptModifierView(modifier: OrderLineModifier) {
  return {
    modifierId: modifier.modifierId,
    /** BR-POS-004 sale-time snapshot — never re-resolved from Catalogue. */
    nameSnapshot: modifier.nameSnapshot,
    quantity: modifier.quantity,
    priceDelta: modifier.priceDelta.toString(),
  };
}

/**
 * FR-POS-066 — exposes strictly less than the row can hold: no
 * `authorizationCode`, `paymentTerminalTxnRef`, `cashSessionId`,
 * `employeeId` or `terminalId`. No PAN/CVV/track field exists on the row at
 * all (design gate §I.4).
 */
function toReceiptPaymentView(payment: OrderPayment) {
  return {
    id: payment.id,
    tender: payment.tender,
    currency: payment.currency,
    amount: payment.amount.toString(),
    roundingAdjustment: payment.roundingAdjustment.toString(),
    tenderedAmount:
      payment.tenderedAmount === null
        ? null
        : payment.tenderedAmount.toString(),
    changeGiven:
      payment.changeGiven === null ? null : payment.changeGiven.toString(),
    cardScheme: payment.cardScheme,
    cardLast4: payment.cardLast4,
    processedAt: payment.processedAt,
  };
}

export type ReceiptView = ReturnType<typeof toReceiptView>;
