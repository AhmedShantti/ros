import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/** PRIVATE implementation of `WORKFORCE_SCHEDULE_TARGET_RESOLVER`. */
@Injectable()
export class ScheduleTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const scheduleId = input.keys.scheduleId;
    if (!scheduleId) return null;
    const schedule = await tx.schedule.findUnique({
      where: { id: scheduleId },
      select: { branchId: true },
    });
    return schedule ? { type: 'branch', branchId: schedule.branchId } : null;
  }
}
