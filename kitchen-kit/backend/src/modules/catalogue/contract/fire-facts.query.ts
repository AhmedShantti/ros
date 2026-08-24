import { Prisma } from '../../../generated/prisma/client';

/**
 * Catalogue PUBLIC contract — Fire-time facts Sales needs but does not own.
 *
 * P1E-5 identified the gap (`docs/reports/claude/2026-08-23_P1E5_ticket-
 * persistence-and-kitchen-handler.md`): a Fire producer needs, per fired
 * MenuItem, (a) the category ids FR-KDS-010 tier 4 routes against, and (b) a
 * Kitchen/KDS display name if the item has one configured — and Sales does
 * not own either fact. Rather than expand the existing PRIVATE
 * `sales->catalogue` deviation (`pricing/price-resolution.service`, recorded
 * in `module-boundaries.spec.ts` and NOT reopened by this contract), this is
 * a narrow, PUBLIC, additive door: interface + DTOs only (SRS §5.4:
 * "contract/ is PUBLIC ... application/infrastructure remain PRIVATE"). The
 * Prisma-backed implementation lives at
 * `catalogue/fire-facts/catalogue-fire-facts.query.service.ts` — a PRIVATE
 * Catalogue path — bound to `CATALOGUE_FIRE_FACTS_QUERY` only inside
 * `CatalogueModule`. A consumer (Sales) injects the token and depends on the
 * `CatalogueFireFactsQuery` interface below; it never imports the concrete
 * class (`module-boundaries.spec.ts`'s contract-purity assertions, mirroring
 * the P1E-3A pattern for `RoutingConfigQuery`).
 *
 * `find()` is transaction-aware: it takes the CALLER's own
 * `Prisma.TransactionClient` (already inside a `PrismaService.withAuthContext`
 * / `UnitOfWork.execute` scope) and issues no transaction of its own, so
 * Fire-facts collected mid-Fire read inside that same atomic unit of work
 * (SRS §5.5.1), never a second one.
 *
 * Batched by design: one Fire command may fire several lines, each naming a
 * (possibly repeated) `menuItemId` — the caller collects every distinct
 * `menuItemId` being fired and asks ONCE, not once per line.
 *
 * `categoryIds` per item are the DISTINCT category ids from
 * `catalogue.menu_item_placements` for that item, in DETERMINISTIC (sorted)
 * order — Sales carries these as ROUTING SELECTORS ONLY (FR-KDS-010 tier 4
 * inputs); Sales/Catalogue never chooses a station, the Kitchen resolver
 * remains the sole routing authority (`kitchen/routing/routing-resolver.service.ts`).
 *
 * `kitchenName` is the item's `kitchenNames` JSONB field verbatim (a
 * locale -> name map, matching the same shape `catalogue.views.ts`'s
 * `toMenuItemView` already exposes) when it holds at least one entry, and
 * `null` when it is absent/empty — "no Kitchen-specific name exists" is
 * represented as honest absence, never an invented abbreviation or
 * translation.
 */
export const CATALOGUE_FIRE_FACTS_QUERY = Symbol('CATALOGUE_FIRE_FACTS_QUERY');

export interface CatalogueFireFactsQueryInput {
  readonly tenantId: string;
  readonly menuItemIds: readonly string[];
}

export interface CatalogueFireFacts {
  readonly menuItemId: string;
  /** Deterministically ordered (sorted, de-duplicated), never empty->undefined — an item in no category yields `[]`. */
  readonly categoryIds: readonly string[];
  /** `null` when the item has no Kitchen-specific name configured. */
  readonly kitchenName: Readonly<Record<string, unknown>> | null;
}

/**
 * The public contract itself: an interface, not a class. Nothing to `new`,
 * nothing that can accidentally contain a query — a consumer depends on this
 * type and on the `CATALOGUE_FIRE_FACTS_QUERY` injection token; Nest resolves
 * the token to the private implementation.
 */
export interface CatalogueFireFactsQuery {
  find(
    tx: Prisma.TransactionClient,
    input: CatalogueFireFactsQueryInput,
  ): Promise<ReadonlyMap<string, CatalogueFireFacts>>;
}
