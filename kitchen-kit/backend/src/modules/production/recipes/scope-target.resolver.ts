import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/**
 * PRIVATE implementation of `PRODUCTION_RECIPE_TARGET_RESOLVER`.
 *
 * `ck_recipe_scope` guarantees exactly one of `brand_id`/`branch_id` is set for
 * brand/branch scope and both are NULL for tenant scope. A row that somehow
 * violated it would be UNSCOPEABLE, so it resolves to `null` rather than being
 * treated as tenant-wide.
 */
@Injectable()
export class RecipeTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const recipeId = input.keys.recipeId;
    if (!recipeId) return null;
    const recipe = await tx.recipe.findUnique({
      where: { id: recipeId },
      select: { scope: true, brandId: true, branchId: true },
    });
    if (!recipe) return null;
    if (recipe.scope === 'tenant') return { type: 'tenant' };
    if (recipe.scope === 'brand') {
      return recipe.brandId === null
        ? null
        : { type: 'brand', brandId: recipe.brandId };
    }
    return recipe.branchId === null
      ? null
      : { type: 'branch', branchId: recipe.branchId };
  }
}
