import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Money } from '../../../common/money/money';
import { divideRounded } from '../../../common/money/rounding';
import {
  makePackDocument,
  withTax,
} from '../country-pack/country-pack.fixture';
import { CountryPack } from '../country-pack/country-pack.model';
import { parseCountryPack } from '../country-pack/country-pack.parser';
import {
  TaxEngineRegistry,
  UnknownTaxEngineError,
} from './tax-engine.registry';
import {
  computeLineTax,
  computeTaxableBase,
  resolveTaxClass,
  sumLineTax,
} from './tax.calculator';
import { TaxComputationError, UnknownTaxClassError } from './tax.model';

const engines = new TaxEngineRegistry();
const pack = (doc: unknown): CountryPack =>
  parseCountryPack(doc, { knownEngines: engines.ids });

const EG = () => pack(makePackDocument());
const EG_EXCLUSIVE = () => pack(withTax({ pricingMode: 'tax_exclusive' }));

const egp = (minor: bigint) => Money.of(minor, 'EGP');

const tax = (
  p: CountryPack,
  base: Money,
  classCode: string,
  orderType: string | null = null,
) =>
  computeLineTax(p, engines, {
    taxableBase: base,
    taxClassCode: classCode,
    orderType,
  });

describe('Tax engine — pricing modes (FR-FIN-031)', () => {
  it('computes tax-inclusive standard rate without floating point', () => {
    // EGP 120.00 gross at 14%: tax = 12000 * 14 / 114 = 1473.68... -> 1474.
    const result = tax(EG(), egp(12_000n), 'standard');

    expect(result.taxAmount.amount).toBe(1474n);
    expect(result.netAmount.amount).toBe(10_526n);
    expect(result.grossAmount.amount).toBe(12_000n);
    expect(result.pricingMode).toBe('tax_inclusive');
  });

  it('computes tax-exclusive standard rate and adds it exactly', () => {
    const result = tax(EG_EXCLUSIVE(), egp(12_000n), 'standard');

    expect(result.netAmount.amount).toBe(12_000n);
    expect(result.taxAmount.amount).toBe(1_680n);
    expect(result.grossAmount.amount).toBe(13_680n);
  });

  it('keeps net + tax exactly equal to the gross for every inclusive base', () => {
    // The property a two-step "derive net, then re-tax it" implementation loses.
    const p = EG();
    for (let base = 0n; base <= 2_000n; base += 1n) {
      const r = tax(p, egp(base), 'standard');
      expect(r.netAmount.plus(r.taxAmount).amount).toBe(base);
      expect(r.grossAmount.amount).toBe(base);
    }
  });
});

describe('Tax engine — tax classes (FR-FIN-033)', () => {
  it('applies a reduced rate', () => {
    expect(tax(EG_EXCLUSIVE(), egp(10_000n), 'reduced').taxAmount.amount).toBe(
      500n,
    );
    expect(tax(EG(), egp(10_000n), 'reduced').taxAmount.amount).toBe(476n);
  });

  it('applies a zero rate and still reports the supply as taxed', () => {
    const result = tax(EG_EXCLUSIVE(), egp(10_000n), 'zero');

    expect(result.taxAmount.amount).toBe(0n);
    expect(result.zeroRated).toBe(true);
    expect(result.exempt).toBe(false);
    expect(result.components).toHaveLength(1);
    expect(result.components[0].ratePercent).toBe('0.0');
  });

  it('treats an exempt supply as outside the scope of the tax', () => {
    const result = tax(EG_EXCLUSIVE(), egp(10_000n), 'exempt');

    expect(result.taxAmount.amount).toBe(0n);
    expect(result.exempt).toBe(true);
    expect(result.zeroRated).toBe(false);
    expect(result.components).toHaveLength(0);
  });

  it('keeps zero-rated and exempt distinguishable even though both yield zero', () => {
    const p = EG();
    const zero = tax(p, egp(10_000n), 'zero');
    const exempt = tax(p, egp(10_000n), 'exempt');

    expect(zero.taxAmount.amount).toBe(exempt.taxAmount.amount);
    expect(zero.exempt).not.toBe(exempt.exempt);
    expect(zero.zeroRated).not.toBe(exempt.zeroRated);
    expect(zero.components.length).not.toBe(exempt.components.length);
  });

  it('rejects an unknown tax class rather than defaulting to one', () => {
    expect(() => tax(EG(), egp(1_000n), 'luxury')).toThrow(
      UnknownTaxClassError,
    );
  });

  it('keeps an exempt line at par under inclusive pricing', () => {
    const result = tax(EG(), egp(10_000n), 'exempt');
    expect(result.netAmount.amount).toBe(10_000n);
    expect(result.grossAmount.amount).toBe(10_000n);
  });
});

describe('Tax engine — quantity and magnitude', () => {
  it('multiplies an integer quantity exactly', () => {
    const base = computeTaxableBase({ unitPrice: egp(1_234n), quantity: '3' });
    expect(base.amount).toBe(3_702n);
  });

  it('multiplies a fractional quantity exactly, rounding once', () => {
    // DECIMAL(12,3) quantities are real: 0.5 kg of grilled meat.
    expect(
      computeTaxableBase({ unitPrice: egp(2_500n), quantity: '0.5' }).amount,
    ).toBe(1_250n);
    expect(
      computeTaxableBase({ unitPrice: egp(999n), quantity: '1.5' }).amount,
    ).toBe(1_499n);
  });

  it('adds modifiers and subtracts the line discount before tax', () => {
    const base = computeTaxableBase({
      unitPrice: egp(1_000n),
      quantity: '2',
      modifierTotal: egp(350n),
      lineDiscount: egp(150n),
    });
    expect(base.amount).toBe(2_200n);
  });

  it('handles an amount far above Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const result = tax(EG_EXCLUSIVE(), egp(huge), 'standard');

    expect(result.taxAmount.amount).toBe(1_261_007_895_663_739n);
    expect(result.grossAmount.amount).toBe(huge + 1_261_007_895_663_739n);
  });

  it('computes a negative (refund-shaped) base symmetrically', () => {
    const result = tax(EG_EXCLUSIVE(), egp(-12_000n), 'standard');
    expect(result.taxAmount.amount).toBe(-1_680n);
    expect(result.grossAmount.amount).toBe(-13_680n);
  });
});

describe('Tax engine — currency exponents (ADR-008)', () => {
  const jpyPack = () =>
    pack(
      withTax(
        { roundingPrecision: 0, classes: [{ code: 'standard', rate: '10.0' }] },
        {
          currency: {
            code: 'JPY',
            exponent: 0,
            cashRounding: { enabled: false },
          },
        },
      ),
    );

  it('works with a zero-decimal currency', () => {
    const p = jpyPack();
    const inclusive = computeLineTax(p, engines, {
      taxableBase: Money.of(1_000n, 'JPY'),
      taxClassCode: 'standard',
      orderType: null,
    });
    expect(inclusive.taxAmount.amount).toBe(91n);
    expect(inclusive.netAmount.amount).toBe(909n);
  });

  it('works with a two-decimal currency', () => {
    expect(tax(EG_EXCLUSIVE(), egp(10_000n), 'standard').taxAmount.amount).toBe(
      1_400n,
    );
  });

  it('works with a three-decimal currency', () => {
    const p = pack(
      withTax(
        {
          pricingMode: 'tax_exclusive',
          roundingPrecision: 3,
          classes: [{ code: 'standard', rate: '5.0' }],
        },
        {
          currency: {
            code: 'KWD',
            exponent: 3,
            cashRounding: { enabled: false },
          },
        },
      ),
    );
    const result = computeLineTax(p, engines, {
      taxableBase: Money.of(10_000n, 'KWD'),
      taxClassCode: 'standard',
      orderType: null,
    });
    expect(result.taxAmount.amount).toBe(500n);
  });

  it('refuses a line priced in a currency the pack does not define', () => {
    expect(() =>
      computeLineTax(EG(), engines, {
        taxableBase: Money.of(1_000n, 'SAR'),
        taxClassCode: 'standard',
        orderType: null,
      }),
    ).toThrow(TaxComputationError);
  });
});

describe('Tax engine — rounding (FR-FIN-035, BR-FIN-001, BR-FIN-002)', () => {
  const at = (mode: string) =>
    pack(
      withTax({
        pricingMode: 'tax_exclusive',
        roundingMode: mode,
        classes: [{ code: 'standard', rate: '10.0' }],
      }),
    );

  it('breaks an exact half away from zero under the HALF_UP default', () => {
    // 5 minor units at 10% is exactly 0.5.
    expect(tax(at('HALF_UP'), egp(5n), 'standard').taxAmount.amount).toBe(1n);
    expect(tax(at('HALF_UP'), egp(-5n), 'standard').taxAmount.amount).toBe(-1n);
  });

  it('honours a pack rounding-mode override', () => {
    expect(tax(at('HALF_DOWN'), egp(5n), 'standard').taxAmount.amount).toBe(0n);
    expect(tax(at('HALF_EVEN'), egp(5n), 'standard').taxAmount.amount).toBe(0n);
    expect(tax(at('FLOOR'), egp(5n), 'standard').taxAmount.amount).toBe(0n);
    expect(tax(at('CEILING'), egp(5n), 'standard').taxAmount.amount).toBe(1n);
  });

  it('honours a pack rounding POINT coarser than the minor unit', () => {
    // roundingPrecision 0 on a 2-decimal currency rounds tax to whole pounds.
    const coarse = pack(
      withTax({
        pricingMode: 'tax_exclusive',
        roundingPrecision: 0,
        classes: [{ code: 'standard', rate: '14.0' }],
      }),
    );
    // 12000 * 14% = 1680 -> nearest 100 minor units -> 1700.
    expect(tax(coarse, egp(12_000n), 'standard').taxAmount.amount).toBe(1_700n);
  });

  it('rounds exactly once, at the pack rounding point (BR-FIN-001)', () => {
    // The result must equal the SINGLE-rounded rational, computed here
    // independently in exact integer arithmetic. Any intermediate rounding in
    // the engine would move the answer off this value.
    const p = EG();
    for (const base of [1n, 7n, 33n, 12_345n, 999_999n, 8_675_309n]) {
      const expected = divideRounded(base * 140n, 1_140n);
      expect(tax(p, egp(base), 'standard').taxAmount.amount).toBe(expected);
    }
  });
});

describe('Tax engine — multiple components (FR-FIN-032)', () => {
  const multi = (overrides: Record<string, unknown> = {}) =>
    pack(
      withTax({
        pricingMode: 'tax_exclusive',
        classes: [
          {
            code: 'standard',
            components: [
              { code: 'vat', rate: '5.0' },
              { code: 'municipality', rate: '2.5', ...overrides },
            ],
          },
        ],
      }),
    );

  it('applies two simultaneous components with their own rates', () => {
    const result = tax(multi(), egp(10_000n), 'standard');

    expect(result.components.map((c) => [c.code, c.amount.amount])).toEqual([
      ['vat', 500n],
      ['municipality', 250n],
    ]);
    expect(result.taxAmount.amount).toBe(750n);
    expect(result.grossAmount.amount).toBe(10_750n);
  });

  it('gives each component its own rounding precision', () => {
    // 10000 * 2.5% = 250, rounded to whole pounds -> 300.
    const result = tax(
      multi({ roundingPrecision: 0 }),
      egp(10_000n),
      'standard',
    );
    expect(result.components[1].amount.amount).toBe(300n);
    expect(result.taxAmount.amount).toBe(800n);
  });

  it('gives each component its own rounding mode', () => {
    const result = tax(
      multi({ roundingPrecision: 0, roundingMode: 'FLOOR' }),
      egp(10_000n),
      'standard',
    );
    expect(result.components[1].amount.amount).toBe(200n);
    expect(result.taxAmount.amount).toBe(700n);
  });

  it('shares one net base across components under inclusive pricing', () => {
    const inclusive = pack(
      withTax({
        classes: [
          {
            code: 'standard',
            components: [
              { code: 'vat', rate: '5.0' },
              { code: 'municipality', rate: '2.5' },
            ],
          },
        ],
      }),
    );
    const result = tax(inclusive, egp(11_750n), 'standard');

    expect(result.components.map((c) => c.amount.amount)).toEqual([547n, 273n]);
    expect(result.taxAmount.amount).toBe(820n);
    expect(result.netAmount.amount).toBe(10_930n);
    expect(result.netAmount.plus(result.taxAmount).amount).toBe(11_750n);
  });

  it('emits components in the pack declaration order, deterministically', () => {
    const p = multi();
    const first = tax(p, egp(10_000n), 'standard');
    const second = tax(p, egp(10_000n), 'standard');

    expect(first.components.map((c) => c.code)).toEqual([
      'vat',
      'municipality',
    ]);
    expect(second.components.map((c) => c.code)).toEqual(
      first.components.map((c) => c.code),
    );
  });

  it('sums the components to the reported line tax', () => {
    const result = tax(multi(), egp(37_913n), 'standard');
    const summed = result.components.reduce((s, c) => s + c.amount.amount, 0n);
    expect(result.taxAmount.amount).toBe(summed);
  });

  it('combines components of different decimal scales without an intermediate rounding', () => {
    const p = pack(
      withTax({
        pricingMode: 'tax_exclusive',
        classes: [
          {
            code: 'standard',
            components: [
              { code: 'vat', rate: '14' },
              { code: 'tourism', rate: '0.125' },
            ],
          },
        ],
      }),
    );
    const result = tax(p, egp(10_000n), 'standard');
    // Shared denominator: scale 3 -> D = 100000; vat n = 14000, tourism n = 125.
    expect(result.components.map((c) => c.amount.amount)).toEqual([
      1_400n,
      13n,
    ]);
  });
});

describe('Tax engine — order-type overrides (FR-FIN-033)', () => {
  const p = () =>
    pack(
      withTax({
        pricingMode: 'tax_exclusive',
        orderTypeOverrides: [
          { orderType: 'takeaway', classCode: 'standard', rate: '5.0' },
          { orderType: 'delivery', classCode: 'standard', rate: null },
        ],
      }),
    );

  it('uses the base class rate when no override applies', () => {
    expect(tax(p(), egp(10_000n), 'standard', 'dine_in').taxAmount.amount).toBe(
      1_400n,
    );
    expect(tax(p(), egp(10_000n), 'standard', null).taxAmount.amount).toBe(
      1_400n,
    );
  });

  it('uses the override defined for the order type', () => {
    expect(
      tax(p(), egp(10_000n), 'standard', 'takeaway').taxAmount.amount,
    ).toBe(500n);
  });

  it('leaves an unrelated order type on the base rate', () => {
    expect(
      tax(p(), egp(10_000n), 'standard', 'drive_thru').taxAmount.amount,
    ).toBe(1_400n);
  });

  it('leaves classes without an override untouched for that order type', () => {
    expect(tax(p(), egp(10_000n), 'reduced', 'takeaway').taxAmount.amount).toBe(
      500n,
    );
    expect(
      resolveTaxClass(p(), 'reduced', 'takeaway').components[0].ratePercent,
    ).toEqual({
      unscaled: 50n,
      scale: 1,
    });
  });

  it('lets an override make a class exempt for one order type', () => {
    const result = tax(p(), egp(10_000n), 'standard', 'delivery');
    expect(result.exempt).toBe(true);
    expect(result.taxAmount.amount).toBe(0n);
  });
});

describe('Tax engine — line-level computation and summation (FR-FIN-034)', () => {
  it('sums line taxes rather than taxing an order total', () => {
    const p = EG_EXCLUSIVE();
    const lines = [25n, 25n, 25n].map((b) => tax(p, egp(b), 'standard'));
    const lineSum = sumLineTax(lines, p.currency.currency);

    // Each line rounds 3.5 up to 4; the order total would give 10.5 -> 11.
    expect(lineSum.amount).toBe(12n);
    expect(tax(p, egp(75n), 'standard').taxAmount.amount).toBe(11n);
    expect(lineSum.amount).not.toBe(
      tax(p, egp(75n), 'standard').taxAmount.amount,
    );
  });

  it('sums a mixed-class order line by line', () => {
    const p = EG_EXCLUSIVE();
    const lines = [
      tax(p, egp(24_000n), 'standard'),
      tax(p, egp(1_500n), 'zero'),
      tax(p, egp(5_000n), 'exempt'),
    ];
    expect(sumLineTax(lines, p.currency.currency).amount).toBe(3_360n);
  });

  it('sums an empty order to zero in the pack currency', () => {
    const p = EG();
    const total = sumLineTax([], p.currency.currency);
    expect(total.amount).toBe(0n);
    expect(total.currency.code).toBe('EGP');
  });
});

describe('Tax engine — country independence (CR-03, FR-LOC-020/025)', () => {
  it('is driven entirely by pack data, never by a country code', () => {
    // Two packs differing ONLY in their code and rate. Same code path, and the
    // jurisdiction has no influence beyond the numbers it carries.
    const a = pack(withTax({ pricingMode: 'tax_exclusive' }, { code: 'EG' }));
    const b = pack(
      withTax(
        {
          pricingMode: 'tax_exclusive',
          classes: [{ code: 'standard', rate: '15.0' }],
        },
        {
          code: 'SA',
          currency: {
            code: 'EGP',
            exponent: 2,
            cashRounding: { enabled: false },
          },
        },
      ),
    );

    expect(tax(a, egp(10_000n), 'standard').taxAmount.amount).toBe(1_400n);
    expect(tax(b, egp(10_000n), 'standard').taxAmount.amount).toBe(1_500n);
  });

  it('changes the result when only the DATA changes, with no code change', () => {
    const before = pack(withTax({ pricingMode: 'tax_exclusive' }));
    const after = pack(
      withTax({
        pricingMode: 'tax_exclusive',
        classes: [{ code: 'standard', rate: '16.0' }],
      }),
    );

    expect(tax(before, egp(10_000n), 'standard').taxAmount.amount).toBe(1_400n);
    expect(tax(after, egp(10_000n), 'standard').taxAmount.amount).toBe(1_600n);
  });

  it('contains no jurisdiction branching anywhere in the localisation source', () => {
    // A static guard on CR-03: `if (country === 'EG')` must never appear.
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const isoCode = /['"](EG|SA|AE|JO|KW|QA|BH|OM|MA|TN)['"]/;
    const codeComparison =
      /\b(country|countryCode|jurisdiction|packCode)\b\s*(===|!==|==|!=)/i;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // Specs and fixtures legitimately name jurisdictions as DATA.
        if (
          entry.name.endsWith('.spec.ts') ||
          entry.name.endsWith('.fixture.ts')
        ) {
          continue;
        }
        const source = readFileSync(path, 'utf8');
        source.split('\n').forEach((line, i) => {
          const code = line.replace(/^\s*(\*|\/\/).*$/, '');
          if (isoCode.test(code) || codeComparison.test(code)) {
            offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });

  it('refuses to construct a strategy a pack names but the registry lacks', () => {
    expect(() => engines.require('creative_accounting')).toThrow(
      UnknownTaxEngineError,
    );
    expect(engines.has('vat_standard')).toBe(true);
  });
});
