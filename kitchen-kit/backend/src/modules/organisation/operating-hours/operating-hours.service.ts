import { BadRequestException, Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { assertBranchInScope } from '../branch-scope';
import {
  OperatingHoursSummary,
  toOperatingHoursSummary,
} from './operating-hours.view';
import { intervalsOverlap, parseTimeOfDay } from './time-of-day';

export interface CreateOperatingHoursInput {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  businessDayCutover?: string;
}

/**
 * Branch operating hours (Branch aggregate).
 *
 * ADR 0008 D-04: multiple intervals per weekday are permitted so split shifts
 * (11:00–15:00 and 18:00–23:00) can be modelled — the approved SQL deliberately
 * carries no unique constraint. *Overlapping* intervals on the same weekday are
 * rejected with 400. Whether an overnight interval conflicts with the following
 * day's morning interval is NOT defined by the SRS, so no policy is invented for
 * it; the check is scoped to a single weekday.
 *
 * There is no delete or deactivate operation: ADR 0008 D-12 ratified that Phase
 * 15 exposes none for any Organisation entity. Removing a mis-entered interval
 * therefore requires a later phase; that limitation is recorded, not worked
 * around.
 */
@Injectable()
export class OperatingHoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    branchId: string,
    input: CreateOperatingHoursInput,
  ): Promise<OperatingHoursSummary> {
    const opensAt = parseTimeOfDay(input.opensAt);
    const closesAt = parseTimeOfDay(input.closesAt);

    const row = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        await assertBranchInScope(tx, branchId);

        const sameDay = await tx.operatingHours.findMany({
          where: { branchId, dayOfWeek: input.dayOfWeek },
          select: { opensAt: true, closesAt: true },
        });
        const clash = sameDay.some((existing) =>
          intervalsOverlap(existing, { opensAt, closesAt }),
        );
        if (clash) {
          throw new BadRequestException(
            'Operating hours overlap an existing interval for this day.',
          );
        }

        const created = await tx.operatingHours.create({
          data: {
            id: newId(),
            branchId,
            dayOfWeek: input.dayOfWeek,
            opensAt,
            closesAt,
            ...(input.businessDayCutover !== undefined
              ? {
                  businessDayCutover: parseTimeOfDay(input.businessDayCutover),
                }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.OPERATING_HOURS_CREATED,
          entityType: AUDIT_ENTITY.OPERATING_HOURS,
          actorType: 'user',
          actorId,
          entityId: created.id,
          metadata: {
            branchId,
            dayOfWeek: created.dayOfWeek,
            opensAt: input.opensAt,
            closesAt: input.closesAt,
          },
        });
        return created;
      },
    );
    return toOperatingHoursSummary(row);
  }

  listForBranch(
    tenantId: string,
    branchId: string,
  ): Promise<OperatingHoursSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        await assertBranchInScope(tx, branchId);
        return tx.operatingHours.findMany({
          where: { branchId },
          orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
        });
      })
      .then((rows) => rows.map(toOperatingHoursSummary));
  }
}
