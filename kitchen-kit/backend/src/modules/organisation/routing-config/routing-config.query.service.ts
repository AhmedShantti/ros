import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  RoutingConfigQuery,
  RoutingConfigQueryInput,
  RoutingConfigResult,
} from '../contract';

/**
 * PRIVATE Organisation implementation of the `RoutingConfigQuery` contract
 * (`organisation/contract/routing-config.query.ts`). Not exported through
 * `contract/` — bound to the `ROUTING_CONFIG_QUERY` token inside
 * `OrganisationModule` only (P1E-3A: split from the public interface, which
 * P1E-3 had incorrectly placed here as a concrete `@Injectable()` class
 * directly under `contract/`).
 *
 * Queries `kitchen.station_routing_rules` / `kitchen.branch_kds_config`
 * directly — legal here because this file IS the Organisation-owned
 * persistence implementation (ADR 0008 D-07/D-06). It is illegal only for
 * Kitchen (or any other module) to do the same, which is what the public
 * interface exists to prevent.
 */
@Injectable()
export class RoutingConfigQueryService implements RoutingConfigQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: RoutingConfigQueryInput,
  ): Promise<RoutingConfigResult> {
    const [modifierRows, menuItemRows, categoryRows, branchConfig] =
      await Promise.all([
        // `IN ()` on an empty array matches zero rows — no special-casing needed.
        tx.stationRoutingRule.findMany({
          where: {
            tenantId: input.tenantId,
            branchId: input.branchId,
            modifierId: { in: [...input.modifierIds] },
          },
          select: { id: true, stationId: true },
        }),
        tx.stationRoutingRule.findMany({
          where: {
            tenantId: input.tenantId,
            branchId: input.branchId,
            menuItemId: input.menuItemId,
          },
          select: { id: true, stationId: true },
        }),
        tx.stationRoutingRule.findMany({
          where: {
            tenantId: input.tenantId,
            branchId: input.branchId,
            categoryId: { in: [...input.categoryIds] },
          },
          select: { id: true, stationId: true, categoryId: true },
        }),
        tx.branchKdsConfig.findUnique({
          where: {
            tenantId_branchId: {
              tenantId: input.tenantId,
              branchId: input.branchId,
            },
          },
          select: { fallbackStationId: true },
        }),
      ]);

    return {
      modifierRules: modifierRows.map((r) => ({
        ruleId: r.id,
        stationId: r.stationId,
      })),
      menuItemRules: menuItemRows.map((r) => ({
        ruleId: r.id,
        stationId: r.stationId,
      })),
      categoryRules: categoryRows.map((r) => ({
        ruleId: r.id,
        stationId: r.stationId,
        // input.categoryIds.length > 0 whenever categoryRows is non-empty.
        categoryId: r.categoryId as string,
      })),
      fallbackStationId: branchConfig?.fallbackStationId ?? null,
    };
  }
}
