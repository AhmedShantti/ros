import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  AttendanceSummaryFacts,
  AttendanceSummaryQuery,
  AttendanceSummaryQueryInput,
} from '../contract/attendance-summary.query';

/**
 * PRIVATE Prisma-backed implementation of `AttendanceSummaryQuery`
 * (`workforce/contract/attendance-summary.query.ts`). Bound to
 * `ATTENDANCE_SUMMARY_QUERY` only inside `WorkforceModule` (`useExisting`)
 * — never imported directly by a consumer.
 */
@Injectable()
export class AttendanceSummaryQueryService implements AttendanceSummaryQuery {
  async forBranch(
    tx: Prisma.TransactionClient,
    input: AttendanceSummaryQueryInput,
  ): Promise<AttendanceSummaryFacts> {
    const [clockedInCount, windowed] = await Promise.all([
      tx.attendanceRecord.count({
        where: {
          tenantId: input.tenantId,
          branchId: input.branchId,
          status: 'open',
        },
      }),
      tx.attendanceRecord.findMany({
        where: {
          tenantId: input.tenantId,
          branchId: input.branchId,
          clockInAt: { gte: input.windowFrom, lt: input.windowTo },
        },
        select: {
          lateArrival: true,
          earlyDeparture: true,
          unscheduled: true,
          outsideGeofence: true,
          missingClockOut: true,
        },
      }),
    ]);
    return {
      clockedInCount,
      attendanceRecordCount: windowed.length,
      lateArrivalCount: windowed.filter((r) => r.lateArrival).length,
      earlyDepartureCount: windowed.filter((r) => r.earlyDeparture).length,
      unscheduledCount: windowed.filter((r) => r.unscheduled).length,
      outsideGeofenceCount: windowed.filter((r) => r.outsideGeofence).length,
      missingClockOutCount: windowed.filter((r) => r.missingClockOut).length,
    };
  }
}
