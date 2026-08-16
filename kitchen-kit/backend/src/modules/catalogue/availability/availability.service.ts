import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { parseTimeOfDay } from '../../organisation/operating-hours/time-of-day';
import { toAvailabilityRuleView } from '../catalogue.views';

export interface CreateAvailabilityRuleInput {
  menuItemId?: string;
  variantId?: string;
  branchId?: string;
  channel?: string;
  dayOfWeek?: number;
  startsAt?: string;
  endsAt?: string;
}

/**
 * Availability configuration and manual 86 (FR-MNU-030/031/032).
 *
 * C-07 boundary: this service owns CONFIGURATION and manual availability only.
 * `quantity_sold_today` and `daily_quantity_limit` do NOT exist — FR-MNU-035's
 * daily limit decrementing on sale is Sales runtime state and is deferred, so
 * Sales never writes a Catalogue-owned row.
 *
 * FR-MNU-031 (auto-86 on zero stock) is NOT implemented: it depends on Inventory,
 * which is out of scope. The branch-level switch it keys off
 * (`org.branches.automatic_availability`) already exists from Phase 15.
 *
 * A rule targets EXACTLY ONE of menuItem / variant — enforced here for a clear
 * 400 and by the DB CHECK `ck_availability_target_xor` as the final boundary.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createRule(
    tenantId: string,
    actorId: string,
    input: CreateAvailabilityRuleInput,
  ) {
    const hasItem = input.menuItemId !== undefined;
    const hasVariant = input.variantId !== undefined;
    if (hasItem === hasVariant) {
      throw new BadRequestException(
        'An availability rule must target exactly one of menuItemId or variantId.',
      );
    }

    try {
      const rule = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const created = await tx.availabilityRule.create({
            data: {
              id: newId(),
              tenantId,
              menuItemId: input.menuItemId ?? null,
              variantId: input.variantId ?? null,
              branchId: input.branchId ?? null,
              channel: input.channel ?? null,
              dayOfWeek: input.dayOfWeek ?? null,
              startsAt: input.startsAt ? parseTimeOfDay(input.startsAt) : null,
              endsAt: input.endsAt ? parseTimeOfDay(input.endsAt) : null,
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.AVAILABILITY_RULE_CREATED,
            entityType: AUDIT_ENTITY.AVAILABILITY_RULE,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: {
              menuItemId: created.menuItemId,
              variantId: created.variantId,
              branchId: created.branchId,
            },
          });
          return created;
        },
      );
      return toAvailabilityRuleView(rule);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, 'Menu item, variant or branch not found.');
    }
  }

  list(tenantId: string, menuItemId?: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.availabilityRule.findMany({
          ...(menuItemId ? { where: { menuItemId } } : {}),
        }),
      )
      .then((rows) => rows.map(toAvailabilityRuleView));
  }

  /**
   * FR-MNU-030/032: manual 86 and its authorised override, both recorded.
   * Guarded by `menu.availability.toggle`, not by the manage permission.
   */
  async toggle86(
    tenantId: string,
    actorId: string,
    ruleId: string,
    isManual86: boolean,
    autoReenableAt?: string,
    reasonText?: string,
  ) {
    const rule = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.availabilityRule.findUnique({
          where: { id: ruleId },
        });
        if (!existing) {
          throw new NotFoundException('Availability rule not found.');
        }
        const updated = await tx.availabilityRule.update({
          where: { id: ruleId },
          data: {
            isManual86,
            autoReenableAt: autoReenableAt ? new Date(autoReenableAt) : null,
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.AVAILABILITY_86_TOGGLED,
          entityType: AUDIT_ENTITY.AVAILABILITY_RULE,
          actorType: 'user',
          actorId,
          entityId: ruleId,
          before: { isManual86: existing.isManual86 },
          metadata: {
            isManual86: updated.isManual86,
            autoReenableAt: updated.autoReenableAt?.toISOString() ?? null,
          },
          reasonCode: isManual86 ? 'manual_86' : 'manual_86_cleared',
          reasonText: reasonText ?? null,
        });
        return updated;
      },
    );
    return toAvailabilityRuleView(rule);
  }
}
