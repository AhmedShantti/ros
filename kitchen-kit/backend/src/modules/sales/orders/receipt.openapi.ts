import {
  businessDaySchema,
  decimalStringSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
  type SchemaObject,
} from '../../../common/openapi/schema-helpers';

/**
 * INTERNAL-MVP RECEIPT — concrete OpenAPI response schema. RCPT-R1.
 *
 * Shape verified against `toReceiptView` in `receipt.views.ts`, the only
 * place this response is actually built — not against the SRS or the
 * Prisma schema (the same discipline `orders.controller.ts`'s own schema
 * constants already follow).
 */

const receiptModifierSchema: SchemaObject = {
  type: 'object',
  properties: {
    modifierId: uuidSchema(),
    nameSnapshot: {
      type: 'object',
      description:
        'Opaque localized-name snapshot (locale -> name), persisted at capture time. Never re-resolved from Catalogue.',
    },
    quantity: { type: 'integer' },
    priceDelta: moneyStringSchema(),
  },
};

const receiptLineSchema: SchemaObject = {
  type: 'object',
  properties: {
    sequence: { type: 'integer' },
    menuItemId: uuidSchema(),
    variantId: uuidSchema(),
    itemNameSnapshot: {
      type: 'object',
      description:
        'Opaque localized-name snapshot (locale -> name), persisted at capture time. Never re-resolved from Catalogue.',
    },
    quantity: decimalStringSchema(),
    unitPrice: moneyStringSchema(),
    modifiers: { type: 'array', items: receiptModifierSchema },
    modifierTotal: moneyStringSchema(),
    lineDiscount: moneyStringSchema(
      'Minor-unit money amount as a decimal string. Always "0" under the ' +
        'current runtime — discounts are not implemented — reported ' +
        'verbatim, never invented.',
    ),
    lineSubtotal: moneyStringSchema(),
    taxClassId: uuidSchema(
      'The sale-time tax-class identity (never re-resolved). Non-null: ' +
        'a MenuItem with no TaxClass is not sellable.',
    ),
    taxAmount: moneyStringSchema(),
    lineTotal: moneyStringSchema(),
  },
};

const receiptPaymentSchema: SchemaObject = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tender: { type: 'string', enum: ['cash', 'manual_external_card'] },
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
    amount: moneyStringSchema(),
    roundingAdjustment: moneyStringSchema(
      'CASH-only cash-drawer rounding adjustment for this payment. Zero ' +
        'for manual_external_card. Never part of the order grandTotal or ' +
        'paidTotal.',
    ),
    tenderedAmount: nullable(
      moneyStringSchema('CASH only. Null for manual_external_card.'),
    ),
    changeGiven: nullable(
      moneyStringSchema('CASH only. Null for manual_external_card.'),
    ),
    cardScheme: nullable({
      type: 'string',
      description: 'manual_external_card only, when supplied.',
    }),
    cardLast4: nullable({
      type: 'string',
      description:
        'manual_external_card only, when supplied. Exactly 4 digits.',
    }),
    processedAt: isoDateTimeSchema('Server clock at capture.'),
  },
};

export const receiptSchema: SchemaObject = {
  type: 'object',
  description:
    'An itemized, INTERNAL, NON-FISCAL receipt view for a completed order ' +
    '(RCPT-R1). Makes no claim of legal or fiscal invoice compliance: no ' +
    'tax registration number, invoice sequence, country-pack-mandated tax ' +
    'breakdown, fiscal QR, fiscal signature or tax-authority submission ' +
    'status is present or derivable from this document.',
  properties: {
    documentType: {
      type: 'string',
      enum: ['INTERNAL_NON_FISCAL_RECEIPT'],
      description: 'Primary machine-readable non-fiscal classification.',
    },
    fiscal: {
      type: 'boolean',
      enum: [false],
      description: 'Always false. This is never a fiscal document.',
    },
    disclosureKey: {
      type: 'string',
      description:
        'Localization key for the visible non-fiscal disclosure text.',
      example: 'receipt.internal.nonFiscal',
    },
    order: {
      type: 'object',
      properties: {
        id: uuidSchema(),
        orderNumber: {
          type: 'string',
          description:
            'FR-POS-002 operational order number, e.g. ' +
            '<branch_code>-<business_day_seq>, drawn from a terminal ' +
            'block. This is NOT a fiscal invoice sequence: it is neither ' +
            'gapless nor globally ordered.',
        },
        businessDay: businessDaySchema(),
        branchId: uuidSchema(),
        terminalId: nullable(uuidSchema()),
        orderType: {
          type: 'string',
          enum: [
            'dine_in',
            'takeaway',
            'delivery',
            'drive_thru',
            'pickup',
            'aggregator',
          ],
        },
        channel: {
          type: 'string',
          enum: ['pos', 'kiosk', 'qr', 'aggregator', 'phone', 'api'],
        },
        state: {
          type: 'string',
          enum: ['completed'],
          description:
            'Always completed — a receipt cannot be produced for any ' +
            'other order state.',
        },
        completedAt: isoDateTimeSchema(),
        currency: {
          type: 'string',
          description: 'ISO 4217 currency code.',
          example: 'AED',
        },
        countryPackVersion: {
          type: 'string',
          description:
            'FR-LOC-021 — the pack version this order was priced under, ' +
            'pinned. Provenance only; never re-resolved.',
        },
      },
    },
    lines: { type: 'array', items: receiptLineSchema },
    totals: {
      type: 'object',
      properties: {
        subtotal: moneyStringSchema(),
        discountTotal: moneyStringSchema(
          'Always "0" under the current runtime — discounts are not ' +
            'implemented — reported verbatim, never invented.',
        ),
        serviceChargeTotal: moneyStringSchema(
          'Always "0" under the current runtime — service charge is not ' +
            'implemented.',
        ),
        taxTotal: moneyStringSchema(),
        grandTotal: moneyStringSchema(),
        paidTotal: moneyStringSchema(),
        tipTotal: moneyStringSchema(
          'Always "0" under the current runtime — tips are not implemented.',
        ),
        cashRoundingAdjustment: moneyStringSchema(
          'A separate cash-drawer-reconciliation figure. Never part of ' +
            'grandTotal or paidTotal.',
        ),
      },
    },
    taxPresentation: {
      type: 'string',
      enum: ['INCLUSIVE', 'EXCLUSIVE', 'NOT_APPLICABLE', 'UNDETERMINED'],
      description:
        'FR-FIN-031 — whether the pinned country pack priced this order ' +
        'tax-inclusive or tax-exclusive, derived from the frozen order ' +
        'totals only. NOT_APPLICABLE when taxTotal is zero.',
    },
    payments: { type: 'array', items: receiptPaymentSchema },
  },
};
