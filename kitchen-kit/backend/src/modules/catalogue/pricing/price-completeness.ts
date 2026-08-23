import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';

/**
 * C-11 — the SRS §7.3 #7 MenuItem pricing invariant:
 *
 *   "≥1 variant; every variant priced in every active price list"
 *
 * **C-11 was REOPENED AND AMENDED (2026-08-19)**, then clarified. The binding
 * rule now implemented here:
 *
 *   - `active` means the ADMINISTRATIVE status `price_lists.status = 'active'`;
 *   - completeness is required WHENEVER a list is administratively active;
 *   - temporal eligibility is a SEPARATE concern — `valid_from` / `valid_to` /
 *     recurrence decide whether an active list participates in resolution at an
 *     instant, NOT whether it must be complete;
 *   - a future-dated list must therefore be complete BEFORE becoming active;
 *   - a `scheduled` or `expired` list MAY be incomplete;
 *   - no operation may leave an active list incomplete, in either direction.
 *
 * The original C-11 cited BR-MNU-012 as justification for not blocking. That
 * citation was withdrawn: BR-MNU-012 concerns incomplete **recipes** and
 * **cost** only and has no textual link to pricing. It must not be used to
 * weaken pricing completeness.
 *
 * This is the ENFORCEMENT mechanism — blocking, inside the caller's
 * transaction. `CatalogueCompletenessService` remains supplemental reporting.
 *
 * Scope note: only ACTIVE variants are covered. An inactive variant is not
 * sellable, so requiring a price for it would block ordinary catalogue
 * housekeeping without protecting any sale.
 */

/** One (active list, active variant) pair that has no price entry. */
export interface CompletenessGap {
  readonly priceListId: string;
  readonly priceListName: string;
  readonly menuItemVariantId: string;
}

export interface CompletenessProbe {
  /** Restrict to one list — used when activating that list. */
  readonly priceListId?: string;
  /**
   * Treat this list as active even if it is not yet persisted as such. The
   * activation path MUST use this: filtering on `status = 'active'` alone would
   * exclude the very list being activated, and the check would vacuously pass.
   */
  readonly assumeListActive?: string;
  /** Restrict to one variant — used when creating/activating that variant. */
  readonly menuItemVariantId?: string;
  /**
   * Treat this variant as active even if not yet persisted as such. Used by the
   * variant-activation path, which must evaluate the POST-change world.
   */
  readonly assumeVariantActive?: string;
}

/**
 * Find every (administratively active list × active variant) pair with no price.
 *
 * Runs inside the caller's transaction and therefore under RLS: it can only see
 * — and can only report on — the acting tenant's rows.
 */
export async function findCompletenessGaps(
  tx: Prisma.TransactionClient,
  probe: CompletenessProbe = {},
): Promise<CompletenessGap[]> {
  const activeLists = await tx.priceList.findMany({
    where: {
      ...(probe.assumeListActive !== undefined
        ? { OR: [{ status: 'active' }, { id: probe.assumeListActive }] }
        : { status: 'active' }),
      ...(probe.priceListId !== undefined ? { id: probe.priceListId } : {}),
    },
    select: { id: true, name: true },
  });
  if (activeLists.length === 0) {
    return [];
  }

  const variants = await tx.menuItemVariant.findMany({
    where: {
      ...(probe.menuItemVariantId !== undefined
        ? { id: probe.menuItemVariantId }
        : {}),
      ...(probe.assumeVariantActive !== undefined
        ? { OR: [{ isActive: true }, { id: probe.assumeVariantActive }] }
        : { isActive: true }),
    },
    select: { id: true },
  });
  if (variants.length === 0) {
    return [];
  }

  const listIds = activeLists.map((l) => l.id);
  const variantIds = variants.map((v) => v.id);
  const entries = await tx.priceEntry.findMany({
    where: {
      priceListId: { in: listIds },
      menuItemVariantId: { in: variantIds },
    },
    select: { priceListId: true, menuItemVariantId: true },
  });

  const priced = new Set(
    entries.map((e) => `${e.priceListId}::${e.menuItemVariantId}`),
  );

  const gaps: CompletenessGap[] = [];
  for (const list of activeLists) {
    for (const variantId of variantIds) {
      if (!priced.has(`${list.id}::${variantId}`)) {
        gaps.push({
          priceListId: list.id,
          priceListName: list.name,
          menuItemVariantId: variantId,
        });
      }
    }
  }
  return gaps;
}

/** Render a gap list into an operator-actionable message. */
function describeGaps(gaps: readonly CompletenessGap[]): string {
  const shown = gaps
    .slice(0, 5)
    .map(
      (g) =>
        `"${g.priceListName}" is missing a price for variant ${g.menuItemVariantId}`,
    )
    .join('; ');
  const more = gaps.length > 5 ? ` (and ${gaps.length - 5} more)` : '';
  return `${shown}${more}`;
}

/**
 * Block the operation when it would leave an active price list incomplete.
 *
 * @throws ConflictException — 409, matching the repository's convention for a
 *         state conflict rather than a malformed request.
 */
export async function assertPriceCompleteness(
  tx: Prisma.TransactionClient,
  probe: CompletenessProbe,
  context: string,
): Promise<void> {
  const gaps = await findCompletenessGaps(tx, probe);
  if (gaps.length > 0) {
    throw new ConflictException(
      `${context} SRS §7.3 requires every active variant to be priced in every ` +
        `active price list (C-11 as amended): ${describeGaps(gaps)}. ` +
        `Add the missing price entries, or keep the price list non-active until it is complete.`,
    );
  }
}
