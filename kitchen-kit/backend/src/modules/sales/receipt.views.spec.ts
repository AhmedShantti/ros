import {
  deriveTaxPresentation,
  toReceiptView,
  type ReceiptLine,
} from './receipt.views';
import { Prisma } from '../../generated/prisma/client';
import type { Order, OrderPayment } from '../../generated/prisma/client';

describe('deriveTaxPresentation', () => {
  it('NOT_APPLICABLE when taxTotal is zero', () => {
    expect(
      deriveTaxPresentation({
        subtotal: 1000n,
        taxTotal: 0n,
        grandTotal: 1000n,
      }),
    ).toBe('NOT_APPLICABLE');
  });

  it('INCLUSIVE when grandTotal equals subtotal (tax already folded in)', () => {
    expect(
      deriveTaxPresentation({
        subtotal: 1000n,
        taxTotal: 140n,
        grandTotal: 1000n,
      }),
    ).toBe('INCLUSIVE');
  });

  it('EXCLUSIVE when grandTotal equals subtotal + taxTotal', () => {
    expect(
      deriveTaxPresentation({
        subtotal: 1000n,
        taxTotal: 140n,
        grandTotal: 1140n,
      }),
    ).toBe('EXCLUSIVE');
  });

  it('UNDETERMINED when neither equality holds', () => {
    expect(
      deriveTaxPresentation({
        subtotal: 1000n,
        taxTotal: 140n,
        grandTotal: 1500n,
      }),
    ).toBe('UNDETERMINED');
  });

  it('NOT_APPLICABLE takes precedence even if grandTotal disagrees with subtotal', () => {
    // taxTotal=0 but grandTotal != subtotal is a structurally-impossible
    // combination under the current runtime; the function must still not
    // crash or misclassify — zero tax always reads NOT_APPLICABLE first.
    expect(
      deriveTaxPresentation({
        subtotal: 1000n,
        taxTotal: 0n,
        grandTotal: 999n,
      }),
    ).toBe('NOT_APPLICABLE');
  });
});

describe('toReceiptView', () => {
  const BIG = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2

  const baseOrder = (): Order => ({
    id: 'order-1',
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    terminalId: 'terminal-1',
    orderNumber: 'BR1-000001',
    businessDay: new Date('2026-09-01T00:00:00.000Z'),
    orderType: 'dine_in',
    channel: 'pos',
    state: 'completed',
    tableId: null,
    guestCount: null,
    openedBy: 'user-1',
    servedBy: null,
    closedBy: null,
    currency: 'AED',
    subtotal: BIG,
    discountTotal: 0n,
    serviceChargeTotal: 0n,
    taxTotal: 756n,
    roundingAdjustment: 25n,
    grandTotal: BIG + 756n,
    paidTotal: BIG + 756n,
    tipTotal: 0n,
    cogsTotal: null,
    openedAt: new Date('2026-09-01T18:00:00.000Z'),
    firstFiredAt: null,
    completedAt: new Date('2026-09-01T18:42:11.204Z'),
    originDeviceTime: new Date('2026-09-01T18:00:00.000Z'),
    idempotencyKey: 'k-1',
    aggregatorRef: null,
    countryPackVersion: '2026.1',
    notes: null,
    metadata: {},
    version: 3,
    createdAt: new Date('2026-09-01T18:00:00.000Z'),
    updatedAt: new Date('2026-09-01T18:42:11.204Z'),
  });

  const baseLine = (overrides: Partial<ReceiptLine> = {}): ReceiptLine => ({
    id: 'line-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    businessDay: new Date('2026-09-01T00:00:00.000Z'),
    sequence: 1,
    menuItemId: 'item-1',
    variantId: 'variant-1',
    itemNameSnapshot: {
      item: { en: 'Grilled Chicken' },
      variant: { en: 'Large' },
    },
    quantity: new Prisma.Decimal('2.000'),
    unitPrice: BIG,
    modifierTotal: 200n,
    lineDiscount: 0n,
    lineSubtotal: BIG,
    taxClassId: 'tax-class-1',
    taxAmount: 756n,
    lineTotal: BIG + 756n,
    unitCostSnapshot: 500n,
    recipeVersionId: 'recipe-version-1',
    postedCogsTotal: 500n,
    priceListId: 'price-list-1',
    priceEntryId: 'price-entry-1',
    priceRule: 'exact-match',
    course: null,
    seatNumber: null,
    state: 'served',
    firedAt: null,
    readyAt: null,
    voidReasonId: null,
    voidedBy: null,
    isComp: false,
    notes: null,
    createdAt: new Date('2026-09-01T18:00:00.000Z'),
    modifiers: [
      {
        id: 'mod-1',
        tenantId: 'tenant-1',
        orderLineId: 'line-1',
        businessDay: new Date('2026-09-01T00:00:00.000Z'),
        modifierId: 'modifier-1',
        modifierGroupId: 'group-1',
        nameSnapshot: { en: 'Extra Garlic Sauce' },
        kindSnapshot: 'addition',
        priceDelta: 200n,
        quantity: 1,
        createdAt: new Date('2026-09-01T18:00:00.000Z'),
      },
    ],
    ...overrides,
  });

  const basePayment = (
    overrides: Partial<OrderPayment> = {},
  ): OrderPayment => ({
    id: 'payment-1',
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    orderId: 'order-1',
    businessDay: new Date('2026-09-01T00:00:00.000Z'),
    tender: 'cash',
    currency: 'AED',
    amount: BIG + 756n,
    roundingAdjustment: 25n,
    cashSessionId: 'cash-session-1',
    employeeId: 'employee-1',
    terminalId: 'terminal-1',
    tenderedAmount: BIG + 800n,
    changeGiven: 44n - 25n,
    paymentTerminalTxnRef: null,
    cardScheme: null,
    cardLast4: null,
    authorizationCode: null,
    processedAt: new Date('2026-09-01T18:42:11.198Z'),
    createdAt: new Date('2026-09-01T18:42:11.198Z'),
    ...overrides,
  });

  it('emits every money field as a decimal string, never a JSON number', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);

    expect(typeof view.totals.subtotal).toBe('string');
    expect(typeof view.totals.grandTotal).toBe('string');
    expect(typeof view.totals.cashRoundingAdjustment).toBe('string');
    expect(typeof view.lines[0].unitPrice).toBe('string');
    expect(typeof view.lines[0].lineTotal).toBe('string');
    expect(typeof view.lines[0].modifiers[0].priceDelta).toBe('string');
    expect(typeof view.payments[0].amount).toBe('string');
  });

  it('preserves a BigInt beyond Number.MAX_SAFE_INTEGER exactly through the round trip', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    expect(view.totals.subtotal).toBe(BIG.toString());
    expect(view.lines[0].unitPrice).toBe(BIG.toString());
    expect(Number(view.totals.subtotal)).not.toBe(BIG); // proves precision would be lost as a number
  });

  it('sets the exact non-fiscal discriminator constants', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    expect(view.documentType).toBe('INTERNAL_NON_FISCAL_RECEIPT');
    expect(view.fiscal).toBe(false);
    expect(view.disclosureKey).toBe('receipt.internal.nonFiscal');
  });

  it('has no generatedAt field anywhere in the document', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    expect(JSON.stringify(view)).not.toContain('generatedAt');
  });

  it('never leaks COGS fields', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    const line = view.lines[0] as Record<string, unknown>;
    expect(line.unitCostSnapshot).toBeUndefined();
    expect(line.postedCogsTotal).toBeUndefined();
    expect(line.recipeVersionId).toBeUndefined();
    expect(line.priceListId).toBeUndefined();
    expect(line.priceEntryId).toBeUndefined();
    expect(line.priceRule).toBeUndefined();
  });

  it('never leaks merchant payment references or internal financial-control ids', () => {
    const view = toReceiptView(
      baseOrder(),
      [baseLine()],
      [
        basePayment({
          authorizationCode: 'AUTH123',
          paymentTerminalTxnRef: 'TXN-9',
        }),
      ],
    );
    const payment = view.payments[0] as Record<string, unknown>;
    expect(payment.authorizationCode).toBeUndefined();
    expect(payment.paymentTerminalTxnRef).toBeUndefined();
    expect(payment.cashSessionId).toBeUndefined();
    expect(payment.employeeId).toBeUndefined();
    expect(payment.terminalId).toBeUndefined();
  });

  it('never leaks internal order actor/operational fields', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    const order = view.order as Record<string, unknown>;
    expect(order.openedBy).toBeUndefined();
    expect(order.servedBy).toBeUndefined();
    expect(order.closedBy).toBeUndefined();
    expect(order.tableId).toBeUndefined();
    expect(order.guestCount).toBeUndefined();
    expect(order.notes).toBeUndefined();
    expect(order.version).toBeUndefined();
    expect((view as Record<string, unknown>).version).toBeUndefined();
  });

  it('reports a truthful zero discount, never invented', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    expect(view.totals.discountTotal).toBe('0');
    expect(view.lines[0].lineDiscount).toBe('0');
  });

  it('names the cash-rounding figure distinctly and separately from grandTotal/paidTotal', () => {
    const order = baseOrder();
    const view = toReceiptView(order, [baseLine()], [basePayment()]);
    expect(view.totals.cashRoundingAdjustment).toBe(
      order.roundingAdjustment.toString(),
    );
    expect(view.totals.grandTotal).toBe(order.grandTotal.toString());
    expect(view.totals.paidTotal).toBe(order.paidTotal.toString());
  });

  it('carries null tenderedAmount/changeGiven through for a card payment untouched', () => {
    const cardPayment = basePayment({
      tender: 'manual_external_card',
      tenderedAmount: null,
      changeGiven: null,
      cardScheme: 'visa',
      cardLast4: '4242',
      roundingAdjustment: 0n,
    });
    const view = toReceiptView(baseOrder(), [baseLine()], [cardPayment]);
    expect(view.payments[0].tenderedAmount).toBeNull();
    expect(view.payments[0].changeGiven).toBeNull();
    expect(view.payments[0].cardScheme).toBe('visa');
    expect(view.payments[0].cardLast4).toBe('4242');
  });

  it('carries the modifier snapshot and priceDelta through unchanged', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    expect(view.lines[0].modifiers).toHaveLength(1);
    expect(view.lines[0].modifiers[0].nameSnapshot).toEqual({
      en: 'Extra Garlic Sauce',
    });
    expect(view.lines[0].modifiers[0].priceDelta).toBe('200');
    expect(view.lines[0].modifiers[0].quantity).toBe(1);
  });

  it('carries the item/variant name snapshot through unchanged', () => {
    const view = toReceiptView(baseOrder(), [baseLine()], [basePayment()]);
    expect(view.lines[0].itemNameSnapshot).toEqual({
      item: { en: 'Grilled Chicken' },
      variant: { en: 'Large' },
    });
  });

  it('derives taxPresentation from the same order totals passed in', () => {
    const order = baseOrder(); // subtotal + taxTotal === grandTotal -> EXCLUSIVE
    const view = toReceiptView(order, [baseLine()], [basePayment()]);
    expect(view.taxPresentation).toBe('EXCLUSIVE');
  });
});
