import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CompletenessGap,
  findCompletenessGaps,
} from './pricing/price-completeness';

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
 * **UPDATED for the C-11 AMENDMENT (2026-08-19).** C-11 was reopened: an
 * administratively ACTIVE price list may no longer be incomplete, and
 * `price-completeness.ts` now BLOCKS the operations that would make it so. This
 * service is therefore supplemental reporting, not the enforcement mechanism.
 *
 * Its `unpricedVariants` check was also strengthened. It previously flagged a
 * variant only when it had NO price entry in ANY list — weaker than the §7.3 #7
 * invariant states. It now reports the exact (active list × active variant)
 * pairs that lack a price, which is what "every variant priced in every active
 * price list" actually means.
 */
@Injectable()
export class CatalogueCompletenessService {
  constructor(private readonly prisma: PrismaService) {}

  async report(tenantId: string): Promise<{
    itemsWithoutActiveVariant: string[];
    unpricedVariants: { variantId: string; menuItemId: string }[];
    /** C-11 amended: exact (active list x active variant) pairs lacking a price. */
    activeListGaps: CompletenessGap[];
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

      // C-11 amended: the invariant is per ACTIVE price list, not "any list".
      const activeListGaps = await findCompletenessGaps(tx);

      return {
        itemsWithoutActiveVariant,
        unpricedVariants,
        activeListGaps,
        sellable:
          itemsWithoutActiveVariant.length === 0 &&
          unpricedVariants.length === 0 &&
          activeListGaps.length === 0,
      };
    });
  }
}
