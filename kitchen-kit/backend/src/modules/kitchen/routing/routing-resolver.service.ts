import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { ROUTING_CONFIG_QUERY } from '../../organisation/contract';
import type {
  CategoryRoutingRuleRef,
  RoutingConfigQuery,
} from '../../organisation/contract';
import {
  RoutingConfigurationConflictError,
  RoutingNoDestinationError,
} from './routing-resolver.errors';
import {
  RoutingResolution,
  RoutingResolutionInput,
  RoutingTier,
} from './routing-resolver.types';

const TIER_LABELS: Record<RoutingTier, string> = {
  LINE_OVERRIDE: 'Explicit line-level station override',
  MODIFIER: 'Modifier-driven routing rule',
  MENU_ITEM: 'Menu item station assignment',
  CATEGORY: 'Category default station',
  FALLBACK: 'Branch fallback station',
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * FR-KDS-010 routing resolution — Kitchen Ops PRIVATE behaviour (not
 * published through `kitchen/contract/`: no other module calls this).
 * ADR 0008 D-07/D-06 splits this feature "stored, not resolved" — Organisation
 * stores the configuration, Kitchen resolves it. This service reads tiers 2-5
 * ONLY through `organisation/contract`'s `RoutingConfigQuery`, never
 * `kitchen.station_routing_rules` / `kitchen.branch_kds_config` directly, and
 * never touches Sales or Catalogue tables directly — tier 1 is Sales-owned
 * data (`sales.order_line_station_overrides`) and is supplied by the caller.
 *
 * `tx` is the caller's own `Prisma.TransactionClient` — this method opens no
 * transaction of its own, so a resolution taken during a future Fire runs
 * inside that operation's single atomic unit of work.
 *
 * Five-tier, first-APPLICABLE-tier-wins precedence (FR-KDS-010; the same
 * "first applicable wins, not combined" shape as FR-POS-040's price
 * resolution):
 *   1. LINE_OVERRIDE  — explicit line-level station override (R1)
 *   2. MODIFIER       — REPLACES tiers 3-5 entirely, never augments them (R3)
 *   3. MENU_ITEM      — the menu item's own station, never Variant (R4/C-03)
 *   4. CATEGORY       — 0 matches -> fall through; 1 -> use it; N mapping to
 *                        the identical station set -> use it; N mapping to
 *                        different sets -> ROUTING_CONFIGURATION_CONFLICT (R5)
 *   5. FALLBACK       — the branch's configured fallback station
 * No destination at all -> ROUTING_NO_DESTINATION (R6).
 *
 * Multiple stations within the WINNING tier are unioned and returned sorted
 * — deterministic, but the ordering itself carries no business meaning (R2).
 * The returned provenance (tier, station ids, rule/override ids) is
 * runtime-only diagnostic data; this resolver persists nothing (R7).
 */
@Injectable()
export class RoutingResolverService {
  constructor(
    @Inject(ROUTING_CONFIG_QUERY)
    private readonly routingConfig: RoutingConfigQuery,
  ) {}

  async resolve(
    tx: Prisma.TransactionClient,
    input: RoutingResolutionInput,
  ): Promise<RoutingResolution> {
    if (input.lineOverrides.length > 0) {
      return this.build(
        'LINE_OVERRIDE',
        input.lineOverrides.map((o) => o.stationId),
        input.lineOverrides.map((o) => o.overrideId),
      );
    }

    const config = await this.routingConfig.find(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      menuItemId: input.menuItemId,
      modifierIds: input.modifierIds,
      categoryIds: input.categoryIds,
    });

    if (config.modifierRules.length > 0) {
      return this.build(
        'MODIFIER',
        config.modifierRules.map((r) => r.stationId),
        config.modifierRules.map((r) => r.ruleId),
      );
    }

    if (config.menuItemRules.length > 0) {
      return this.build(
        'MENU_ITEM',
        config.menuItemRules.map((r) => r.stationId),
        config.menuItemRules.map((r) => r.ruleId),
      );
    }

    const categoryResolution = this.resolveCategoryTier(config.categoryRules);
    if (categoryResolution !== null) {
      return categoryResolution;
    }

    if (config.fallbackStationId !== null) {
      return this.build(
        'FALLBACK',
        [config.fallbackStationId],
        [input.branchId],
      );
    }

    throw new RoutingNoDestinationError(
      `No routing destination for menu item ${input.menuItemId} in branch ${input.branchId}: ` +
        'no line override, no matching modifier/menu-item/category rule, and no branch fallback station configured.',
    );
  }

  private resolveCategoryTier(
    categoryRules: readonly CategoryRoutingRuleRef[],
  ): RoutingResolution | null {
    if (categoryRules.length === 0) {
      return null;
    }
    const byCategory = new Map<
      string,
      { stationIds: Set<string>; ruleIds: string[] }
    >();
    for (const rule of categoryRules) {
      const bucket = byCategory.get(rule.categoryId) ?? {
        stationIds: new Set<string>(),
        ruleIds: [],
      };
      bucket.stationIds.add(rule.stationId);
      bucket.ruleIds.push(rule.ruleId);
      byCategory.set(rule.categoryId, bucket);
    }

    const groups = [...byCategory.values()];
    const signatures = new Set(
      groups.map((g) => sortedUnique([...g.stationIds]).join(',')),
    );
    if (signatures.size > 1) {
      throw new RoutingConfigurationConflictError(
        `Routing configuration conflict: ${byCategory.size} matching categories resolve to different station sets.`,
      );
    }

    return this.build(
      'CATEGORY',
      groups.flatMap((g) => [...g.stationIds]),
      groups.flatMap((g) => g.ruleIds),
    );
  }

  private build(
    tier: RoutingTier,
    stationIds: readonly string[],
    sourceIds: readonly string[],
  ): RoutingResolution {
    return {
      tier,
      tierLabel: TIER_LABELS[tier],
      stationIds: sortedUnique(stationIds),
      sourceIds: sortedUnique(sourceIds),
    };
  }
}
