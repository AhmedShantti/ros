import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/** PRIVATE implementation of `WORKFORCE_ATTENDANCE_RECORD_TARGET_RESOLVER`. */
@Injectable()
export class AttendanceRecordTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const attendanceRecordId = input.keys.attendanceRecordId;
    if (!attendanceRecordId) return null;
    const record = await tx.attendanceRecord.findUnique({
      where: { id: attendanceRecordId },
      select: { branchId: true },
    });
    return record ? { type: 'branch', branchId: record.branchId } : null;
  }
}
