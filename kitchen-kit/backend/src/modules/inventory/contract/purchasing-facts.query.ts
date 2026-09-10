import { Prisma } from '../../../generated/prisma/client';

/**
 * Inventory PUBLIC contract — FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1.
 *
 * Procurement's Supplier<->StockItem sourcing link (FR-PRC-007) and its price
 * entries (FR-PRC-006) both reference a StockItem and a "purchase unit" that
 * belongs to it. Neither may query `inventory.stock_items` /
 * `inventory.uom` / `inventory.packaging_units` directly (module boundary,
 * `module-boundaries.spec.ts`) or hold a cross-schema FK to them (the
 * `stock_item_id` / `purchase_unit_id` columns are recorded ids only — the
 * same pattern `sales.order_lines.menu_item_id` and
 * `inventory.packaging_units.supplier_id` already use). This is the narrow,
 * additive query the mission brief's §6 asks for: "Is this purchase unit
 * valid for this stock item, and what is its base-unit conversion?", plus
 * the existence/active check §2 needs for the sourcing link itself.
 *
 * A "purchase unit" is either the StockItem's own base `Uom` (conversion
 * factor 1, always valid) or one of its `PackagingUnit`s. Returning BOTH
 * kinds in one list lets the caller validate a supplied purchase unit id by
 * simple membership, without re-deriving Inventory's own unit-of-measure
 * model.
 *
 * `tx`-FIRST — composed inside the caller's own transaction (SRS §5.5.1),
 * sharing its MVCC snapshot and RLS context.
 */
export const STOCK_ITEM_PURCHASING_FACTS_QUERY = Symbol(
  'STOCK_ITEM_PURCHASING_FACTS_QUERY',
);

export interface PurchaseUnitFacts {
  readonly id: string;
  readonly kind: 'base' | 'packaging';
  /** `Uom.code` for the base unit, `PackagingUnit.name` for a packaging unit. */
  readonly label: string;
  /** Decimal string; `'1'` for the base unit itself. */
  readonly conversionFactorToBase: string;
}

export interface StockItemPurchasingFacts {
  readonly stockItemId: string;
  readonly sku: string;
  readonly isActive: boolean;
  readonly baseUnitId: string;
  /** The base unit, then every configured packaging unit. */
  readonly purchaseUnits: readonly PurchaseUnitFacts[];
}

export interface StockItemPurchasingFactsQueryInput {
  readonly tenantId: string;
  readonly stockItemId: string;
}

export interface StockItemPurchasingFactsQuery {
  /** `null` when the stock item is not visible in this tenant (RLS-safe 404). */
  find(
    tx: Prisma.TransactionClient,
    input: StockItemPurchasingFactsQueryInput,
  ): Promise<StockItemPurchasingFacts | null>;
}
