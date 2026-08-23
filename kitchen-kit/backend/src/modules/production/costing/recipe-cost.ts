/**
 * BR-MNU-003 — the recipe cost formula, as a pure function.
 *
 * Authorised by the D-17-05 NARROW AMENDMENT (2026-08-20, design gate §4.1).
 * The broader costing defer stands: this computes a recipe's cost and nothing
 * else — no variance, no margin, no menu engineering, no COGS posting.
 *
 * ── THE FORMULA, VERBATIM ──────────────────────────────────────────────────
 *
 *   cost(recipe) = SUM over lines of:
 *       quantity_in_base_unit
 *     x (1 + wastage_percentage / 100)
 *     x cost_per_base_unit(component)
 *     / (yield_percentage / 100)
 *
 *   stock_item component -> current valuation under THAT item's configured
 *                           costing method (FR-INV-001)
 *   sub_recipe component -> cost(sub_recipe) / yield_quantity(sub_recipe)
 *
 *   Recursive, depth limit 10.
 *
 * `yield_percentage` is a RecipeVersion column, so it is one factor common to
 * every line. Dividing the sum once is exactly equal to dividing each term —
 * in rational arithmetic, not merely approximately — so the literal formula and
 * this implementation agree bit for bit.
 *
 * ── WHY EVERY VALUE IS A RATIONAL ──────────────────────────────────────────
 * Quantity is DECIMAL(18,6), wastage and yield are DECIMAL(5,2), a unit
 * conversion factor is DECIMAL(20,10), and a sub-recipe divides by its own yield
 * quantity. Rounding at any step would inject a fabricated fraction into every
 * ingredient of every sale. The chain stays exact and is rounded ONCE, by the
 * caller, at the point it becomes money (BR-FIN-001).
 *
 * ── WHAT "INCOMPLETE" MEANS HERE ───────────────────────────────────────────
 * BR-MNU-012 permits selling an item with an incomplete or absent recipe at zero
 * or partial cost. It does NOT permit a fabricated zero for a COMPLETE recipe.
 * This function therefore never guesses: a line whose component cannot be valued
 * is reported as a `gap`, the caller sees `complete: false` alongside whatever
 * partial cost the valuable lines produced, and it is the caller — not this
 * module — that decides whether the recipe was genuinely incomplete (sale
 * permitted) or merely unvaluable (sale refused).
 */

import {
  Rational,
  ZERO,
  add,
  divide,
  fromExactDecimal,
  multiply,
  rational,
} from '../../../common/money/rational';
import { parseExactDecimal } from '../../../common/money/rounding';

/** BR-MNU-003: "Expansion is recursive with depth limit 10." */
export const MAX_RECIPE_DEPTH = 10;

export class RecipeCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeCostError';
  }
}

/**
 * Why a component did not contribute a number.
 *
 * ── THE DISTINCTION THAT DECIDES WHETHER A SALE IS ALLOWED ─────────────────
 * BR-MNU-012 permits selling an item whose RECIPE is incomplete. It says
 * nothing about selling an item whose recipe is complete but whose INGREDIENT
 * has no price yet — and those are different failures with different answers:
 *
 *   STRUCTURAL  the recipe definition is not finished. This is exactly the
 *               progressive-precision case BR-MNU-012 exists for: the sale
 *               proceeds at partial cost and the item is reported.
 *   VALUATION   the recipe IS finished; Inventory simply cannot price a
 *               component. Selling at a partial cost here would silently
 *               under-report COGS on a dish the operator believes is fully
 *               costed, so it is refused instead.
 *
 * The reason codes are classified rather than merged for that single purpose.
 */
export type CostGapReason =
  /** No component lines at all — the recipe exists but says nothing. */
  | 'no_components'
  /** A sub-recipe component has no published version: it is not yet defined. */
  | 'no_published_version'
  /** Inventory has no current valuation for a stock component. */
  | 'no_valuation'
  /** No UoM conversion from the line's unit to the component's costing unit. */
  | 'no_unit_conversion';

/** Reasons meaning "the recipe definition is unfinished" (BR-MNU-012). */
export const STRUCTURAL_GAP_REASONS: ReadonlySet<CostGapReason> = new Set([
  'no_components',
  'no_published_version',
]);

/** Reasons meaning "the definition is finished but the data to price it is not". */
export const VALUATION_GAP_REASONS: ReadonlySet<CostGapReason> = new Set([
  'no_valuation',
  'no_unit_conversion',
]);

export interface CostGap {
  readonly lineId: string;
  readonly sequence: number;
  readonly componentType: 'stock_item' | 'sub_recipe';
  readonly componentId: string;
  readonly reason: CostGapReason;
}

/** One resolved line, with everything the formula needs already looked up. */
export interface CostableLine {
  readonly lineId: string;
  readonly sequence: number;
  readonly componentType: 'stock_item' | 'sub_recipe';
  readonly componentId: string;
  /** DECIMAL(18,6) as an exact string — per recipe yield, never per portion. */
  readonly quantity: string;
  /** DECIMAL(5,2) as an exact string. */
  readonly wastagePercentage: string;
  /**
   * Factor converting the line's unit into the component's costing unit —
   * the stock item's BASE unit, or the sub-recipe's YIELD unit. Exact decimal
   * string; `null` when no conversion exists, which is a gap, not a 1.
   */
  readonly conversionFactor: string | null;
  /**
   * Cost of ONE costing unit of the component, in minor units, as an exact
   * rational. `null` when the component has no current valuation — which is a
   * gap, never a zero.
   */
  readonly costPerUnit: Rational | null;
  readonly isOptional: boolean;
}

export interface CostableRecipe {
  readonly recipeVersionId: string;
  /** DECIMAL(18,6) exact string; must be > 0. */
  readonly yieldQuantity: string;
  /** DECIMAL(5,2) exact string; must be > 0. */
  readonly yieldPercentage: string;
  readonly lines: readonly CostableLine[];
}

export interface RecipeCostResult {
  /** Cost of the WHOLE recipe yield, exact, in minor units. */
  readonly total: Rational;
  /** Cost of ONE yield unit: `total / yieldQuantity`. */
  readonly perYieldUnit: Rational;
  /**
   * True when every line contributed a real number — no gap of any kind.
   */
  readonly complete: boolean;
  /**
   * True when the recipe DEFINITION is finished: it has components, and every
   * sub-recipe it names is itself published. A false here is the BR-MNU-012
   * case — sale permitted, partial cost recorded, item reported.
   */
  readonly structurallyComplete: boolean;
  /**
   * True when every component the definition names could be priced. A false
   * here on a STRUCTURALLY COMPLETE recipe is NOT BR-MNU-012: it is missing
   * valuation data, and the caller must refuse rather than under-report.
   */
  readonly valuationComplete: boolean;
  readonly gaps: readonly CostGap[];
}

const HUNDRED = rational(100n);

function exact(value: string, what: string): Rational {
  try {
    return fromExactDecimal(parseExactDecimal(value));
  } catch (error) {
    throw new RecipeCostError(`${what}: ${(error as Error).message}`);
  }
}

/**
 * Compute one recipe version's cost.
 *
 * Sub-recipe recursion is the CALLER's job: it resolves each sub-recipe to its
 * published version, computes that version's `perYieldUnit`, and supplies it as
 * the line's `costPerUnit`. Keeping the recursion outside this function is what
 * lets it stay pure and lets the depth limit and the cycle guard live in one
 * place with the data access.
 */
export function computeRecipeCost(recipe: CostableRecipe): RecipeCostResult {
  const yieldQuantity = exact(recipe.yieldQuantity, 'yieldQuantity');
  const yieldPercentage = exact(recipe.yieldPercentage, 'yieldPercentage');

  if (yieldQuantity.num <= 0n) {
    throw new RecipeCostError(
      `Recipe version ${recipe.recipeVersionId} has a non-positive yield quantity; ` +
        'cost per unit is undefined.',
    );
  }
  if (yieldPercentage.num <= 0n) {
    throw new RecipeCostError(
      `Recipe version ${recipe.recipeVersionId} has a non-positive yield percentage; ` +
        'FR-MNU-043 loss factor must be greater than zero.',
    );
  }

  const gaps: CostGap[] = [];
  let sum: Rational = ZERO;

  // A published version with no components is the archetypal incomplete recipe:
  // "I created the recipe, I have not listed the ingredients yet." It costs
  // nothing truthfully, and it must be reported rather than read as complete.
  if (recipe.lines.length === 0) {
    gaps.push({
      lineId: recipe.recipeVersionId,
      sequence: 0,
      componentType: 'stock_item',
      componentId: recipe.recipeVersionId,
      reason: 'no_components',
    });
  }

  for (const line of recipe.lines) {
    const gap = (reason: CostGap['reason']): void => {
      gaps.push({
        lineId: line.lineId,
        sequence: line.sequence,
        componentType: line.componentType,
        componentId: line.componentId,
        reason,
      });
    };

    if (line.conversionFactor === null) {
      // An unconvertible unit is missing DATA, not a zero-cost ingredient.
      gap('no_unit_conversion');
      continue;
    }
    if (line.costPerUnit === null) {
      gap('no_valuation');
      continue;
    }

    // quantity_in_base_unit
    const quantityInBaseUnit = multiply(
      exact(line.quantity, `line ${line.sequence} quantity`),
      exact(line.conversionFactor, `line ${line.sequence} conversionFactor`),
    );
    // x (1 + wastage_percentage / 100)
    const wastageFactor = add(
      rational(1n),
      divide(
        exact(
          line.wastagePercentage,
          `line ${line.sequence} wastagePercentage`,
        ),
        HUNDRED,
      ),
    );
    // x cost_per_base_unit(component)
    sum = add(
      sum,
      multiply(multiply(quantityInBaseUnit, wastageFactor), line.costPerUnit),
    );
  }

  // / (yield_percentage / 100) — one common factor, applied once. Exactly equal
  // to applying it per line, because rational arithmetic does not round.
  const total = divide(sum, divide(yieldPercentage, HUNDRED));

  return {
    total,
    perYieldUnit: divide(total, yieldQuantity),
    complete: gaps.length === 0,
    structurallyComplete: !gaps.some((g) =>
      STRUCTURAL_GAP_REASONS.has(g.reason),
    ),
    valuationComplete: !gaps.some((g) => VALUATION_GAP_REASONS.has(g.reason)),
    gaps,
  };
}
