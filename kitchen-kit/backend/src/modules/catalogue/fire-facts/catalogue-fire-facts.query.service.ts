import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  CatalogueFireFacts,
  CatalogueFireFactsQuery,
  CatalogueFireFactsQueryInput,
} from '../contract/fire-facts.query';

/**
 * PRIVATE Prisma-backed implementation of `CatalogueFireFactsQuery`
 * (`catalogue/contract/fire-facts.query.ts`). Bound to
 * `CATALOGUE_FIRE_FACTS_QUERY` only inside `CatalogueModule`
 * (`useExisting`) — never imported directly by a consumer; see
 * `module-boundaries.spec.ts`'s contract-purity assertions.
 */
@Injectable()
export class CatalogueFireFactsQueryService implements CatalogueFireFactsQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: CatalogueFireFactsQueryInput,
  ): Promise<ReadonlyMap<string, CatalogueFireFacts>> {
    const menuItemIds = [...new Set(input.menuItemIds)];
    const result = new Map<string, CatalogueFireFacts>();
    if (menuItemIds.length === 0) return result;

    const [items, placements] = await Promise.all([
      tx.menuItem.findMany({
        where: { tenantId: input.tenantId, id: { in: menuItemIds } },
        select: { id: true, kitchenNames: true },
      }),
      tx.menuItemPlacement.findMany({
        where: { tenantId: input.tenantId, menuItemId: { in: menuItemIds } },
        select: { menuItemId: true, categoryId: true },
      }),
    ]);

    const categoriesByItem = new Map<string, Set<string>>();
    for (const placement of placements) {
      const bucket =
        categoriesByItem.get(placement.menuItemId) ?? new Set<string>();
      bucket.add(placement.categoryId);
      categoriesByItem.set(placement.menuItemId, bucket);
    }

    for (const item of items) {
      const kitchenNames = item.kitchenNames as Record<string, unknown>;
      const hasKitchenName =
        kitchenNames !== null &&
        typeof kitchenNames === 'object' &&
        Object.keys(kitchenNames).length > 0;

      result.set(item.id, {
        menuItemId: item.id,
        categoryIds: [...(categoriesByItem.get(item.id) ?? [])].sort(),
        kitchenName: hasKitchenName ? kitchenNames : null,
      });
    }

    return result;
  }
}
