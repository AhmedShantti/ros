import { RoundingMode } from '../../../common/money/rounding';
import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import { CountryPackValidationError } from './country-pack.model';
import {
  makePackDocument,
  withCurrency,
  withTax,
} from './country-pack.fixture';
import { parseCountryPack } from './country-pack.parser';

const options = { knownEngines: new TaxEngineRegistry().ids };
const parse = (doc: unknown) => parseCountryPack(doc, options);

/** Remove a key from a nested pack document without mutating the original. */
function without(doc: Record<string, unknown>, key: string) {
  const copy = { ...doc };
  delete copy[key];
  return copy;
}

describe('Country Pack parser (FR-LOC-020/021/023/025)', () => {
  it('loads a valid pack whole', () => {
    const pack = parse(makePackDocument());

    expect(pack.code).toBe('EG');
    expect(pack.version).toBe('2026.1');
    expect(pack.effectiveFrom.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(pack.currency.currency.code).toBe('EGP');
    expect(pack.currency.currency.exponent).toBe(2);
    expect(pack.tax.engine).toBe('vat_standard');
    expect(pack.tax.pricingMode).toBe('tax_inclusive');
    expect(pack.tax.roundingMode).toBe(RoundingMode.HALF_UP);
    expect([...pack.tax.classes.keys()]).toEqual([
      'standard',
      'reduced',
      'zero',
      'exempt',
    ]);
  });

  it('rejects a missing code', () => {
    expect(() => parse(without(makePackDocument(), 'code'))).toThrow(
      CountryPackValidationError,
    );
  });

  it('rejects a missing version', () => {
    expect(() => parse(without(makePackDocument(), 'version'))).toThrow(
      /countryPack\.version/,
    );
  });

  it('rejects a version too long to pin onto an order', () => {
    // sales.orders.country_pack_version is VARCHAR(24): a version that cannot be
    // pinned must fail at load, not at the first sale.
    expect(() => parse(makePackDocument({ version: 'v'.repeat(25) }))).toThrow(
      /at most 24 characters/,
    );
  });

  it('rejects a malformed effective date', () => {
    expect(() =>
      parse(makePackDocument({ effectiveFrom: '2026-1-1' })),
    ).toThrow(/ISO date/);
    expect(() =>
      parse(makePackDocument({ effectiveFrom: '2026-02-30' })),
    ).toThrow(/not a real calendar date/);
  });

  it('rejects a bad currency code', () => {
    expect(() => parse(withCurrency({ code: 'EGPX' }))).toThrow(
      /countryPack\.currency/,
    );
  });

  it('rejects a bad minor-unit exponent', () => {
    expect(() => parse(withCurrency({ exponent: 9 }))).toThrow(
      /countryPack\.currency/,
    );
    expect(() => parse(withCurrency({ exponent: 2.5 }))).toThrow(
      /expected an integer/,
    );
  });

  it('rejects a rate that is not an exact decimal', () => {
    expect(() =>
      parse(withTax({ classes: [{ code: 'standard', rate: '1e-2' }] })),
    ).toThrow(/exact decimal/);
    expect(() =>
      parse(withTax({ classes: [{ code: 'standard', rate: 'fourteen' }] })),
    ).toThrow(/exact decimal/);
  });

  it('rejects a JSON number in a rate position', () => {
    // ADR-008: a binary float must never seed a monetary computation.
    expect(() =>
      parse(withTax({ classes: [{ code: 'standard', rate: 14.0 }] })),
    ).toThrow(/exact decimal STRING/);
  });

  it('rejects a duplicate tax class', () => {
    expect(() =>
      parse(
        withTax({
          classes: [
            { code: 'standard', rate: '14.0' },
            { code: 'standard', rate: '5.0' },
          ],
        }),
      ),
    ).toThrow(/duplicate tax class/);
  });

  it('rejects an unknown tax engine (FR-LOC-025)', () => {
    expect(() => parse(withTax({ engine: 'creative_accounting' }))).toThrow(
      /unknown tax engine/,
    );
  });

  it('rejects an unsupported rounding mode', () => {
    expect(() => parse(withTax({ roundingMode: 'ROUND_ISH' }))).toThrow(
      /unsupported rounding mode/,
    );
  });

  it('rejects a computation level other than line (FR-FIN-034)', () => {
    expect(() => parse(withTax({ computationLevel: 'order' }))).toThrow(
      /FR-FIN-034/,
    );
  });

  it('rejects an unsupported pricing mode', () => {
    expect(() => parse(withTax({ pricingMode: 'vat_free_friday' }))).toThrow(
      /countryPack\.tax\.pricingMode/,
    );
  });

  it('rejects a rounding precision finer than the currency', () => {
    expect(() => parse(withTax({ roundingPrecision: 3 }))).toThrow(
      /exceeds the currency/,
    );
  });

  it('rejects an impossible component base rather than guessing compounding', () => {
    expect(() =>
      parse(
        withTax({
          classes: [
            {
              code: 'standard',
              components: [
                { code: 'vat', rate: '14.0' },
                { code: 'municipality', rate: '2.0', base: 'line_gross' },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/Only "line_net" is implemented/);
  });

  it('rejects duplicate component codes', () => {
    expect(() =>
      parse(
        withTax({
          classes: [
            {
              code: 'standard',
              components: [
                { code: 'vat', rate: '14.0' },
                { code: 'vat', rate: '2.0' },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/duplicate component/);
  });

  it('rejects an empty component list rather than reading it as exempt', () => {
    expect(() =>
      parse(withTax({ classes: [{ code: 'standard', components: [] }] })),
    ).toThrow(/FR-FIN-033/);
  });

  it('rejects declaring both rate and components', () => {
    expect(() =>
      parse(
        withTax({
          classes: [
            {
              code: 'standard',
              rate: '14.0',
              components: [{ code: 'vat', rate: '1' }],
            },
          ],
        }),
      ),
    ).toThrow(/never both/);
  });

  it('rejects an order-type override naming an unknown class', () => {
    expect(() =>
      parse(
        withTax({
          orderTypeOverrides: [
            { orderType: 'takeaway', classCode: 'luxury', rate: '0.0' },
          ],
        }),
      ),
    ).toThrow(/unknown tax class/);
  });

  it('keeps zero-rated and exempt structurally distinct (FR-FIN-033)', () => {
    const pack = parse(makePackDocument());
    const zero = pack.tax.classes.get('zero')!;
    const exempt = pack.tax.classes.get('exempt')!;

    expect(zero.exempt).toBe(false);
    expect(zero.components).toHaveLength(1);
    expect(exempt.exempt).toBe(true);
    expect(exempt.components).toHaveLength(0);
  });

  it('expands a bare rate into exactly one component named after the class', () => {
    const pack = parse(makePackDocument());
    const standard = pack.tax.classes.get('standard')!;

    expect(standard.components).toHaveLength(1);
    expect(standard.components[0].code).toBe('standard');
    expect(standard.components[0].ratePercent).toEqual({
      unscaled: 140n,
      scale: 1,
    });
    expect(standard.components[0].roundingMode).toBe(RoundingMode.HALF_UP);
    expect(standard.components[0].roundingPrecision).toBe(2);
  });

  it('carries per-component rate, rounding mode and rounding precision', () => {
    const pack = parse(
      withTax({
        classes: [
          {
            code: 'standard',
            components: [
              { code: 'vat', rate: '5.0' },
              {
                code: 'municipality',
                rate: '2.5',
                roundingMode: 'FLOOR',
                roundingPrecision: 1,
              },
            ],
          },
        ],
      }),
    );
    const [vat, municipality] = pack.tax.classes.get('standard')!.components;

    expect(vat.roundingMode).toBe(RoundingMode.HALF_UP);
    expect(vat.roundingPrecision).toBe(2);
    expect(municipality.roundingMode).toBe(RoundingMode.FLOOR);
    expect(municipality.roundingPrecision).toBe(1);
  });

  it('ignores pack sections outside this slice without rejecting them', () => {
    // A real pack carries invoice / fiscal / labour / calendar / legal blocks.
    // They are not modelled yet; a pack must not be rejected for having them.
    const pack = parse(
      makePackDocument({
        invoice: { template: 'eg_standard_v3' },
        legal: { dataRetentionYears: 5 },
      }),
    );
    expect(pack.code).toBe('EG');
  });
});
