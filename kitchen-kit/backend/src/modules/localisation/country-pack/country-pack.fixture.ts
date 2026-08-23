/**
 * TEST SUPPORT ONLY — builders for Country Pack documents.
 *
 * Nothing in `src/` outside a `.spec.ts` imports this file. It exists so the
 * parser, registry, tax and conformance suites share one notion of "a valid pack
 * document" instead of three drifting copies.
 *
 * The sample values are the SRS §22.2 Egypt example used strictly as DATA. No
 * production code branches on them, and the tax engine never sees the code `EG`
 * as anything but an opaque key.
 */

/** A minimal but complete, valid pack document. */
export function makePackDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code: 'EG',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    currency: {
      code: 'EGP',
      exponent: 2,
      symbolPosition: 'suffix',
      cashRounding: { enabled: false },
    },
    tax: {
      engine: 'vat_standard',
      pricingMode: 'tax_inclusive',
      computationLevel: 'line',
      roundingMode: 'HALF_UP',
      roundingPrecision: 2,
      classes: [
        { code: 'standard', rate: '14.0', label: { en: 'Standard' } },
        { code: 'reduced', rate: '5.0' },
        { code: 'zero', rate: '0.0' },
        { code: 'exempt', rate: null },
      ],
      serviceChargeTaxable: true,
      orderTypeOverrides: [],
    },
    ...overrides,
  };
}

/** Deep-merge a patch into the `tax` block of a pack document. */
export function withTax(
  patch: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const doc = makePackDocument(overrides);
  doc.tax = { ...(doc.tax as Record<string, unknown>), ...patch };
  return doc;
}

/** Deep-merge a patch into the `currency` block of a pack document. */
export function withCurrency(
  patch: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const doc = makePackDocument(overrides);
  doc.currency = { ...(doc.currency as Record<string, unknown>), ...patch };
  return doc;
}
