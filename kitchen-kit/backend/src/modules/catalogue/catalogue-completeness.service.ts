import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * C-11 — the SRS §7.3 #7 MenuItem invariant, "≥1 variant; every variant priced
 * in every active price list", implemented as a VALIDATED BUSINESS INVARIANT,
 * NOT a database hard constraint.
 *
 * Rationale (ratified): the second clause is a cross-aggregate, time-dependent
 * condition. Enforcing it relationally would mean either blocking variant
 * creation until every active price list has an entry, or blocking price-list
 * creation until every variant is priced — a circular write dependency. It also
 * contradicts BR-MNU-012's progressive-precision philosophy, which explicitly
 * permits selling an item whose supporting data is incomplete.
 *
 * So: creation never blocks, and this service REPORTS the incomplete conditions.
 */
@Injectable()
export class CatalogueCompletenessService {
  constructor(private readonly prisma: PrismaService) {}

  async report(tenantId: string): Promise<{
    itemsWithoutActiveVariant: string[];
    unpricedVariants: { variantId: string; menuItemId: string }[];
    sellable: boolean;
  }> {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const items = await tx.menuItem.findMany({
        where: { isActive: true },
        select: {
          id: true,
          variants: { where: { isActive: true }, select: { id: true } },
        },
      });
      const itemsWithoutActiveVariant = items
        .filter((i) => i.variants.length === 0)
        .map((i) => i.id);

      // A variant is "unpriced" when no price entry exists for it in any price
      // list of this tenant. Price-list applicability (window/recurrence) is not
      // evaluated here — no source defines the window format.
      const variants = await tx.menuItemVariant.findMany({
        where: { isActive: true },
        select: {
          id: true,
          menuItemId: true,
          priceEntries: { select: { id: true }, take: 1 },
        },
      });
      const unpricedVariants = variants
        .filter((v) => v.priceEntries.length === 0)
        .map((v) => ({ variantId: v.id, menuItemId: v.menuItemId }));

      return {
        itemsWithoutActiveVariant,
        unpricedVariants,
        sellable:
          itemsWithoutActiveVariant.length === 0 &&
          unpricedVariants.length === 0,
      };
    });
  }
}
