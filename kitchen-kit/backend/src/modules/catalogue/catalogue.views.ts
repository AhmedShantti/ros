import {
  AvailabilityRule,
  Category,
  Menu,
  MenuItem,
  MenuItemVariant,
  Modifier,
  ModifierGroup,
  PriceEntry,
  PriceList,
} from '../../generated/prisma/client';

/** tenantId is never exposed: it is server-derived, never client data. */

export function toMenuView(m: Menu) {
  return {
    id: m.id,
    name: m.name,
    orderTypes: m.orderTypes,
    activeWindow: m.activeWindow,
    priority: m.priority,
    isActive: m.isActive,
    createdAt: m.createdAt,
  };
}

export function toCategoryView(c: Category) {
  return {
    id: c.id,
    menuId: c.menuId,
    parentCategoryId: c.parentCategoryId,
    name: c.name,
    sortOrder: c.sortOrder,
    colour: c.colour,
  };
}

export function toMenuItemView(i: MenuItem) {
  return {
    id: i.id,
    names: i.names,
    kitchenNames: i.kitchenNames,
    aggregatorNames: i.aggregatorNames,
    description: i.description,
    taxClassId: i.taxClassId,
    revenueAccountCode: i.revenueAccountCode,
    barcodePlu: i.barcodePlu,
    allergens: i.allergens,
    dietaryTags: i.dietaryTags,
    sortOrder: i.sortOrder,
    colour: i.colour,
    isCombo: i.isCombo,
    isOpenPrice: i.isOpenPrice,
    isWeighed: i.isWeighed,
    isActive: i.isActive,
    createdAt: i.createdAt,
  };
}

export function toVariantView(v: MenuItemVariant) {
  return {
    id: v.id,
    menuItemId: v.menuItemId,
    name: v.name,
    barcode: v.barcode,
    prepTimeSeconds: v.prepTimeSeconds,
    sortOrder: v.sortOrder,
    isActive: v.isActive,
  };
}

export function toModifierGroupView(g: ModifierGroup) {
  return {
    id: g.id,
    name: g.name,
    minSelections: g.minSelections,
    maxSelections: g.maxSelections,
    isRequired: g.isRequired,
    allowRepeat: g.allowRepeat,
    freeQuantityThreshold: g.freeQuantityThreshold,
  };
}

export function toModifierView(m: Modifier) {
  return {
    id: m.id,
    modifierGroupId: m.modifierGroupId,
    name: m.name,
    /** FR-POS-021 [M]. `null` = a legacy modifier with no non-heuristic
     * source of truth for its kind (P1E-5) — never fabricated. */
    kind: m.kind,
    // Money is BIGINT in the DB; serialise as a string so precision survives JSON.
    priceDelta: m.priceDelta.toString(),
    stockItemId: m.stockItemId,
    consumptionQuantity: m.consumptionQuantity?.toString() ?? null,
    consumptionUnitId: m.consumptionUnitId,
    recipeDelta: m.recipeDelta,
    isDefault: m.isDefault,
    sortOrder: m.sortOrder,
  };
}

export function toPriceListView(p: PriceList) {
  return {
    id: p.id,
    name: p.name,
    scopeType: p.scopeType,
    scopeId: p.scopeId,
    orderType: p.orderType,
    validFrom: p.validFrom,
    validTo: p.validTo,
    recurrenceRule: p.recurrenceRule,
    priority: p.priority,
    status: p.status,
  };
}

export function toPriceEntryView(e: PriceEntry) {
  return {
    id: e.id,
    priceListId: e.priceListId,
    menuItemVariantId: e.menuItemVariantId,
    price: e.price.toString(),
    currency: e.currency,
  };
}

export function toAvailabilityRuleView(a: AvailabilityRule) {
  return {
    id: a.id,
    menuItemId: a.menuItemId,
    variantId: a.variantId,
    branchId: a.branchId,
    channel: a.channel,
    dayOfWeek: a.dayOfWeek,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    isManual86: a.isManual86,
    autoReenableAt: a.autoReenableAt,
  };
}
