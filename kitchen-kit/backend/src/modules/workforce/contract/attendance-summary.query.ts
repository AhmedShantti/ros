import { Prisma } from '../../../generated/prisma/client';

/**
 * Workforce PUBLIC contract — a branch-scoped attendance summary for the
 * Reporting Overview (RPT-DEMO-1). No overtime calculation and no Country
 * Pack labour-rule logic is exposed or implied here — those remain absent
 * per HR-1's scope.
 *
 * `clockedInCount` is a LIVE gauge — `AttendanceRecord.status = 'open'` for
 * this branch RIGHT NOW — not scoped to `windowFrom`/`windowTo` (an
 * employee who clocked in yesterday and is still on shift is still "clocked
 * in now"). Every other count is scoped to `AttendanceRecord.clockInAt IN
 * [windowFrom, windowTo)` — a CALENDAR window, not a POS business day:
 * `workforce.attendance_records` carries no business-day column and none is
 * invented here (RPT-DEMO-1 §5 — see the Reporting response's own
 * `workforce.notes`).
 *
 * The five flags counted below (`FR-HRM-022`) are INDEPENDENT — an
 * AttendanceRecord may set more than one, so these counts do not sum to
 * `attendanceRecordCount`.
 *
 * `tx`-FIRST — composed inside the Reporting overview's own RepeatableRead
 * transaction, sharing its MVCC snapshot.
 */
export const ATTENDANCE_SUMMARY_QUERY = Symbol('ATTENDANCE_SUMMARY_QUERY');

export interface AttendanceSummaryQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly windowFrom: Date;
  readonly windowTo: Date;
}

export interface AttendanceSummaryFacts {
  readonly clockedInCount: number;
  readonly attendanceRecordCount: number;
  readonly lateArrivalCount: number;
  readonly earlyDepartureCount: number;
  readonly unscheduledCount: number;
  readonly outsideGeofenceCount: number;
  readonly missingClockOutCount: number;
}

export interface AttendanceSummaryQuery {
  forBranch(
    tx: Prisma.TransactionClient,
    input: AttendanceSummaryQueryInput,
  ): Promise<AttendanceSummaryFacts>;
}
