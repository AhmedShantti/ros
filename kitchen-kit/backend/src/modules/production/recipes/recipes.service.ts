import { BadRequestException, Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { RecipeScope, RecipeType } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { resolveRecipeByScope, ScopedRecipe } from '../recipe-graph';

export interface CreateRecipeInput {
  scope: RecipeScope;
  brandId?: string;
  branchId?: string;
  recipeType: RecipeType;
  menuItemVariantId?: string;
  stockItemId?: string;
}

const TARGET_NOT_FOUND =
  'Brand, branch, menu item variant or stock item not found.';

/**
 * Recipe identity (SRS §7.4.4) — the logical recipe, stable across versions.
 *
 * `POST /recipes` is a RATIFIED API DEVIATION (GAP-1, Option A): SRS §26.3
 * defines version creation but no operation that creates a `production.recipes`
 * row. Recipes are therefore NEVER auto-created from version creation; an
 * unknown recipe id stays a 404.
 *
 * Cross-tenant references are blocked by composite FKs (D-17-02), which surface
 * as P2003 and are mapped to 404 so another tenant's ids are indistinguishable
 * from ids that never existed.
 */
@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * D-17-03 scope rules and the §7.4.4 target mapping, validated before the
   * write so the caller gets a 400 rather than a raw CHECK violation. The
   * database CHECKs (`ck_recipe_scope`, `ck_recipe_target`) remain the
   * authority — this is defence in depth, never the sole guarantee.
   */
  private assertShape(input: CreateRecipeInput): void {
    const { scope, brandId, branchId, recipeType } = input;
    if (scope === 'tenant' && (brandId || branchId)) {
      throw new BadRequestException(
        'Tenant-scoped recipes must not carry a brandId or branchId.',
      );
    }
    if (scope === 'brand' && (!brandId || branchId)) {
      throw new BadRequestException(
        'Brand-scoped recipes require exactly a brandId.',
      );
    }
    if (scope === 'branch' && (!branchId || brandId)) {
      throw new BadRequestException(
        'Branch-scoped recipes require exactly a branchId.',
      );
    }

    const wantsVariant = recipeType === 'menu_item';
    const hasVariant = Boolean(input.menuItemVariantId);
    const hasStockItem = Boolean(input.stockItemId);
    if (wantsVariant && (!hasVariant || hasStockItem)) {
      throw new BadRequestException(
        'A menu_item recipe requires exactly a menuItemVariantId.',
      );
    }
    if (!wantsVariant && (!hasStockItem || hasVariant)) {
      throw new BadRequestException(
        `A ${recipeType} recipe requires exactly a stockItemId.`,
      );
    }
  }

  async create(tenantId: string, actorId: string, input: CreateRecipeInput) {
    this.assertShape(input);
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const recipe = await tx.recipe.create({
            data: {
              id: newId(),
              tenantId,
              scope: input.scope,
              brandId: input.brandId ?? null,
              branchId: input.branchId ?? null,
              recipeType: input.recipeType,
              menuItemVariantId: input.menuItemVariantId ?? null,
              stockItemId: input.stockItemId ?? null,
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.RECIPE_CREATED,
            entityType: AUDIT_ENTITY.RECIPE,
            entityId: recipe.id,
            actorType: 'user',
            actorId,
            metadata: {
              scope: recipe.scope,
              recipeType: recipe.recipeType,
              brandId: recipe.brandId,
              branchId: recipe.branchId,
              menuItemVariantId: recipe.menuItemVariantId,
              stockItemId: recipe.stockItemId,
            },
          });
          return recipe;
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, TARGET_NOT_FOUND);
    }
  }

  list(tenantId: string, filter?: { recipeType?: RecipeType }) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.recipe.findMany({
        where: filter?.recipeType ? { recipeType: filter.recipeType } : {},
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** Returns null rather than throwing; callers decide between 404 and a gate. */
  findById(tenantId: string, recipeId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.recipe.findUnique({ where: { id: recipeId } }),
    );
  }

  /**
   * D-17-03 scope precedence (branch > brand > tenant) applied to recipe
   * IDENTITY for one target. Documented as analogy-derived from FR-PLT-025 —
   * not a recipe-specific SRS requirement.
   *
   * Version selection is deliberately NOT performed here; see
   * `RecipeVersionsService.effectiveVersion`, which applies D-17-08.
   */
  async resolveIdentity(
    tenantId: string,
    target: { menuItemVariantId?: string; stockItemId?: string },
    context: { branchId?: string; brandId?: string },
  ): Promise<ScopedRecipe | null> {
    const candidates = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.recipe.findMany({
        where: {
          ...(target.menuItemVariantId
            ? { menuItemVariantId: target.menuItemVariantId }
            : {}),
          ...(target.stockItemId ? { stockItemId: target.stockItemId } : {}),
        },
        select: { id: true, scope: true, brandId: true, branchId: true },
      }),
    );
    return resolveRecipeByScope(candidates, context);
  }
}
