/**
 * Production's implementation of the P1F-2 `ProductionConsumptionQuery`
 * contract (`../contract/consumption.contract.ts`). Lives OUTSIDE
 * `contract/` per the module-boundary rule (contract/ is interface-only).
 *
 * Reuses `recipe-cost.ts`'s depth guard (`MAX_RECIPE_DEPTH`), gap-reason
 * taxonomy, and `RecipeExpansionError`, and `recipe-graph.ts`'s
 * `selectPublishedVersion` — the SAME traversal discipline
 * `RecipeCostService.cost()` already established, applied here to QUANTITY
 * expansion instead of COST expansion (no money, ever, in this file).
 */

import { Injectable } from '@nestjs/common';
import {
  ONE,
  Rational,
  ZERO,
  add,
  divide,
  fromExactDecimal,
  multiply,
  rational,
} from '../../../common/money/rational';
import { parseExactDecimal } from '../../../common/money/rounding';
import { Prisma } from '../../../generated/prisma/client';
import { selectPublishedVersion } from '../recipe-graph';
import type {
  ConsumptionGap,
  DroppedModifierEffect,
  PinnedConversion,
  PlanConsumptionInput,
  PlanConsumptionLineResult,
  PlanConsumptionResult,
  PlannedComponent,
  ProductionConsumptionQuery,
  ResolveConsumptionBasisInput,
  ResolveConsumptionBasisResult,
  ResolvedModifierEffect,
} from '../contract/consumption.contract';
import { ConsumptionConversionGapError } from '../contract/consumption-gap.errors';
import { MAX_RECIPE_DEPTH, RecipeCostError } from './recipe-cost';

/** Mirrors `RecipeCostService`'s own depth/cycle failure — see recipe-cost.service.ts. */
export class RecipeExpansionError extends RecipeCostError {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeExpansionError';
  }
}

const HUNDRED = rational(100n);

function exact(value: string): Rational {
  return fromExactDecimal(parseExactDecimal(value));
}

/** Render a Rational as a fixed 6dp DECIMAL(18,6) string, single rounding point. */
function toDecimal6(value: Rational): string {
  const SCALE = 1_000_000n;
  const scaled = (value.num * SCALE) / value.den;
  const remainder = (value.num * SCALE) % value.den;
  // HALF_UP on the residual (value is always >= 0 by the time this is called).
  const rounded = remainder * 2n >= value.den ? scaled + 1n : scaled;
  const whole = rounded / SCALE;
  const frac = (rounded % SCALE).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

interface RecipeLineRow {
  componentType: 'stock_item' | 'sub_recipe';
  stockItemId: string | null;
  subRecipeId: string | null;
  quantity: Prisma.Decimal;
  unitId: string;
  wastagePercentage: Prisma.Decimal;
}

interface VersionFacts {
  recipeId: string;
  yieldQuantity: Rational;
  yieldPercentage: Rational;
  yieldUnitId: string;
}

@Injectable()
export class ConsumptionResolutionService implements ProductionConsumptionQuery {
  // =========================================================== LINE CAPTURE

  async resolveConsumptionBasis(
    tx: Prisma.TransactionClient,
    input: ResolveConsumptionBasisInput,
  ): Promise<ResolveConsumptionBasisResult> {
    const closure = new Map<string, number>();
    const conversionNeeds = new Map<
      string,
      { stockItemId: string; unitId: string }
    >();
    const settled = new Set<string>();

    if (input.recipeVersionId) {
      await this.walkClosure(
        tx,
        input.recipeVersionId,
        closure,
        conversionNeeds,
        [],
        0,
        settled,
      );
    }

    const droppedModifierEffects: DroppedModifierEffect[] = [];
    const modifierEffects = await this.resolveModifierEffects(
      tx,
      input.modifierIds,
      closure,
      conversionNeeds,
      settled,
      droppedModifierEffects,
    );

    const conversions = await this.resolveConversions(tx, [
      ...conversionNeeds.values(),
    ]);

    return {
      versionClosure: [...closure.entries()].map(
        ([recipeVersionId, depth]) => ({
          recipeVersionId,
          depth,
        }),
      ),
      modifierEffects,
      conversions,
      droppedModifierEffects,
    };
  }

  private async publishedVersionOf(
    tx: Prisma.TransactionClient,
    recipeId: string,
  ): Promise<{ id: string } | null> {
    const versions = await tx.recipeVersion.findMany({
      where: { recipeId },
      select: { id: true, version: true, status: true },
    });
    const published = selectPublishedVersion(
      versions.map((v) => ({ id: v.id, version: v.version, status: v.status })),
    );
    return published ? { id: published.id } : null;
  }

  private async walkClosure(
    tx: Prisma.TransactionClient,
    versionId: string,
    closure: Map<string, number>,
    conversionNeeds: Map<string, { stockItemId: string; unitId: string }>,
    visiting: readonly string[],
    depth: number,
    settled: Set<string>,
  ): Promise<void> {
    if (depth > MAX_RECIPE_DEPTH) {
      throw new RecipeExpansionError(
        `Recipe expansion exceeded the depth limit of ${MAX_RECIPE_DEPTH} (BR-MNU-003).`,
      );
    }
    const existingDepth = closure.get(versionId);
    if (existingDepth === undefined || existingDepth > depth) {
      closure.set(versionId, depth);
    }
    if (settled.has(versionId)) return;
    settled.add(versionId);

    const version = await tx.recipeVersion.findUnique({
      where: { id: versionId },
      select: {
        recipeId: true,
        lines: {
          select: {
            componentType: true,
            stockItemId: true,
            subRecipeId: true,
            unitId: true,
          },
        },
      },
    });
    if (!version) return;

    if (visiting.includes(version.recipeId)) {
      throw new RecipeExpansionError(
        `Recipe ${version.recipeId} appears inside its own expansion. ` +
          'BR-MNU-001 forbids this; the recipe graph is corrupt.',
      );
    }

    for (const line of version.lines) {
      if (line.componentType === 'stock_item' && line.stockItemId) {
        conversionNeeds.set(`${line.stockItemId}|${line.unitId}`, {
          stockItemId: line.stockItemId,
          unitId: line.unitId,
        });
      } else if (line.componentType === 'sub_recipe' && line.subRecipeId) {
        const published = await this.publishedVersionOf(tx, line.subRecipeId);
        // An unpublished sub-recipe is simply absent from the closure —
        // planConsumption records the structural gap at Completion time.
        if (published) {
          await this.walkClosure(
            tx,
            published.id,
            closure,
            conversionNeeds,
            [...visiting, version.recipeId],
            depth + 1,
            settled,
          );
        }
      }
    }
  }

  private async resolveModifierEffects(
    tx: Prisma.TransactionClient,
    modifierIds: readonly string[],
    closure: Map<string, number>,
    conversionNeeds: Map<string, { stockItemId: string; unitId: string }>,
    settled: Set<string>,
    droppedModifierEffects: DroppedModifierEffect[],
  ): Promise<Map<string, ResolvedModifierEffect[]>> {
    const out = new Map<string, ResolvedModifierEffect[]>();
    if (modifierIds.length === 0) return out;

    const rows = await tx.modifierRecipeEffect.findMany({
      where: { modifierId: { in: [...modifierIds] } },
      orderBy: { sequence: 'asc' },
    });

    for (const modifierId of modifierIds) {
      const resolved: ResolvedModifierEffect[] = [];
      for (const e of rows.filter((r) => r.modifierId === modifierId)) {
        if (e.componentType === 'stock_item') {
          if (e.stockItemId && e.unitId) {
            conversionNeeds.set(`${e.stockItemId}|${e.unitId}`, {
              stockItemId: e.stockItemId,
              unitId: e.unitId,
            });
          }
          resolved.push({
            operation: e.operation,
            componentType: 'stock_item',
            stockItemId: e.stockItemId,
            subRecipeVersionId: null,
            quantity: e.quantity ? e.quantity.toFixed(6) : null,
            unitId: e.unitId,
            sequence: e.sequence,
          });
          continue;
        }
        // sub_recipe — always `add` (the XOR CHECK ties remove_all to stock_item).
        const published = e.subRecipeId
          ? await this.publishedVersionOf(tx, e.subRecipeId)
          : null;
        if (!published) {
          // No published version to pin: this effect cannot be captured — the
          // XOR CHECK on `sales.order_line_modifier_effects` REQUIRES a
          // non-null sub_recipe_version_id for a sub_recipe row, so an
          // unpublished target is dropped from the snapshot entirely rather
          // than persisted with a null pin. The sale still proceeds; this one
          // modifier effect contributes nothing to depletion — but the drop
          // itself is returned here (P1F-2 acceptance closure §5) so the
          // caller can record it in the line-capture audit trail rather than
          // it vanishing with zero evidence.
          droppedModifierEffects.push({
            modifierId,
            sequence: e.sequence,
            reason: 'no_published_version',
          });
          continue;
        }
        await this.walkClosure(
          tx,
          published.id,
          closure,
          conversionNeeds,
          [],
          1,
          settled,
        );
        resolved.push({
          operation: e.operation,
          componentType: 'sub_recipe',
          stockItemId: null,
          subRecipeVersionId: published.id,
          quantity: e.quantity ? e.quantity.toFixed(6) : null,
          unitId: e.unitId,
          sequence: e.sequence,
        });
      }
      out.set(modifierId, resolved);
    }
    return out;
  }

  private async resolveConversions(
    tx: Prisma.TransactionClient,
    needs: readonly { stockItemId: string; unitId: string }[],
  ): Promise<PinnedConversion[]> {
    if (needs.length === 0) return [];
    const stockItemIds = [...new Set(needs.map((n) => n.stockItemId))];
    const items = await tx.stockItem.findMany({
      where: { id: { in: stockItemIds } },
      select: { id: true, baseUnitId: true },
    });
    const baseUnitById = new Map(items.map((i) => [i.id, i.baseUnitId]));

    const out: PinnedConversion[] = [];
    for (const need of needs) {
      const baseUnitId = baseUnitById.get(need.stockItemId);
      if (!baseUnitId) continue;
      if (need.unitId === baseUnitId) {
        out.push({
          stockItemId: need.stockItemId,
          fromUnitId: need.unitId,
          baseUnitId,
          factor: '1',
        });
        continue;
      }
      const conversions = await tx.uomConversion.findMany({
        where: { fromUnitId: need.unitId, toUnitId: baseUnitId },
        select: { factor: true, stockItemId: true },
      });
      const specific = conversions.find(
        (c) => c.stockItemId === need.stockItemId,
      );
      const generic = conversions.find((c) => c.stockItemId === null);
      const chosen = specific ?? generic;
      if (chosen) {
        out.push({
          stockItemId: need.stockItemId,
          fromUnitId: need.unitId,
          baseUnitId,
          factor: chosen.factor.toFixed(10),
        });
      }
      // No conversion found: simply omitted. This becomes a `no_unit_conversion`
      // VALUATION gap (THROW) only if `planConsumption` actually needs it.
    }
    return out;
  }

  // ============================================================ COMPLETION

  async planConsumption(
    tx: Prisma.TransactionClient,
    input: PlanConsumptionInput,
  ): Promise<PlanConsumptionResult> {
    const allPinnedVersionIds = [
      ...new Set(input.lines.flatMap((l) => l.pinnedVersionIds)),
    ];

    const versionRows = allPinnedVersionIds.length
      ? await tx.recipeVersion.findMany({
          where: { id: { in: allPinnedVersionIds } },
          select: {
            id: true,
            recipeId: true,
            yieldQuantity: true,
            yieldPercentage: true,
            yieldUnitId: true,
          },
        })
      : [];
    const versionsById = new Map<string, VersionFacts>(
      versionRows.map((v) => [
        v.id,
        {
          recipeId: v.recipeId,
          yieldQuantity: exact(v.yieldQuantity.toFixed(6)),
          yieldPercentage: exact(v.yieldPercentage.toFixed(2)),
          yieldUnitId: v.yieldUnitId,
        },
      ]),
    );

    const lineRows = allPinnedVersionIds.length
      ? await tx.recipeLine.findMany({
          where: { recipeVersionId: { in: allPinnedVersionIds } },
          orderBy: { sequence: 'asc' },
          select: {
            recipeVersionId: true,
            componentType: true,
            stockItemId: true,
            subRecipeId: true,
            quantity: true,
            unitId: true,
            wastagePercentage: true,
          },
        })
      : [];
    const linesByVersionId = new Map<string, RecipeLineRow[]>();
    for (const l of lineRows) {
      const arr = linesByVersionId.get(l.recipeVersionId) ?? [];
      arr.push(l);
      linesByVersionId.set(l.recipeVersionId, arr);
    }

    const perLine: PlanConsumptionLineResult[] = [];
    for (const line of input.lines) {
      perLine.push(this.planLine(line, versionsById, linesByVersionId));
    }
    return { perLine };
  }

  private planLine(
    line: PlanConsumptionInput['lines'][number],
    versionsById: Map<string, VersionFacts>,
    linesByVersionId: Map<string, RecipeLineRow[]>,
  ): PlanConsumptionLineResult {
    const versionIdByRecipeId = new Map<string, string>();
    for (const vId of line.pinnedVersionIds) {
      const facts = versionsById.get(vId);
      if (facts) versionIdByRecipeId.set(facts.recipeId, vId);
    }
    const conversionsByKey = new Map<string, PinnedConversion>(
      line.conversions.map((c) => [`${c.stockItemId}|${c.fromUnitId}`, c]),
    );
    const baseUnitByStockItemId = new Map<string, string>(
      line.conversions.map((c) => [c.stockItemId, c.baseUnitId]),
    );

    const acc = new Map<string, Rational>();
    const gaps: ConsumptionGap[] = [];
    const lineQty = exact(line.quantity);

    // 1 — expand the base recipe from the PINNED closure.
    if (line.recipeVersionId) {
      this.expandVersion(
        line.recipeVersionId,
        lineQty,
        linesByVersionId,
        versionsById,
        versionIdByRecipeId,
        conversionsByKey,
        acc,
        gaps,
        [],
        0,
      );
    }
    // Absent recipe (line.recipeVersionId === null): 0 depletion (BR-MNU-012), no gap.

    // 2 — already aggregated per stock_item WITHIN the line via the Map.
    // 3 — apply ALL REMOVE_ALL first (strictly precedes addition).
    for (const effect of line.modifierEffects) {
      if (effect.operation === 'remove_all' && effect.stockItemId) {
        acc.delete(effect.stockItemId);
      }
    }
    // 4 — apply ALL ADD.
    for (const effect of line.modifierEffects) {
      if (effect.operation !== 'add') continue;
      // ADD scaling: effect.quantity x order_line_modifiers.quantity x
      // order_lines.quantity — PER SOLD PORTION, no yield/wastage uplift.
      const scale = multiply(
        multiply(
          exact(effect.quantity ?? '0'),
          rational(BigInt(effect.modifierSelectionQuantity)),
        ),
        lineQty,
      );
      if (
        effect.componentType === 'stock_item' &&
        effect.stockItemId &&
        effect.unitId
      ) {
        const conv = conversionsByKey.get(
          `${effect.stockItemId}|${effect.unitId}`,
        );
        if (!conv) {
          throw new ConsumptionConversionGapError(
            `No pinned unit conversion for modifier-added stock item ${effect.stockItemId} ` +
              `from unit ${effect.unitId}; cannot depute an exact base-unit quantity.`,
          );
        }
        const addQty = multiply(scale, exact(conv.factor));
        acc.set(
          effect.stockItemId,
          add(acc.get(effect.stockItemId) ?? ZERO, addQty),
        );
      } else if (
        effect.componentType === 'sub_recipe' &&
        effect.subRecipeVersionId
      ) {
        if (versionsById.has(effect.subRecipeVersionId)) {
          this.expandVersion(
            effect.subRecipeVersionId,
            scale,
            linesByVersionId,
            versionsById,
            versionIdByRecipeId,
            conversionsByKey,
            acc,
            gaps,
            [],
            1,
          );
        } else {
          gaps.push({ stockItemId: null, reason: 'no_published_version' });
        }
      }
    }

    // 5 — re-aggregate, drop non-positive.
    const components: PlannedComponent[] = [];
    for (const [stockItemId, qty] of acc) {
      if (qty.num <= 0n) continue;
      const unitId = baseUnitByStockItemId.get(stockItemId);
      if (!unitId) continue;
      components.push({
        stockItemId,
        quantityInBaseUnit: toDecimal6(qty),
        unitId,
      });
    }

    return { orderLineId: line.orderLineId, components, gaps };
  }

  private expandVersion(
    versionId: string,
    requiredYieldUnits: Rational,
    linesByVersionId: Map<string, RecipeLineRow[]>,
    versionsById: Map<string, VersionFacts>,
    versionIdByRecipeId: Map<string, string>,
    conversionsByKey: Map<string, PinnedConversion>,
    acc: Map<string, Rational>,
    gaps: ConsumptionGap[],
    visiting: readonly string[],
    depth: number,
  ): void {
    if (depth > MAX_RECIPE_DEPTH) {
      throw new RecipeExpansionError(
        `Recipe expansion exceeded the depth limit of ${MAX_RECIPE_DEPTH} (BR-MNU-003).`,
      );
    }
    const version = versionsById.get(versionId);
    if (!version) {
      gaps.push({ stockItemId: null, reason: 'no_published_version' });
      return;
    }
    if (visiting.includes(version.recipeId)) {
      throw new RecipeExpansionError(
        `Recipe ${version.recipeId} appears inside its own expansion. ` +
          'BR-MNU-001 forbids this; the recipe graph is corrupt.',
      );
    }
    const lines = linesByVersionId.get(versionId) ?? [];
    if (lines.length === 0) {
      gaps.push({ stockItemId: null, reason: 'no_components' });
      return;
    }

    // requiredYieldUnits / (yieldQuantity x yieldPercentage/100) — the SAME
    // divisor `RecipeCostService`'s `perYieldUnit = total / yieldQuantity`
    // (with `total` itself already divided by yieldPercentage/100) applies,
    // scaled by how many yield units of THIS version are actually needed.
    const perBatchFactor = divide(
      requiredYieldUnits,
      multiply(version.yieldQuantity, divide(version.yieldPercentage, HUNDRED)),
    );

    for (const line of lines) {
      const wastageFactor = add(
        ONE,
        divide(exact(line.wastagePercentage.toFixed(2)), HUNDRED),
      );
      if (line.componentType === 'stock_item' && line.stockItemId) {
        const conv = conversionsByKey.get(`${line.stockItemId}|${line.unitId}`);
        if (!conv) {
          throw new ConsumptionConversionGapError(
            `No pinned unit conversion for stock item ${line.stockItemId} from unit ` +
              `${line.unitId}; cannot depute an exact base-unit quantity.`,
          );
        }
        const quantityInBaseUnit = multiply(
          exact(line.quantity.toFixed(6)),
          exact(conv.factor),
        );
        const contribution = multiply(
          multiply(quantityInBaseUnit, wastageFactor),
          perBatchFactor,
        );
        acc.set(
          line.stockItemId,
          add(acc.get(line.stockItemId) ?? ZERO, contribution),
        );
      } else if (line.componentType === 'sub_recipe' && line.subRecipeId) {
        const subVersionId = versionIdByRecipeId.get(line.subRecipeId);
        if (!subVersionId) {
          gaps.push({ stockItemId: null, reason: 'no_published_version' });
          continue;
        }
        const subVersion = versionsById.get(subVersionId);
        if (!subVersion) {
          gaps.push({ stockItemId: null, reason: 'no_published_version' });
          continue;
        }
        // A sub-recipe line's unit MUST match its target's yield unit — no
        // pinned conversion exists for this (non-stock-item) axis, so a
        // mismatch fails closed rather than guessing a factor (documented
        // residual interpretation — P1F2E-A does not literally address it).
        if (line.unitId !== subVersion.yieldUnitId) {
          throw new ConsumptionConversionGapError(
            `Sub-recipe line unit ${line.unitId} does not match recipe ${line.subRecipeId}'s ` +
              `yield unit ${subVersion.yieldUnitId}; no pinned conversion exists for this axis.`,
          );
        }
        const subRequiredYieldUnits = multiply(
          multiply(exact(line.quantity.toFixed(6)), wastageFactor),
          perBatchFactor,
        );
        this.expandVersion(
          subVersionId,
          subRequiredYieldUnits,
          linesByVersionId,
          versionsById,
          versionIdByRecipeId,
          conversionsByKey,
          acc,
          gaps,
          [...visiting, version.recipeId],
          depth + 1,
        );
      }
    }
  }
}

// Re-export for tests that want to round-trip a Rational the same way the
// service does, without duplicating the rounding rule.
export { toDecimal6 };
