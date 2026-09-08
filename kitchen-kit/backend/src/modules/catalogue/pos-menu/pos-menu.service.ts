import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AvailabilityService } from '../availability/availability.service';
import { MenusService } from '../menus/menus.service';
import { PriceResolutionService } from '../pricing/price-resolution.service';

export interface PosMenuQuery {
  readonly branchId: string;
  /** The order type being rung, or null to resolve order-type-agnostic prices only. */
  readonly orderType?: string | null;
}

/**
 * DEMO-POS-MENU-BACKEND-P0 — the sellable-menu READ a POS session needs.
 *
 * Composes EXISTING catalogue domain logic rather than re-deriving any of it:
 * `MenusService.resolveForBranch` (branch assignment + active + priority,
 * FR-MNU-002/003), `PriceResolutionService.resolve` (the SAME FR-POS-040 tier
 * engine Sales runs at line-capture time — `OrderLinesService.addLine` is the
 * other caller), and `AvailabilityService.resolveBlocked` (the SAME narrow
 * FR-MNU-030/031 86 check `OrderLinesService.assertAvailable` evaluates).
 * Nothing here re-implements pricing or availability.
 *
 * Deliberately narrower than the admin catalogue reads it stands beside:
 * branch-scoped (never tenant-wide), active-only (no inactive/soft-deleted
 * rows), and no admin/back-office metadata (kitchen names, aggregator names,
 * tax class, revenue account code, cost). This is what makes it safe to expose
 * to a POS/PIN session that must never reach the admin catalogue routes
 * (FR-SEC-021) — see `CatalogueController.getPosMenu`.
 */
@Injectable()
export class PosMenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menus: MenusService,
    private readonly pricing: PriceResolutionService,
    private readonly availability: AvailabilityService,
  ) {}

  async getMenu(tenantId: string, query: PosMenuQuery) {
    const branchId = query.branchId;
    const orderType = query.orderType ?? null;

    // FR-MNU-002/003 — active menus assigned to this branch, priority order.
    // `resolveForBranch` never throws NotFound on its own: the branch here is
    // ALREADY tenant-safe (it came from the live terminal binding, not a
    // client-supplied param), so an empty/foreign result cannot arise.
    const { menus, ambiguous, warning } = await this.menus.resolveForBranch(
      tenantId,
      branchId,
    );
    const menuIds = menus.map((m) => m.id);
    if (menuIds.length === 0) {
      return {
        branchId,
        orderType,
        menus: [],
        categories: [],
        items: [],
        ambiguousMenuPriority: ambiguous,
        ...(warning ? { warning } : {}),
      };
    }

    const { categories, itemRows, placements, variantRows, links } =
      await this.prisma.withAuthContext({ tenantId }, async (tx) => {
        const categories = await tx.category.findMany({
          where: { menuId: { in: menuIds } },
          orderBy: [{ sortOrder: 'asc' }],
        });
        const categoryIds = categories.map((c) => c.id);

        const placements = categoryIds.length
          ? await tx.menuItemPlacement.findMany({
              where: { categoryId: { in: categoryIds } },
              select: { menuItemId: true, categoryId: true },
            })
          : [];
        const placedItemIds = [...new Set(placements.map((p) => p.menuItemId))];

        const itemRows = placedItemIds.length
          ? await tx.menuItem.findMany({
              where: { id: { in: placedItemIds }, isActive: true },
              select: {
                id: true,
                names: true,
                description: true,
                allergens: true,
                dietaryTags: true,
                sortOrder: true,
                colour: true,
                barcodePlu: true,
                isOpenPrice: true,
                isWeighed: true,
              },
              orderBy: [{ sortOrder: 'asc' }],
            })
          : [];
        const activeItemIds = itemRows.map((i) => i.id);

        const variantRows = activeItemIds.length
          ? await tx.menuItemVariant.findMany({
              where: { menuItemId: { in: activeItemIds }, isActive: true },
              select: {
                id: true,
                menuItemId: true,
                name: true,
                barcode: true,
                sortOrder: true,
              },
              orderBy: [{ sortOrder: 'asc' }],
            })
          : [];

        const links = activeItemIds.length
          ? await tx.modifierGroupLink.findMany({
              where: { menuItemId: { in: activeItemIds } },
              select: {
                menuItemId: true,
                sortOrder: true,
                group: {
                  select: {
                    id: true,
                    name: true,
                    minSelections: true,
                    maxSelections: true,
                    isRequired: true,
                    allowRepeat: true,
                    freeQuantityThreshold: true,
                    modifiers: {
                      select: {
                        id: true,
                        name: true,
                        kind: true,
                        priceDelta: true,
                        isDefault: true,
                        sortOrder: true,
                      },
                      orderBy: { sortOrder: 'asc' },
                    },
                  },
                },
              },
              orderBy: { sortOrder: 'asc' },
            })
          : [];

        return {
          categories,
          itemRows,
          placements,
          variantRows,
          links,
        };
      });

    const activeItemIds = itemRows.map((i) => i.id);
    const activeItemIdSet = new Set(activeItemIds);
    const variantIds = variantRows.map((v) => v.id);

    // Only ACTIVE items appear in `items` below — an inactive item's
    // placement is dropped here too, so a category never references an id
    // this response does not also define.
    const itemIdsByCategory = new Map<string, string[]>();
    for (const p of placements) {
      if (!activeItemIdSet.has(p.menuItemId)) continue;
      const list = itemIdsByCategory.get(p.categoryId) ?? [];
      list.push(p.menuItemId);
      itemIdsByCategory.set(p.categoryId, list);
    }

    // FR-MNU-030/031 — the SAME check `OrderLinesService.assertAvailable`
    // makes at line-capture time, batched.
    const { blockedMenuItemIds, blockedVariantIds } =
      await this.availability.resolveBlocked(
        tenantId,
        branchId,
        activeItemIds,
        variantIds,
      );

    // FR-POS-040 — the SAME price-resolution tier engine Sales runs at
    // line-capture time (`PriceResolutionService.resolve`), one variant at a
    // time; this is a read-only menu listing, not a transactional capture, so
    // each variant resolves in its own short-lived transaction rather than
    // sharing one long-lived one across the whole menu.
    const pricedByVariantId = new Map<
      string,
      Awaited<ReturnType<PriceResolutionService['resolve']>>
    >();
    for (const variant of variantRows) {
      const resolution = await this.pricing.resolve(tenantId, {
        branchId,
        menuItemVariantId: variant.id,
        orderType,
      });
      pricedByVariantId.set(variant.id, resolution);
    }

    const variantsByItemId = new Map<string, typeof variantRows>();
    for (const v of variantRows) {
      const list = variantsByItemId.get(v.menuItemId) ?? [];
      list.push(v);
      variantsByItemId.set(v.menuItemId, list);
    }

    const linksByItemId = new Map<string, typeof links>();
    for (const l of links) {
      const list = linksByItemId.get(l.menuItemId) ?? [];
      list.push(l);
      linksByItemId.set(l.menuItemId, list);
    }

    const items = itemRows.map((item) => {
      const itemBlocked = blockedMenuItemIds.has(item.id);
      const variants = (variantsByItemId.get(item.id) ?? []).map((v) => {
        const resolution = pricedByVariantId.get(v.id);
        const resolved = resolution?.resolved ?? null;
        return {
          id: v.id,
          name: v.name,
          barcode: v.barcode,
          sortOrder: v.sortOrder,
          // An item-level 86 blocks EVERY one of its variants too — the same
          // OR semantics `OrderLinesService.assertAvailable` evaluates at
          // line-capture time (it matches on menuItemId OR variantId).
          isAvailable: !itemBlocked && !blockedVariantIds.has(v.id),
          price: resolved
            ? {
                amountMinorUnits: resolved.amount.amount.toString(),
                currency: resolved.amount.currency.code,
              }
            : null,
          priceAmbiguous: resolution?.ambiguous ?? false,
        };
      });

      const modifierGroups = (linksByItemId.get(item.id) ?? []).map((l) => ({
        id: l.group.id,
        name: l.group.name,
        minSelections: l.group.minSelections,
        maxSelections: l.group.maxSelections,
        isRequired: l.group.isRequired,
        allowRepeat: l.group.allowRepeat,
        freeQuantityThreshold: l.group.freeQuantityThreshold,
        modifiers: l.group.modifiers.map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          priceDelta: m.priceDelta.toString(),
          isDefault: m.isDefault,
          sortOrder: m.sortOrder,
        })),
      }));

      return {
        id: item.id,
        names: item.names,
        description: item.description,
        allergens: item.allergens,
        dietaryTags: item.dietaryTags,
        sortOrder: item.sortOrder,
        colour: item.colour,
        barcodePlu: item.barcodePlu,
        isOpenPrice: item.isOpenPrice,
        isWeighed: item.isWeighed,
        isAvailable: !blockedMenuItemIds.has(item.id),
        variants,
        modifierGroups,
      };
    });

    const categoryViews = categories.map((c) => ({
      id: c.id,
      menuId: c.menuId,
      parentCategoryId: c.parentCategoryId,
      name: c.name,
      sortOrder: c.sortOrder,
      colour: c.colour,
      itemIds: itemIdsByCategory.get(c.id) ?? [],
    }));

    return {
      branchId,
      orderType,
      menus,
      categories: categoryViews,
      items,
      ambiguousMenuPriority: ambiguous,
      ...(warning ? { warning } : {}),
    };
  }
}
