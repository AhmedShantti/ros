import { Prisma } from '../../../generated/prisma/client';
import type { CostGapReason } from '../costing/recipe-cost';

/**
 * Production PUBLIC contract — P1F-2. The only two things Sales/Inventory may
 * ask Production for consumption purposes; everything else about recipe
 * expansion stays private to this module.
 *
 * Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
 * correction.md (CONTROLLING) §L "D. PRODUCTION".
 *
 * `resolveConsumptionBasis` is LINE CAPTURE ONLY — it returns the pinned
 * recipe-version CLOSURE, the pinned modifier effects, and the pinned
 * unit-conversion factors a line needs, and NOTHING resolved/net and NO
 * money. Sales persists its three return values verbatim into the P1F-2
 * snapshot tables (`sales.order_line_recipe_versions`,
 * `sales.order_line_modifier_effects`, `sales.order_line_component_
 * conversions`) inside the SAME transaction as line capture.
 *
 * `planConsumption` is COMPLETION ONLY — REAL recursive expansion (sub-recipe
 * recursion, yield/wastage arithmetic, depth-10 and cycle guards, modifier
 * application, within-line aggregation), reading recipe/modifier-effect
 * STRUCTURE fresh (a published `RecipeVersion`'s lines are immutable —
 * GAP-2 — so a live read of them is equivalent to a snapshot) but resolving
 * sub-recipes ONLY to the caller-supplied `pinnedVersionIds` and taking
 * conversion factors ONLY from the caller-supplied pinned `conversions` —
 * never from `inventory.uom_conversions` or `stock_items.base_unit_id`
 * directly, and never from `production.modifier_recipe_effects` directly
 * (that table is mutable; the caller-supplied `modifierEffects` snapshot is
 * what a later edit must not be able to reach back into).
 */
export const PRODUCTION_CONSUMPTION_QUERY = Symbol(
  'PRODUCTION_CONSUMPTION_QUERY',
);

export type ModifierEffectOperationValue = 'add' | 'remove_all';
export type RecipeComponentTypeValue = 'stock_item' | 'sub_recipe';

/** One entry of the pinned recipe-version closure. */
export interface RecipeVersionClosureEntry {
  readonly recipeVersionId: string;
  /** 0 = the line's own base version; >0 = a sub-recipe reached at depth. */
  readonly depth: number;
}

/** One modifier effect, resolved to a PINNED sub-recipe VERSION where applicable. */
export interface ResolvedModifierEffect {
  readonly operation: ModifierEffectOperationValue;
  readonly componentType: RecipeComponentTypeValue;
  readonly stockItemId: string | null;
  /** PINNED VERSION — never the logical recipe id. Null for stock_item effects. */
  readonly subRecipeVersionId: string | null;
  /** DECIMAL(18,6) exact string; null for remove_all. */
  readonly quantity: string | null;
  readonly unitId: string | null;
  readonly sequence: number;
}

/** One pinned unit-conversion factor: `fromUnitId` -> the stock item's base unit. */
export interface PinnedConversion {
  readonly stockItemId: string;
  readonly fromUnitId: string;
  readonly baseUnitId: string;
  /** DECIMAL(20,10) exact string. */
  readonly factor: string;
}

export interface ResolveConsumptionBasisInput {
  readonly tenantId: string;
  /** Null for the BR-MNU-012 absent-recipe case. */
  readonly recipeVersionId: string | null;
  /** The line's selected modifier ids (catalogue.modifiers.id values). */
  readonly modifierIds: readonly string[];
}

/**
 * A modifier ADD effect that targeted a sub-recipe with NO published version
 * at line-capture time, and therefore could not be persisted into
 * `sales.order_line_modifier_effects` (its XOR CHECK requires a non-null
 * `sub_recipe_version_id` for a `sub_recipe` row — there is no way to encode
 * "unresolved" there without a schema change). This is the STRUCTURAL-gap
 * record of that omission, returned so the caller can make it visible
 * elsewhere (the line-capture audit entry) instead of the effect vanishing
 * with zero trace. It is NOT persisted as domain state and never reaches
 * `planConsumption` — the gap is knowable only at capture time.
 */
export interface DroppedModifierEffect {
  readonly modifierId: string;
  readonly sequence: number;
  readonly reason: 'no_published_version';
}

export interface ResolveConsumptionBasisResult {
  readonly versionClosure: readonly RecipeVersionClosureEntry[];
  readonly modifierEffects: ReadonlyMap<
    string,
    readonly ResolvedModifierEffect[]
  >;
  readonly conversions: readonly PinnedConversion[];
  readonly droppedModifierEffects: readonly DroppedModifierEffect[];
}

/** One modifier effect as pinned on the order line, ready for `planConsumption`. */
export interface PinnedModifierEffectInput {
  readonly operation: ModifierEffectOperationValue;
  readonly componentType: RecipeComponentTypeValue;
  readonly stockItemId: string | null;
  readonly subRecipeVersionId: string | null;
  readonly quantity: string | null;
  readonly unitId: string | null;
  /**
   * `order_line_modifiers.quantity` — the SELECTION quantity for the
   * modifier this effect belongs to. Part of the ADD scaling factor.
   */
  readonly modifierSelectionQuantity: number;
}

export interface PlanConsumptionLineInput {
  readonly orderLineId: string;
  /** Null for the BR-MNU-012 absent-recipe case: 0 depletion. */
  readonly recipeVersionId: string | null;
  /** The FULL pinned closure — this line's own, from `order_line_recipe_versions`. */
  readonly pinnedVersionIds: readonly string[];
  /** Sold portions — `order_lines.quantity`, exact decimal string. */
  readonly quantity: string;
  readonly modifierEffects: readonly PinnedModifierEffectInput[];
  /** This line's own pinned conversions, from `order_line_component_conversions`. */
  readonly conversions: readonly PinnedConversion[];
}

export interface PlanConsumptionInput {
  readonly lines: readonly PlanConsumptionLineInput[];
}

/** Reused verbatim from `recipe-cost.ts` — see that module for the STRUCTURAL/VALUATION split. */
export type ConsumptionGapReason = CostGapReason;

export interface ConsumptionGap {
  readonly stockItemId: string | null;
  readonly reason: ConsumptionGapReason;
}

export interface PlannedComponent {
  readonly stockItemId: string;
  /** DECIMAL(18,6) exact string, in the stock item's BASE unit. */
  readonly quantityInBaseUnit: string;
  readonly unitId: string;
}

export interface PlanConsumptionLineResult {
  readonly orderLineId: string;
  readonly components: readonly PlannedComponent[];
  /** STRUCTURAL gaps only (tolerated) — a VALUATION gap throws instead. */
  readonly gaps: readonly ConsumptionGap[];
}

export interface PlanConsumptionResult {
  readonly perLine: readonly PlanConsumptionLineResult[];
}

export interface ProductionConsumptionQuery {
  resolveConsumptionBasis(
    tx: Prisma.TransactionClient,
    input: ResolveConsumptionBasisInput,
  ): Promise<ResolveConsumptionBasisResult>;

  planConsumption(
    tx: Prisma.TransactionClient,
    input: PlanConsumptionInput,
  ): Promise<PlanConsumptionResult>;
}
