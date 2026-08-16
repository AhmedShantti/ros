import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { assertBranchInScope } from '../branch-scope';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import {
  StationRoutingRuleSummary,
  toStationRoutingRuleSummary,
} from './station-routing.view';

const STATION_NOT_FOUND = 'Station not found in this branch.';

export interface CreateStationRoutingRuleInput {
  stationId: string;
  menuItemId?: string;
  categoryId?: string;
  priority?: number;
}

/**
 * Station routing rules — `kitchen.station_routing_rules`.
 *
 * The table lives in the `kitchen` schema because SRS §25.1 places it there
 * (ADR 0008 D-06). Only the Organisation-side CONFIGURATION is implemented: no
 * tickets, no ticket lines, and no FR-KDS-010 routing resolution. The rows carry
 * no tenant_id and inherit the tenant boundary through `branch_id`.
 */
@Injectable()
export class StationRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    branchId: string,
    input: CreateStationRoutingRuleInput,
  ): Promise<StationRoutingRuleSummary> {
    try {
      const rule = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          await assertBranchInScope(tx, branchId);
          const created = await tx.stationRoutingRule.create({
            data: {
              id: newId(),
              branchId,
              stationId: input.stationId,
              menuItemId: input.menuItemId ?? null,
              categoryId: input.categoryId ?? null,
              ...(input.priority !== undefined
                ? { priority: input.priority }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.STATION_ROUTING_CREATED,
            entityType: AUDIT_ENTITY.STATION_ROUTING_RULE,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: {
              branchId,
              stationId: created.stationId,
              priority: created.priority,
            },
          });
          return created;
        },
      );
      return toStationRoutingRuleSummary(rule);
    } catch (err) {
      // The composite FK (branch_id, station_id) rejects a station in another
      // branch — and therefore another tenant — structurally.
      rethrowAsNotFoundOnFk(err, STATION_NOT_FOUND);
    }
  }

  listForBranch(
    tenantId: string,
    branchId: string,
  ): Promise<StationRoutingRuleSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        await assertBranchInScope(tx, branchId);
        return tx.stationRoutingRule.findMany({
          where: { branchId },
          orderBy: [{ priority: 'desc' }, { stationId: 'asc' }],
        });
      })
      .then((rows) => rows.map(toStationRoutingRuleSummary));
  }
}
