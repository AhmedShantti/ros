export type RoutingTier =
  'LINE_OVERRIDE' | 'MODIFIER' | 'MENU_ITEM' | 'CATEGORY' | 'FALLBACK';

/**
 * FR-KDS-010 tier 1. `sales.order_line_station_overrides` is Sales-owned;
 * Kitchen must not query Sales tables, so the (future) Fire caller resolves
 * these rows itself and passes them in directly.
 */
export interface LineOverrideRef {
  readonly overrideId: string;
  readonly stationId: string;
}

export interface RoutingResolutionInput {
  readonly tenantId: string;
  readonly branchId: string;
  /** FR-KDS-010 tier 3 target — MenuItem-level, never Variant (R4/C-03). */
  readonly menuItemId: string;
  /** FR-KDS-010 tier 2 selectors — the line's captured modifier ids. */
  readonly modifierIds: readonly string[];
  /** FR-KDS-010 tier 4 selectors — the menu item's category ids. */
  readonly categoryIds: readonly string[];
  readonly lineOverrides: readonly LineOverrideRef[];
}

export interface RoutingResolution {
  /** Sorted, deduplicated — union order carries no business meaning (R2). */
  readonly stationIds: readonly string[];
  readonly tier: RoutingTier;
  readonly tierLabel: string;
  /** Runtime-only diagnostic provenance (R7) — never persisted by this resolver. */
  readonly sourceIds: readonly string[];
}
