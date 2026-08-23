import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — FR-KDS-010 tiers 2–5 routing configuration.
 *
 * Kitchen owns FR-KDS-010 RESOLUTION behaviour, but the configuration it
 * resolves against (`kitchen.station_routing_rules`, `kitchen.branch_kds_config`)
 * is Organisation-owned (ADR 0008 D-07/D-06 — "stored, not resolved"; see the
 * P1E-2 gate report §D/§K). Kitchen MUST NOT query those tables directly; this
 * INTERFACE is the one door through.
 *
 * This file is INTERFACE + DTOs ONLY (SRS §5.4: "contract/ is PUBLIC ...
 * application/infrastructure remain PRIVATE"). The Prisma-backed
 * implementation lives at `organisation/routing-config/routing-config.query.service.ts`
 * — a PRIVATE Organisation path — and is bound to `ROUTING_CONFIG_QUERY`
 * only inside `OrganisationModule`. Kitchen injects `ROUTING_CONFIG_QUERY`
 * and depends on the `RoutingConfigQuery` interface below; it never imports
 * the concrete class (see `module-boundaries.spec.ts`'s "contract purity"
 * assertions, P1E-3A).
 *
 * `find()` is transaction-aware: it takes the CALLER's own
 * `Prisma.TransactionClient` (already inside a `PrismaService.withAuthContext`
 * scope) and issues no transaction of its own, so a resolution taken mid-Fire
 * (a future slice) reads inside that same atomic unit of work, not a second
 * one. `Prisma.TransactionClient` is the Prisma *type*, not an Organisation
 * type — carrying it here is the accepted P1E-2/P1E-3 same-transaction
 * pattern (SRS §5.5.1), not a leaked implementation detail; nothing in this
 * file executes a query.
 *
 * Output is plain, typed DTOs — no Prisma model instances cross this
 * boundary. Tier-1 (explicit line override) is Sales-owned data
 * (`sales.order_line_station_overrides`); Kitchen must not query Sales either,
 * so it is not part of this query — a future Fire caller supplies it directly
 * to the resolver.
 *
 * `priority` on `station_routing_rules` carries NO resolution semantics (P1E-2
 * §H/§J) and is deliberately not part of this contract — the resolver has no
 * field to misuse even by accident.
 */
export const ROUTING_CONFIG_QUERY = Symbol('ROUTING_CONFIG_QUERY');

export interface RoutingConfigQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly menuItemId: string;
  readonly modifierIds: readonly string[];
  readonly categoryIds: readonly string[];
}

export interface RoutingRuleRef {
  readonly ruleId: string;
  readonly stationId: string;
}

export interface CategoryRoutingRuleRef extends RoutingRuleRef {
  readonly categoryId: string;
}

export interface RoutingConfigResult {
  /** FR-KDS-010 tier 2 — modifier-driven rules matching any of `modifierIds`. */
  readonly modifierRules: readonly RoutingRuleRef[];
  /** FR-KDS-010 tier 3 — MenuItem-level rules matching `menuItemId` (C-03: not variant-level). */
  readonly menuItemRules: readonly RoutingRuleRef[];
  /** FR-KDS-010 tier 4 — category default rules matching any of `categoryIds`. */
  readonly categoryRules: readonly CategoryRoutingRuleRef[];
  /** FR-KDS-010 tier 5 — the branch's configured fallback station, if any. */
  readonly fallbackStationId: string | null;
}

/**
 * The public contract itself: an interface, not a class. There is nothing to
 * `new` here and nothing that can accidentally contain a query — Kitchen (or
 * any consumer) depends on this type and on the `ROUTING_CONFIG_QUERY`
 * injection token; Nest resolves the token to the private implementation.
 */
export interface RoutingConfigQuery {
  find(
    tx: Prisma.TransactionClient,
    input: RoutingConfigQueryInput,
  ): Promise<RoutingConfigResult>;
}
