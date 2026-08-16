import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { toMenuItemView, toVariantView } from '../catalogue.views';

const PLACEMENT_EXISTS = 'This item is already placed in that category.';
const CATEGORY_NOT_FOUND = 'Category not found.';
const GROUP_NOT_FOUND = 'Modifier group not found.';

export interface CreateMenuItemInput {
  names: Record<string, unknown>;
  kitchenNames?: Record<string, unknown>;
  aggregatorNames?: Record<string, unknown>;
  description?: Record<string, unknown>;
  taxClassId?: string;
  revenueAccountCode?: string;
  barcodePlu?: string;
  allergens?: string[];
  dietaryTags?: string[];
  sortOrder?: number;
  colour?: string;
  isCombo?: boolean;
  isOpenPrice?: boolean;
  isWeighed?: boolean;
}

export interface CreateVariantInput {
  name: Record<string, unknown>;
  barcode?: string;
  prepTimeSeconds?: number;
  sortOrder?: number;
}

/**
 * MenuItem — the canonical sellable identity (C-02).
 *
 * A MenuItem is TENANT-scoped and reusable across menus. It has no
 * `category_id`: appearing on several menus is modelled by `MenuItemPlacement`,
 * so one dish keeps ONE identity and therefore one shared ItemId with
 * Production Spec (SRS §5.3.1). Items are never duplicated to solve menu reuse.
 */
@Injectable()
export class MenuItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(tenantId: string, actorId: string, input: CreateMenuItemInput) {
    const item = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const created = await tx.menuItem.create({
          data: {
            id: newId(),
            tenantId,
            names: input.names as Prisma.InputJsonValue,
            ...(input.kitchenNames !== undefined
              ? { kitchenNames: input.kitchenNames as Prisma.InputJsonValue }
              : {}),
            ...(input.aggregatorNames !== undefined
              ? {
                  aggregatorNames:
                    input.aggregatorNames as Prisma.InputJsonValue,
                }
              : {}),
            ...(input.description !== undefined
              ? { description: input.description as Prisma.InputJsonValue }
              : {}),
            // C-04: recorded only; Fiscal is out of scope so it is never resolved.
            taxClassId: input.taxClassId ?? null,
            revenueAccountCode: input.revenueAccountCode ?? null,
            barcodePlu: input.barcodePlu ?? null,
            allergens: input.allergens ?? [],
            dietaryTags: input.dietaryTags ?? [],
            ...(input.sortOrder !== undefined
              ? { sortOrder: input.sortOrder }
              : {}),
            colour: input.colour ?? null,
            ...(input.isCombo !== undefined ? { isCombo: input.isCombo } : {}),
            ...(input.isOpenPrice !== undefined
              ? { isOpenPrice: input.isOpenPrice }
              : {}),
            ...(input.isWeighed !== undefined
              ? { isWeighed: input.isWeighed }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MENU_ITEM_CREATED,
          entityType: AUDIT_ENTITY.MENU_ITEM,
          actorType: 'user',
          actorId,
          entityId: created.id,
          metadata: { barcodePlu: created.barcodePlu },
        });
        return created;
      },
    );
    return toMenuItemView(item);
  }

  list(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.menuItem.findMany({ orderBy: { sortOrder: 'asc' } }),
      )
      .then((rows) => rows.map(toMenuItemView));
  }

  async findOne(tenantId: string, itemId: string) {
    const item = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.menuItem.findUnique({ where: { id: itemId } }),
    );
    if (!item) {
      throw new NotFoundException('Menu item not found.');
    }
    return toMenuItemView(item);
  }

  async update(
    tenantId: string,
    actorId: string,
    itemId: string,
    input: Partial<CreateMenuItemInput>,
  ) {
    const item = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.menuItem.findUnique({
          where: { id: itemId },
        });
        if (!existing) {
          throw new NotFoundException('Menu item not found.');
        }
        const updated = await tx.menuItem.update({
          where: { id: itemId },
          data: {
            ...(input.names !== undefined
              ? { names: input.names as Prisma.InputJsonValue }
              : {}),
            ...(input.kitchenNames !== undefined
              ? { kitchenNames: input.kitchenNames as Prisma.InputJsonValue }
              : {}),
            ...(input.aggregatorNames !== undefined
              ? {
                  aggregatorNames:
                    input.aggregatorNames as Prisma.InputJsonValue,
                }
              : {}),
            ...(input.description !== undefined
              ? { description: input.description as Prisma.InputJsonValue }
              : {}),
            ...(input.taxClassId !== undefined
              ? { taxClassId: input.taxClassId }
              : {}),
            ...(input.revenueAccountCode !== undefined
              ? { revenueAccountCode: input.revenueAccountCode }
              : {}),
            ...(input.barcodePlu !== undefined
              ? { barcodePlu: input.barcodePlu }
              : {}),
            ...(input.allergens !== undefined
              ? { allergens: input.allergens }
              : {}),
            ...(input.dietaryTags !== undefined
              ? { dietaryTags: input.dietaryTags }
              : {}),
            ...(input.sortOrder !== undefined
              ? { sortOrder: input.sortOrder }
              : {}),
            ...(input.colour !== undefined ? { colour: input.colour } : {}),
            ...(input.isOpenPrice !== undefined
              ? { isOpenPrice: input.isOpenPrice }
              : {}),
            ...(input.isWeighed !== undefined
              ? { isWeighed: input.isWeighed }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MENU_ITEM_UPDATED,
          entityType: AUDIT_ENTITY.MENU_ITEM,
          actorType: 'user',
          actorId,
          entityId: itemId,
          before: { barcodePlu: existing.barcodePlu },
          metadata: { barcodePlu: updated.barcodePlu },
        });
        return updated;
      },
    );
    return toMenuItemView(item);
  }

  /** C-09: explicit, audited lifecycle. */
  async setActive(
    tenantId: string,
    actorId: string,
    itemId: string,
    isActive: boolean,
  ) {
    const item = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.menuItem.findUnique({
          where: { id: itemId },
        });
        if (!existing) {
          throw new NotFoundException('Menu item not found.');
        }
        const updated = await tx.menuItem.update({
          where: { id: itemId },
          data: { isActive },
        });
        await this.audit.record(tx, {
          tenantId,
          action: isActive
            ? AUDIT_ACTION.MENU_ITEM_ACTIVATED
            : AUDIT_ACTION.MENU_ITEM_DEACTIVATED,
          entityType: AUDIT_ENTITY.MENU_ITEM,
          actorType: 'user',
          actorId,
          entityId: itemId,
          before: { isActive: existing.isActive },
          metadata: { isActive: updated.isActive },
        });
        return updated;
      },
    );
    return toMenuItemView(item);
  }

  // ------------------------------------------------------------- placement --
  /** C-02: place an item into a category (and therefore onto that menu). */
  async place(
    tenantId: string,
    actorId: string,
    itemId: string,
    categoryId: string,
  ): Promise<void> {
    try {
      await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const item = await tx.menuItem.findUnique({ where: { id: itemId } });
          if (!item) {
            throw new NotFoundException('Menu item not found.');
          }
          await tx.menuItemPlacement.create({
            data: { id: newId(), tenantId, menuItemId: itemId, categoryId },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.MENU_ITEM_PLACED,
            entityType: AUDIT_ENTITY.MENU_ITEM_PLACEMENT,
            actorType: 'user',
            actorId,
            entityId: itemId,
            metadata: { menuItemId: itemId, categoryId },
          });
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, CATEGORY_NOT_FOUND, PLACEMENT_EXISTS);
    }
  }

  async unplace(
    tenantId: string,
    actorId: string,
    itemId: string,
    categoryId: string,
  ): Promise<void> {
    await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const placement = await tx.menuItemPlacement.findUnique({
          where: {
            tenantId_menuItemId_categoryId: {
              tenantId,
              menuItemId: itemId,
              categoryId,
            },
          },
        });
        if (!placement) {
          throw new NotFoundException('Placement not found.');
        }
        await tx.menuItemPlacement.delete({ where: { id: placement.id } });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MENU_ITEM_UNPLACED,
          entityType: AUDIT_ENTITY.MENU_ITEM_PLACEMENT,
          actorType: 'user',
          actorId,
          entityId: itemId,
          before: { menuItemId: itemId, categoryId },
        });
      },
    );
  }

  listPlacements(tenantId: string, itemId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const item = await tx.menuItem.findUnique({ where: { id: itemId } });
      if (!item) {
        throw new NotFoundException('Menu item not found.');
      }
      const rows = await tx.menuItemPlacement.findMany({
        where: { menuItemId: itemId },
        select: { categoryId: true, category: { select: { menuId: true } } },
      });
      return rows.map((r) => ({
        categoryId: r.categoryId,
        menuId: r.category.menuId,
      }));
    });
  }

  // -------------------------------------------------------------- variants --
  /** FR-MNU-006: variants carry independent pricing, barcode and availability. */
  async addVariant(
    tenantId: string,
    actorId: string,
    itemId: string,
    input: CreateVariantInput,
  ) {
    const variant = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const item = await tx.menuItem.findUnique({ where: { id: itemId } });
        if (!item) {
          throw new NotFoundException('Menu item not found.');
        }
        const created = await tx.menuItemVariant.create({
          data: {
            id: newId(),
            tenantId,
            menuItemId: itemId,
            name: input.name as Prisma.InputJsonValue,
            barcode: input.barcode ?? null,
            prepTimeSeconds: input.prepTimeSeconds ?? null,
            ...(input.sortOrder !== undefined
              ? { sortOrder: input.sortOrder }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.VARIANT_CREATED,
          entityType: AUDIT_ENTITY.VARIANT,
          actorType: 'user',
          actorId,
          entityId: created.id,
          metadata: { menuItemId: itemId },
        });
        return created;
      },
    );
    return toVariantView(variant);
  }

  listVariants(tenantId: string, itemId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        const item = await tx.menuItem.findUnique({ where: { id: itemId } });
        if (!item) {
          throw new NotFoundException('Menu item not found.');
        }
        return tx.menuItemVariant.findMany({
          where: { menuItemId: itemId },
          orderBy: { sortOrder: 'asc' },
        });
      })
      .then((rows) => rows.map(toVariantView));
  }

  async setVariantActive(
    tenantId: string,
    actorId: string,
    variantId: string,
    isActive: boolean,
  ) {
    const variant = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.menuItemVariant.findUnique({
          where: { id: variantId },
        });
        if (!existing) {
          throw new NotFoundException('Variant not found.');
        }
        const updated = await tx.menuItemVariant.update({
          where: { id: variantId },
          data: { isActive },
        });
        await this.audit.record(tx, {
          tenantId,
          action: isActive
            ? AUDIT_ACTION.VARIANT_ACTIVATED
            : AUDIT_ACTION.VARIANT_DEACTIVATED,
          entityType: AUDIT_ENTITY.VARIANT,
          actorType: 'user',
          actorId,
          entityId: variantId,
          before: { isActive: existing.isActive },
          metadata: { isActive: updated.isActive },
        });
        return updated;
      },
    );
    return toVariantView(variant);
  }

  // ------------------------------------------------------- modifier groups --
  /** FR-MNU-010: attach a reusable group with per-item overrides. */
  async linkModifierGroup(
    tenantId: string,
    actorId: string,
    itemId: string,
    modifierGroupId: string,
    overrides: {
      priceOverride?: Record<string, unknown>;
      defaultSelectionOverride?: Record<string, unknown>;
      sortOrder?: number;
    },
  ): Promise<void> {
    try {
      await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const item = await tx.menuItem.findUnique({ where: { id: itemId } });
          if (!item) {
            throw new NotFoundException('Menu item not found.');
          }
          await tx.modifierGroupLink.create({
            data: {
              tenantId,
              menuItemId: itemId,
              modifierGroupId,
              ...(overrides.priceOverride !== undefined
                ? {
                    priceOverride:
                      overrides.priceOverride as Prisma.InputJsonValue,
                  }
                : {}),
              ...(overrides.defaultSelectionOverride !== undefined
                ? {
                    defaultSelectionOverride:
                      overrides.defaultSelectionOverride as Prisma.InputJsonValue,
                  }
                : {}),
              ...(overrides.sortOrder !== undefined
                ? { sortOrder: overrides.sortOrder }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.MODIFIER_GROUP_LINKED,
            entityType: AUDIT_ENTITY.MODIFIER_GROUP_LINK,
            actorType: 'user',
            actorId,
            entityId: itemId,
            metadata: { menuItemId: itemId, modifierGroupId },
          });
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(
        err,
        GROUP_NOT_FOUND,
        'This modifier group is already linked to the item.',
      );
    }
  }
}
