/**
 * "Recipes requiring completion" — the report BR-MNU-012 names.
 *
 * "An item MAY be sold with an incomplete or absent recipe. The System SHALL
 * permit the sale, SHALL record zero or partial cost, and SHALL list the item in
 * a 'recipes requiring completion' report."
 *
 * The first two clauses live in Sales line capture. THIS is the third, and it is
 * not optional: without it, progressive precision is just permanent
 * imprecision — the rationale is explicit that completeness must be "a visible,
 * nagging, gradually-improving metric", and a metric nobody can query is none.
 *
 * ── WHY IT LIVES IN PRODUCTION, NOT CATALOGUE ──────────────────────────────
 * `CatalogueCompletenessService` answers a different question — the C-11 pricing
 * invariant, "every active variant priced in every active price list". Recipe
 * completeness is Production Spec's own concern and shares none of its rules.
 * Merging them would put Catalogue in the business of reading recipe graphs, and
 * would let a change to one report silently move the other. They stay separate,
 * and BR-MNU-012 is never cited to weaken pricing completeness (the C-11
 * amendment removed that argument explicitly).
 *
 * ── WHAT "INCOMPLETE" MEANS HERE ───────────────────────────────────────────
 * The same STRUCTURAL test the cost engine uses, so the report and the sale can
 * never disagree: a published version with no components, or one naming a
 * sub-recipe that has no published version. A component Inventory cannot price
 * is NOT recipe incompleteness — that is a valuation gap, it refuses the sale
 * rather than reducing the cost, and it does not belong in a report about
 * recipes needing to be written.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveRecipeByScope, selectPublishedVersion } from '../recipe-graph';
import { MAX_RECIPE_DEPTH } from './recipe-cost';

export type RecipeCompletenessReason = 'absent_recipe' | 'incomplete_recipe';

export interface RecipeCompletenessEntry {
  readonly menuItemId: string;
  readonly variantId: string;
  readonly reason: RecipeCompletenessReason;
  /** The published version that is incomplete; null for `absent_recipe`. */
  readonly recipeVersionId: string | null;
  /** Why the definition is unfinished. Empty for `absent_recipe`. */
  readonly detail: readonly string[];
}

export interface RecipeCompletenessReport {
  /**
   * The branch the scope precedence was resolved for, or null for the tenant
   * view. D-17-03 makes recipes branch- or brand-scoped, so "which recipe
   * applies" is a question only a branch can answer precisely; the tenant view
   * answers "is there any tenant-scope recipe at all".
   */
  readonly branchId: string | null;
  readonly entries: readonly RecipeCompletenessEntry[];
  readonly absentCount: number;
  readonly incompleteCount: number;
  /** Active variants examined — the denominator of the completeness metric. */
  readonly sellableVariantCount: number;
}

@Injectable()
export class RecipeCompletenessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every sellable variant whose recipe is absent or unfinished.
   *
   * Runs entirely inside `withAuthContext`, so a variant, recipe or version
   * belonging to another tenant is invisible. An invisible recipe therefore
   * reads as ABSENT rather than leaking its existence — the report fails closed
   * in the same direction the sale does.
   */
  async report(
    tenantId: string,
    branchId?: string,
  ): Promise<RecipeCompletenessReport> {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      // A branch that is invisible under RLS — another tenant's, or a
      // malformed id — is a 404, not a silent fall-through to the tenant view.
      // Falling through would answer a different question than the one asked.
      let branch: { id: string; brandId: string } | null = null;
      if (branchId !== undefined) {
        branch = await tx.branch.findUnique({
          where: { id: branchId },
          select: { id: true, brandId: true },
        });
        if (!branch) throw new NotFoundException('Branch not found.');
      }

      // Only ACTIVE variants of ACTIVE items: an item that cannot be sold does
      // not need a recipe, and reporting it would bury the ones that do.
      const variants = await tx.menuItemVariant.findMany({
        where: { isActive: true, menuItem: { isActive: true } },
        select: { id: true, menuItemId: true },
        orderBy: { id: 'asc' },
      });
      if (variants.length === 0) {
        return this.empty(branch?.id ?? null);
      }

      const recipes = await tx.recipe.findMany({
        where: {
          recipeType: 'menu_item',
          menuItemVariantId: { in: variants.map((v) => v.id) },
        },
        select: {
          id: true,
          scope: true,
          brandId: true,
          branchId: true,
          menuItemVariantId: true,
        },
      });
      const byVariant = new Map<string, typeof recipes>();
      for (const recipe of recipes) {
        const key = recipe.menuItemVariantId!;
        byVariant.set(key, [...(byVariant.get(key) ?? []), recipe]);
      }

      // Resolve the applicable recipe identity per variant, reusing D-17-03's
      // precedence rather than restating it.
      const applicable = new Map<string, string>();
      const absent: RecipeCompletenessEntry[] = [];
      for (const variant of variants) {
        const candidates = byVariant.get(variant.id) ?? [];
        const resolved = resolveRecipeByScope(
          candidates.map((c) => ({
            id: c.id,
            scope: c.scope,
            brandId: c.brandId,
            branchId: c.branchId,
          })),
          { branchId: branch?.id ?? null, brandId: branch?.brandId ?? null },
        );
        if (!resolved) {
          absent.push({
            menuItemId: variant.menuItemId,
            variantId: variant.id,
            reason: 'absent_recipe',
            recipeVersionId: null,
            detail: [],
          });
          continue;
        }
        applicable.set(variant.id, resolved.id);
      }

      const published = await this.publishedVersions(tx, [
        ...new Set(applicable.values()),
      ]);

      const incomplete: RecipeCompletenessEntry[] = [];
      const structural = await this.structuralGaps(tx, [...published.values()]);

      for (const variant of variants) {
        const recipeId = applicable.get(variant.id);
        if (!recipeId) continue;
        const versionId = published.get(recipeId);
        if (!versionId) {
          // A recipe identity with nothing published has no definition in force.
          // The sale treats that as ABSENT, and so does this report — the two
          // must agree or the report stops predicting what a sale will record.
          absent.push({
            menuItemId: variant.menuItemId,
            variantId: variant.id,
            reason: 'absent_recipe',
            recipeVersionId: null,
            detail: [],
          });
          continue;
        }
        const detail = structural.get(versionId);
        if (detail && detail.length > 0) {
          incomplete.push({
            menuItemId: variant.menuItemId,
            variantId: variant.id,
            reason: 'incomplete_recipe',
            recipeVersionId: versionId,
            detail,
          });
        }
      }

      const entries = [...absent, ...incomplete].sort((a, b) =>
        a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
      );
      return {
        branchId: branch?.id ?? null,
        entries,
        absentCount: absent.length,
        incompleteCount: incomplete.length,
        sellableVariantCount: variants.length,
      };
    });
  }

  private empty(branchId: string | null): RecipeCompletenessReport {
    return {
      branchId,
      entries: [],
      absentCount: 0,
      incompleteCount: 0,
      sellableVariantCount: 0,
    };
  }

  /** recipeId -> published version id. D-17-08: status is the whole rule. */
  private async publishedVersions(
    tx: Prisma.TransactionClient,
    recipeIds: readonly string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (recipeIds.length === 0) return out;
    const versions = await tx.recipeVersion.findMany({
      where: { recipeId: { in: [...recipeIds] } },
      select: { id: true, recipeId: true, version: true, status: true },
    });
    const byRecipe = new Map<string, typeof versions>();
    for (const v of versions) {
      byRecipe.set(v.recipeId, [...(byRecipe.get(v.recipeId) ?? []), v]);
    }
    for (const [recipeId, candidates] of byRecipe) {
      const chosen = selectPublishedVersion(
        candidates.map((v) => ({
          id: v.id,
          version: v.version,
          status: v.status,
        })),
      );
      if (chosen) out.set(recipeId, chosen.id);
    }
    return out;
  }

  /**
   * versionId -> human-readable structural gaps.
   *
   * Walks sub-recipes breadth-first with ONE query per level rather than per
   * recipe — a hundred variants sharing a sauce should cost one round trip, not
   * a hundred. Bounded by the same BR-MNU-003 depth limit the cost engine uses,
   * so a corrupt graph terminates here too.
   */
  private async structuralGaps(
    tx: Prisma.TransactionClient,
    versionIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const gaps = new Map<string, string[]>();
    if (versionIds.length === 0) return gaps;

    // Level 0: the versions themselves.
    let frontier = [...new Set(versionIds)];
    // Which top-level version each frontier entry descends from, so a gap deep
    // in a sub-recipe is attributed to the variant the operator can act on.
    let owner = new Map<string, Set<string>>(
      frontier.map((id) => [id, new Set([id])]),
    );
    const seen = new Set<string>(frontier);

    const record = (versionId: string, message: string): void => {
      for (const root of owner.get(versionId) ?? []) {
        gaps.set(root, [...(gaps.get(root) ?? []), message]);
      }
    };

    for (
      let depth = 0;
      depth <= MAX_RECIPE_DEPTH && frontier.length > 0;
      depth++
    ) {
      const lines = await tx.recipeLine.findMany({
        where: { recipeVersionId: { in: frontier } },
        select: {
          recipeVersionId: true,
          componentType: true,
          subRecipeId: true,
        },
      });

      const withLines = new Set(lines.map((l) => l.recipeVersionId));
      for (const versionId of frontier) {
        if (!withLines.has(versionId)) {
          record(versionId, 'no_components');
        }
      }

      const subRecipeIds = [
        ...new Set(
          lines
            .filter((l) => l.componentType === 'sub_recipe' && l.subRecipeId)
            .map((l) => l.subRecipeId!),
        ),
      ];
      if (subRecipeIds.length === 0) break;

      const subPublished = await this.publishedVersions(tx, subRecipeIds);
      const nextOwner = new Map<string, Set<string>>();
      const nextFrontier: string[] = [];

      for (const line of lines) {
        if (line.componentType !== 'sub_recipe' || !line.subRecipeId) continue;
        const roots = owner.get(line.recipeVersionId) ?? new Set<string>();
        const subVersionId = subPublished.get(line.subRecipeId);
        if (!subVersionId) {
          record(line.recipeVersionId, 'no_published_version');
          continue;
        }
        if (seen.has(subVersionId)) continue;
        const inherited = nextOwner.get(subVersionId) ?? new Set<string>();
        for (const root of roots) inherited.add(root);
        nextOwner.set(subVersionId, inherited);
        nextFrontier.push(subVersionId);
      }

      for (const id of nextFrontier) seen.add(id);
      frontier = [...new Set(nextFrontier)];
      owner = nextOwner;
    }

    // De-duplicate the messages per root; the same reason twice adds nothing.
    for (const [root, messages] of gaps) {
      gaps.set(root, [...new Set(messages)].sort());
    }
    return gaps;
  }
}
