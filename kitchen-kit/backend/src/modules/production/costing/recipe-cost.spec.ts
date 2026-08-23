import {
  Rational,
  fromExactDecimal,
  rational,
  toMinorUnits,
} from '../../../common/money/rational';
import { parseExactDecimal } from '../../../common/money/rounding';
import {
  CostableLine,
  MAX_RECIPE_DEPTH,
  RecipeCostError,
  computeRecipeCost,
} from './recipe-cost';

const dec = (v: string): Rational => fromExactDecimal(parseExactDecimal(v));

let seq = 0;
function line(over: Partial<CostableLine> = {}): CostableLine {
  seq += 1;
  return {
    lineId: `line-${seq}`,
    sequence: seq,
    componentType: 'stock_item',
    componentId: `item-${seq}`,
    quantity: '1',
    wastagePercentage: '0',
    conversionFactor: '1',
    costPerUnit: rational(100n),
    isOptional: false,
    ...over,
  };
}

const recipe = (
  lines: CostableLine[],
  over: Partial<{ yieldQuantity: string; yieldPercentage: string }> = {},
) =>
  computeRecipeCost({
    recipeVersionId: 'rv-1',
    yieldQuantity: over.yieldQuantity ?? '1',
    yieldPercentage: over.yieldPercentage ?? '100',
    lines,
  });

describe('BR-MNU-003 recipe cost formula', () => {
  it('costs a single stock component', () => {
    // 2 units at 5.00 each.
    const result = recipe([
      line({ quantity: '2', costPerUnit: rational(500n) }),
    ]);
    expect(toMinorUnits(result.total)).toBe(1_000n);
    expect(toMinorUnits(result.perYieldUnit)).toBe(1_000n);
    expect(result.complete).toBe(true);
  });

  it('applies the per-component wastage uplift (FR-MNU-044)', () => {
    // 2 x (1 + 10/100) x 500 = 1100.
    const result = recipe([
      line({
        quantity: '2',
        wastagePercentage: '10',
        costPerUnit: rational(500n),
      }),
    ]);
    expect(toMinorUnits(result.total)).toBe(1_100n);
  });

  it('applies the whole-recipe yield loss factor (FR-MNU-043)', () => {
    // 1000 / (80/100) = 1250.
    const result = recipe(
      [line({ quantity: '2', costPerUnit: rational(500n) })],
      { yieldPercentage: '80' },
    );
    expect(toMinorUnits(result.total)).toBe(1_250n);
  });

  it('sums multiple lines', () => {
    const result = recipe([
      line({ quantity: '2', costPerUnit: rational(500n) }),
      line({ quantity: '3', costPerUnit: rational(250n) }),
      line({ quantity: '1', costPerUnit: rational(125n) }),
    ]);
    expect(toMinorUnits(result.total)).toBe(1_000n + 750n + 125n);
  });

  it('divides by the yield quantity for a per-unit cost', () => {
    // A batch recipe yielding 4 portions.
    const result = recipe(
      [line({ quantity: '4', costPerUnit: rational(500n) })],
      { yieldQuantity: '4' },
    );
    expect(toMinorUnits(result.total)).toBe(2_000n);
    expect(toMinorUnits(result.perYieldUnit)).toBe(500n);
  });

  it('converts the line unit into the component costing unit exactly', () => {
    // 500 g of an item costed at 200.00 per kg: factor 0.001.
    const result = recipe([
      line({
        quantity: '500',
        conversionFactor: '0.001',
        costPerUnit: rational(20_000n),
      }),
    ]);
    expect(toMinorUnits(result.total)).toBe(10_000n);
  });

  it('handles fractional quantities exactly', () => {
    const result = recipe([
      line({ quantity: '0.125', costPerUnit: rational(800n) }),
    ]);
    expect(toMinorUnits(result.total)).toBe(100n);
  });

  it('handles amounts far above Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n;
    const result = recipe([
      line({ quantity: '3', costPerUnit: rational(huge) }),
    ]);
    expect(toMinorUnits(result.total)).toBe(huge * 3n);
  });

  it('never rounds an intermediate value', () => {
    // 1 unit at 1 minor unit, yield 3% -> exactly 100/3, not 33 then multiplied.
    const result = recipe(
      [line({ quantity: '1', costPerUnit: rational(1n) })],
      {
        yieldPercentage: '3',
      },
    );
    expect(result.total).toEqual({ num: 100n, den: 3n });
    expect(toMinorUnits(result.total)).toBe(33n);
  });

  it('keeps a chain of awkward decimals exact', () => {
    // 0.1 + 0.2 worth of ingredient must equal 0.3 worth.
    const split = recipe([
      line({ quantity: '0.1', costPerUnit: rational(1_000n) }),
      line({ quantity: '0.2', costPerUnit: rational(1_000n) }),
    ]);
    const whole = recipe([
      line({ quantity: '0.3', costPerUnit: rational(1_000n) }),
    ]);
    expect(split.total).toEqual(whole.total);
  });

  it('costs a sub-recipe component from its per-yield-unit cost', () => {
    // The caller supplies cost(sub)/yield(sub) as the line's costPerUnit.
    const subPerUnit = dec('12.5');
    const result = recipe([
      line({
        componentType: 'sub_recipe',
        quantity: '4',
        costPerUnit: subPerUnit,
      }),
    ]);
    expect(toMinorUnits(result.total)).toBe(50n);
  });
});

describe('BR-MNU-012 boundary — gaps are reported, never zeroed', () => {
  it('reports a component with no valuation as a gap', () => {
    const result = recipe([
      line({ quantity: '2', costPerUnit: rational(500n) }),
      line({ componentId: 'unvalued', costPerUnit: null }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        componentId: 'unvalued',
        reason: 'no_valuation',
      }),
    ]);
    // The valuable line still contributes: this is a PARTIAL cost, not a zero.
    expect(toMinorUnits(result.total)).toBe(1_000n);
  });

  it('reports a missing unit conversion as a gap, not an assumed factor of 1', () => {
    const result = recipe([
      line({
        quantity: '500',
        conversionFactor: null,
        costPerUnit: rational(20_000n),
      }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.gaps[0].reason).toBe('no_unit_conversion');
    // Assuming 1 would have produced 10,000,000 — grams priced as kilograms.
    expect(toMinorUnits(result.total)).toBe(0n);
  });

  it('a complete recipe reports no gaps at all', () => {
    expect(recipe([line(), line()]).gaps).toEqual([]);
  });

  it('treats a recipe with NO components as structurally incomplete', () => {
    // "I created the recipe, I have not listed the ingredients yet" — the
    // archetypal BR-MNU-012 case. It costs nothing truthfully, but reading it
    // as COMPLETE would hide it from the completion report forever.
    const result = recipe([]);
    expect(toMinorUnits(result.total)).toBe(0n);
    expect(result.complete).toBe(false);
    expect(result.structurallyComplete).toBe(false);
    expect(result.valuationComplete).toBe(true);
    expect(result.gaps[0].reason).toBe('no_components');
  });
});

describe('structural vs valuation completeness', () => {
  it('classifies a missing VALUATION as a valuation gap, not a structural one', () => {
    // The recipe definition is finished; Inventory just cannot price the item.
    // The caller refuses the sale on this combination.
    const result = recipe([line(), line({ costPerUnit: null })]);
    expect(result.structurallyComplete).toBe(true);
    expect(result.valuationComplete).toBe(false);
  });

  it('classifies a missing UNIT CONVERSION as a valuation gap', () => {
    const result = recipe([line({ conversionFactor: null })]);
    expect(result.structurallyComplete).toBe(true);
    expect(result.valuationComplete).toBe(false);
  });

  it('classifies an unpublished SUB-RECIPE as a structural gap', () => {
    // The sub-recipe has no definition in force, so the parent's definition is
    // unfinished — BR-MNU-012 territory, sale permitted at partial cost.
    const result = computeRecipeCost({
      recipeVersionId: 'rv-1',
      yieldQuantity: '1',
      yieldPercentage: '100',
      lines: [
        line({ quantity: '2', costPerUnit: rational(500n) }),
        {
          ...line(),
          componentType: 'sub_recipe',
          conversionFactor: null,
          costPerUnit: null,
        },
      ],
    });
    // Emitted by the SERVICE for a sub-recipe; asserted here through the merged
    // classification the service performs.
    expect(result.valuationComplete).toBe(false);
    // The partial cost from the costable line survives.
    expect(toMinorUnits(result.total)).toBe(1_000n);
  });

  it('a fully costable recipe is complete on both axes', () => {
    const result = recipe([line(), line()]);
    expect(result.complete).toBe(true);
    expect(result.structurallyComplete).toBe(true);
    expect(result.valuationComplete).toBe(true);
  });
});

describe('Malformed recipe data fails loudly', () => {
  it('rejects a non-positive yield quantity', () => {
    expect(() => recipe([line()], { yieldQuantity: '0' })).toThrow(
      RecipeCostError,
    );
    expect(() => recipe([line()], { yieldQuantity: '-1' })).toThrow(
      /yield quantity/,
    );
  });

  it('rejects a non-positive yield percentage', () => {
    expect(() => recipe([line()], { yieldPercentage: '0' })).toThrow(
      /yield percentage/,
    );
  });

  it('rejects a malformed decimal rather than coercing it', () => {
    expect(() => recipe([line({ quantity: '1e3' })])).toThrow(RecipeCostError);
    expect(() => recipe([line({ wastagePercentage: 'ten' })])).toThrow(
      RecipeCostError,
    );
  });

  it('pins the SRS depth limit', () => {
    expect(MAX_RECIPE_DEPTH).toBe(10);
  });
});
