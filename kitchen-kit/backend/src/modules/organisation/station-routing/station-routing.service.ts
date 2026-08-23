import { BadRequestException, Injectable } from '@nestjs/common';
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

const STATION_NOT_FOUND =
  'Station, menu item, category, or modifier not found.';
const DUPLICATE_RULE =
  'A routing rule for this selector and station already exists.';
const SELECTOR_MESSAGE =
  'Exactly one of menuItemId, categoryId, or modifierId must be set.';

export interface CreateStationRoutingRuleInput {
  stationId: string;
  menuItemId?: string;
  categoryId?: string;
  modifierId?: string;
  priority?: number;
}

function assertExactlyOneSelector(input: CreateStationRoutingRuleInput): void {
  const count = [input.menuItemId, input.categoryId, input.modifierId].filter(
    (v) => v !== undefined,
  ).length;
  if (count !== 1) {
    throw new BadRequestException(SELECTOR_MESSAGE);
  }
}

/**
 * Station routing rules — `kitchen.station_routing_rules`.
 *
 * The table lives in the `kitchen` schema because SRS §25.1 places it there
 * (ADR 0008 D-06). Only the Organisation-side CONFIGURATION is implemented:
 * no tickets, no ticket lines. FR-KDS-010 resolution is implemented by the
 * Kitchen module's private resolver, reading this configuration only through
 * `organisation/contract` — never these rows directly.
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
    assertExactlyOneSelector(input);
    try {
      const rule = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          await assertBranchInScope(tx, branchId);
          const created = await tx.stationRoutingRule.create({
            data: {
              id: newId(),
              tenantId,
              branchId,
              stationId: input.stationId,
              menuItemId: input.menuItemId ?? null,
              categoryId: input.categoryId ?? null,
              modifierId: input.modifierId ?? null,
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
      // The composite FKs (tenant_id+branch_id, tenant_id+selector) reject a
      // station/menu item/category/modifier outside this tenant/branch
      // structurally; the unique index rejects a duplicate (selector,
      // station) pair.
      rethrowAsNotFoundOnFk(err, STATION_NOT_FOUND, DUPLICATE_RULE);
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
