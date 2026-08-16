import {
  Recipe,
  RecipeLine,
  RecipeVersion,
  SubstituteGroup,
} from '../../generated/prisma/client';

/**
 * Read models. Decimals and BigInts are serialised as strings so 6-dp
 * quantities and minor-unit money survive JSON without precision loss.
 *
 * `effectiveFrom` IS returned — D-17-08 Q2 makes it informational, which means
 * "stored and displayed but never selected on". Returning it is the allowed
 * use; consulting it anywhere in selection is not.
 */
export function toRecipeView(r: Recipe) {
  return {
    id: r.id,
    scope: r.scope,
    brandId: r.brandId,
    branchId: r.branchId,
    recipeType: r.recipeType,
    menuItemVariantId: r.menuItemVariantId,
    stockItemId: r.stockItemId,
    createdAt: r.createdAt,
  };
}

export function toLineView(l: RecipeLine) {
  return {
    id: l.id,
    sequence: l.sequence,
    componentType: l.componentType,
    stockItemId: l.stockItemId,
    subRecipeId: l.subRecipeId,
    quantity: l.quantity.toString(),
    unitId: l.unitId,
    wastagePercentage: l.wastagePercentage.toString(),
    isOptional: l.isOptional,
    substituteGroupId: l.substituteGroupId,
  };
}

export function toVersionView(v: RecipeVersion & { lines?: RecipeLine[] }) {
  return {
    id: v.id,
    recipeId: v.recipeId,
    version: v.version,
    status: v.status,
    yieldQuantity: v.yieldQuantity.toString(),
    yieldUnitId: v.yieldUnitId,
    yieldPercentage: v.yieldPercentage.toString(),
    prepTimeSeconds: v.prepTimeSeconds,
    // D-17-05: never populated by this phase; surfaced so its emptiness is
    // observable rather than hidden.
    computedCost: v.computedCost === null ? null : v.computedCost.toString(),
    costComputedAt: v.costComputedAt,
    // Informational only (D-17-08 Q2).
    effectiveFrom: v.effectiveFrom,
    publishedBy: v.publishedBy,
    instructions: v.instructions,
    referenceImages: v.referenceImages,
    createdAt: v.createdAt,
    ...(v.lines ? { lines: v.lines.map(toLineView) } : {}),
  };
}

export function toGroupView(g: SubstituteGroup) {
  return { id: g.id, name: g.name };
}
