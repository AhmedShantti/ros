/**
 * Recipe costing — the recursion, the persistence and the FR-MNU-046 cascade.
 *
 * Authorised by the D-17-05 NARROW AMENDMENT (design gate §4.1). The formula
 * itself lives in `recipe-cost.ts` as a pure function; this service supplies it
 * with resolved data and writes the answer to
 * `production.recipe_versions.computed_cost` / `cost_computed_at` — the columns
 * the approved SQL always had and D-17-05 had left permanently null.
 *
 * ── DEPTH AND CYCLES ───────────────────────────────────────────────────────
 * BR-MNU-001 already forbids a cycle and `recipe-graph.ts` rejects one on save,
 * so a cycle here means the data is corrupt. Cost expansion still guards against
 * it independently: a corrupted graph must produce a clean error, not a stack
 * overflow in a checkout. The depth limit is BR-MNU-003's own: 10.
 *
 * ── EVERY READ IS TENANT-SCOPED ────────────────────────────────────────────
 * Every query runs on the caller's transaction, which is already inside
 * `withAuthContext`, so RLS applies to the whole expansion — including the
 * sub-recipes it discovers on the way down. A sub-recipe belonging to another
 * tenant is invisible, and an invisible sub-recipe is a gap, not a silent zero.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Rational,
  rational,
  toMinorUnits,
} from '../../../common/money/rational';
import { RoundingMode } from '../../../common/money/rounding';
import { Prisma } from '../../../generated/prisma/client';
import { selectPublishedVersion } from '../recipe-graph';
import {
  CostGap,
  CostableLine,
  MAX_RECIPE_DEPTH,
  RecipeCostError,
  RecipeCostResult,
  STRUCTURAL_GAP_REASONS,
  VALUATION_GAP_REASONS,
  computeRecipeCost,
} from './recipe-cost';
import { StockValuationService } from './stock-valuation.service';

/** Raised when expansion exceeds the depth limit or meets a cycle. */
export class RecipeExpansionError extends RecipeCostError {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeExpansionError';
  }
}

export interface CostedVersion extends RecipeCostResult {
  readonly recipeVersionId: string;
  readonly recipeId: string;
  /** `perYieldUnit` rounded once to whole minor units. */
  readonly unitCostMinorUnits: bigint;
  /** `total` rounded once to whole minor units — what `computed_cost` stores. */
  readonly totalCostMinorUnits: bigint;
}

@Injectable()
export class RecipeCostService {
  private readonly logger = new Logger(RecipeCostService.name);

  constructor(private readonly valuation: StockValuationService) {}

  /**
   * Cost one recipe VERSION, expanding sub-recipes to their published versions.
   *
   * Does not write. `recomputeAndPersist` is the writing entry point.
   */
  async cost(
    tx: Prisma.TransactionClient,
    recipeVersionId: string,
    visiting: readonly string[] = [],
    depth = 0,
  ): Promise<CostedVersion> {
    if (depth > MAX_RECIPE_DEPTH) {
      throw new RecipeExpansionError(
        `Recipe expansion exceeded the depth limit of ${MAX_RECIPE_DEPTH} ` +
          '(BR-MNU-003).',
      );
    }

    const version = await tx.recipeVersion.findUnique({
      where: { id: recipeVersionId },
      select: {
        id: true,
        recipeId: true,
        yieldQuantity: true,
        yieldPercentage: true,
        lines: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            componentType: true,
            stockItemId: true,
            subRecipeId: true,
            quantity: true,
            unitId: true,
            wastagePercentage: true,
            isOptional: true,
          },
        },
      },
    });
    if (!version) {
      throw new RecipeCostError(`Recipe version ${recipeVersionId} not found.`);
    }
    if (visiting.includes(version.recipeId)) {
      // BR-MNU-001 should have made this impossible. If the data says otherwise,
      // say so loudly rather than recursing until the stack gives out.
      throw new RecipeExpansionError(
        `Recipe ${version.recipeId} appears inside its own expansion. ` +
          'BR-MNU-001 forbids this; the recipe graph is corrupt.',
      );
    }

    const stockItemIds = version.lines
      .filter((l) => l.componentType === 'stock_item' && l.stockItemId)
      .map((l) => l.stockItemId!);
    const valuations = await this.valuation.valuationsFor(tx, stockItemIds);

    const lines: CostableLine[] = [];
    const earlyGaps: CostGap[] = [];

    for (const line of version.lines) {
      const base = {
        lineId: line.id,
        sequence: line.sequence,
        componentType: line.componentType,
        quantity: line.quantity.toFixed(6),
        wastagePercentage: line.wastagePercentage.toFixed(2),
        isOptional: line.isOptional,
      };

      if (line.componentType === 'stock_item') {
        const stockItemId = line.stockItemId!;
        const valuation = valuations.get(stockItemId);
        const conversion = await this.conversionToStockBaseUnit(
          tx,
          stockItemId,
          line.unitId,
        );
        lines.push({
          ...base,
          componentId: stockItemId,
          conversionFactor: conversion,
          costPerUnit: valuation?.costPerBaseUnit ?? null,
        });
        continue;
      }

      // Sub-recipe: its cost per YIELD unit, from its own published version.
      const subRecipeId = line.subRecipeId!;
      const published = await this.publishedVersionOf(tx, subRecipeId);
      if (!published) {
        earlyGaps.push({
          lineId: line.id,
          sequence: line.sequence,
          componentType: 'sub_recipe',
          componentId: subRecipeId,
          reason: 'no_published_version',
        });
        lines.push({
          ...base,
          componentId: subRecipeId,
          conversionFactor: null,
          costPerUnit: null,
        });
        continue;
      }

      const sub = await this.cost(
        tx,
        published.id,
        [...visiting, version.recipeId],
        depth + 1,
      );
      // A sub-recipe with an unvaluable component makes THIS recipe incomplete
      // too — the gap propagates rather than being absorbed into a partial sum.
      earlyGaps.push(...sub.gaps);
      lines.push({
        ...base,
        componentId: subRecipeId,
        conversionFactor: await this.conversionBetweenUnits(
          tx,
          line.unitId,
          published.yieldUnitId,
        ),
        costPerUnit: sub.perYieldUnit,
      });
    }

    const result = computeRecipeCost({
      recipeVersionId: version.id,
      yieldQuantity: version.yieldQuantity.toFixed(6),
      yieldPercentage: version.yieldPercentage.toFixed(2),
      lines,
    });

    // De-duplicate: a sub-recipe gap is recorded once by the child and would
    // otherwise be recorded again by the parent's own null-cost line.
    const gaps = dedupeGaps([...earlyGaps, ...result.gaps]);

    return {
      ...result,
      gaps,
      complete: gaps.length === 0,
      // Recomputed over the MERGED gap set, so a sub-recipe's unfinished
      // definition makes the parent structurally incomplete too, and a
      // sub-recipe's missing valuation makes the parent unvaluable too.
      structurallyComplete: !gaps.some((g) =>
        STRUCTURAL_GAP_REASONS.has(g.reason),
      ),
      valuationComplete: !gaps.some((g) => VALUATION_GAP_REASONS.has(g.reason)),
      recipeVersionId: version.id,
      recipeId: version.recipeId,
      // The single rounding point (BR-FIN-001). Everything above is exact.
      totalCostMinorUnits: toMinorUnits(result.total, RoundingMode.HALF_UP),
      unitCostMinorUnits: toMinorUnits(
        result.perYieldUnit,
        RoundingMode.HALF_UP,
      ),
    };
  }

  /**
   * Cost a version and persist the result — FR-MNU-046's storage half.
   *
   * A PARTIAL cost is persisted too: it is the truthful cost of the components
   * that can be valued, and `GET /catalogue/completeness` style reporting needs
   * to see it. What must never happen is a partial cost silently reaching a SALE
   * as though it were complete, and that is prevented at the sale, by
   * `unitCostFor`, not by refusing to store the number here.
   */
  async recomputeAndPersist(
    tx: Prisma.TransactionClient,
    recipeVersionId: string,
  ): Promise<CostedVersion> {
    const costed = await this.cost(tx, recipeVersionId);
    await tx.recipeVersion.update({
      where: { id: recipeVersionId },
      data: {
        computedCost: costed.totalCostMinorUnits,
        costComputedAt: new Date(),
      },
    });
    return costed;
  }

  /**
   * FR-MNU-046 — "recipe cost SHALL recompute when component costs change,
   * cascading through dependent sub-recipes and parent recipes".
   *
   * Called from the valuation mutation boundary (`MovementsService.post`), which
   * is the only place a stock item's current cost can change. Not a scheduler:
   * the SRS says "when component costs change", and the Production design gate
   * §20 still excludes schedulers and message brokers.
   *
   * Walks UPWARD: the versions directly using the item, then the versions using
   * those recipes, and so on to the depth limit. Every step is tenant-scoped by
   * the caller's RLS context.
   */
  async recomputeForStockItem(
    tx: Prisma.TransactionClient,
    stockItemId: string,
  ): Promise<string[]> {
    return this.recomputeForStockItems(tx, [stockItemId]);
  }

  /**
   * P1F-2 — the SAME cascade, batched across several stock items in one
   * call. Order Completion calls this ONCE, after all movements, with the
   * DISTINCT FIFO stock items the depletion touched.
   */
  async recomputeForStockItems(
    tx: Prisma.TransactionClient,
    stockItemIds: readonly string[],
  ): Promise<string[]> {
    if (stockItemIds.length === 0) return [];
    const seed = await tx.recipeLine.findMany({
      where: {
        componentType: 'stock_item',
        stockItemId: { in: [...stockItemIds] },
      },
      select: { recipeVersionId: true },
    });
    return this.cascade(
      tx,
      seed.map((l) => l.recipeVersionId),
    );
  }

  /**
   * Recompute the given versions and everything that depends on them.
   *
   * A DOMAIN failure on one version — a corrupt graph, a cycle, a malformed
   * decimal — is logged and skipped rather than aborting the inventory movement
   * that triggered it: one bad recipe must not block a goods receipt. That
   * version keeps its previous `computed_cost`, which is stale but never
   * wrong-by-fabrication.
   *
   * Anything else PROPAGATES, deliberately. A database-level failure (a missing
   * privilege, a constraint) has already put the enclosing PostgreSQL
   * transaction into a failed state, so "catching" it would only produce a
   * movement that appears to commit and then does not. It must surface.
   */
  private async cascade(
    tx: Prisma.TransactionClient,
    seedVersionIds: readonly string[],
  ): Promise<string[]> {
    const done = new Set<string>();
    let frontier = [...new Set(seedVersionIds)];

    for (
      let depth = 0;
      depth <= MAX_RECIPE_DEPTH && frontier.length > 0;
      depth++
    ) {
      const next = new Set<string>();
      for (const versionId of frontier) {
        if (done.has(versionId)) continue;
        done.add(versionId);
        try {
          await this.recomputeAndPersist(tx, versionId);
        } catch (error) {
          if (!(error instanceof RecipeCostError)) throw error;
          this.logger.warn(
            `Recipe version ${versionId} could not be costed: ${error.message}`,
          );
          continue;
        }
        // Parents: versions whose lines consume THIS version's recipe.
        const version = await tx.recipeVersion.findUnique({
          where: { id: versionId },
          select: { recipeId: true },
        });
        if (!version) continue;
        const parents = await tx.recipeLine.findMany({
          where: { componentType: 'sub_recipe', subRecipeId: version.recipeId },
          select: { recipeVersionId: true },
        });
        for (const parent of parents) next.add(parent.recipeVersionId);
      }
      frontier = [...next].filter((id) => !done.has(id));
    }
    return [...done];
  }

  // --------------------------------------------------------------- lookups

  private async publishedVersionOf(
    tx: Prisma.TransactionClient,
    recipeId: string,
  ): Promise<{ id: string; yieldUnitId: string } | null> {
    const versions = await tx.recipeVersion.findMany({
      where: { recipeId },
      select: { id: true, version: true, status: true, yieldUnitId: true },
    });
    // D-17-08: the effective version is the one whose status is `published`.
    // No dates, no ordering, no fallback to a draft or superseded version.
    const published = selectPublishedVersion(
      versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
      })),
    );
    if (!published) return null;
    const match = versions.find((v) => v.id === published.id)!;
    return { id: match.id, yieldUnitId: match.yieldUnitId };
  }

  /**
   * Factor converting `fromUnitId` into the stock item's BASE unit.
   *
   * An item-specific conversion wins over a generic one: `uom_conversions` is
   * keyed `(from, to, stock_item_id)` precisely so "1 bunch of parsley" can
   * differ from "1 bunch of mint". Returns `null` when no conversion exists —
   * which is a GAP, never an assumed 1, because assuming 1 would silently price
   * grams as kilograms.
   */
  private async conversionToStockBaseUnit(
    tx: Prisma.TransactionClient,
    stockItemId: string,
    fromUnitId: string,
  ): Promise<string | null> {
    const item = await tx.stockItem.findUnique({
      where: { id: stockItemId },
      select: { baseUnitId: true },
    });
    if (!item) return null;
    if (item.baseUnitId === fromUnitId) return '1';

    const conversions = await tx.uomConversion.findMany({
      where: { fromUnitId, toUnitId: item.baseUnitId },
      select: { factor: true, stockItemId: true },
    });
    const specific = conversions.find((c) => c.stockItemId === stockItemId);
    const generic = conversions.find((c) => c.stockItemId === null);
    const chosen = specific ?? generic;
    return chosen ? chosen.factor.toFixed(10) : null;
  }

  /** Same rule, between two arbitrary units (a sub-recipe's yield unit). */
  private async conversionBetweenUnits(
    tx: Prisma.TransactionClient,
    fromUnitId: string,
    toUnitId: string,
  ): Promise<string | null> {
    if (fromUnitId === toUnitId) return '1';
    const conversion = await tx.uomConversion.findFirst({
      where: { fromUnitId, toUnitId, stockItemId: null },
      select: { factor: true },
    });
    return conversion ? conversion.factor.toFixed(10) : null;
  }
}

function dedupeGaps(gaps: readonly CostGap[]): CostGap[] {
  const seen = new Set<string>();
  const out: CostGap[] = [];
  for (const gap of gaps) {
    const key = `${gap.lineId}:${gap.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

/** Exposed for the Sales snapshot path; keeps the rounding rule in one place. */
export function unitCostToMinorUnits(perYieldUnit: Rational): bigint {
  return toMinorUnits(perYieldUnit, RoundingMode.HALF_UP);
}

/** A zero cost, used ONLY where BR-MNU-012 genuinely authorises one. */
export const ZERO_COST: Rational = rational(0n);
