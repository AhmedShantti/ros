/**
 * Attendance — §7.3 #27, FR-HRM-020/021/022/023.
 *
 * `AttendanceRecord` is the worked-period aggregate; `ClockEvent` is its
 * immutable evidence. See the migration header and the models' own
 * doc-comments for the mutable-projection / immutable-evidence split.
 *
 * ── FR-HRM-023 ATOMICITY ─────────────────────────────────────────────────
 * The early-clock-in check and the attendance-record insert happen inside
 * ONE transaction, against an IMMUTABLE `ScheduledShift` row (nothing
 * concurrent can move its `startsAt`) and a monotonic server clock — there
 * is no shared mutable state between the check and the insert for a race to
 * exploit. The one real concurrency hazard — two simultaneous clock-ins for
 * the SAME employee — is closed by `uq_attendance_one_open_per_employee`
 * (a real Postgres partial unique index), not by a read-then-insert
 * check: the second concurrent INSERT simply fails with a unique violation,
 * which this service turns into a clean 409, never a second open record.
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { WorkforceEmployeesService } from '../employees/employees.service';
import { AttendanceSettingsService } from './attendance-settings.service';

export interface Gps {
  lat: number;
  lng: number;
}

export interface ClockInInput {
  employeeId: string;
  branchId: string;
  terminalId: string;
  gps?: Gps;
  /**
   * Testability seam ONLY — never populated by `AttendanceController`
   * (which always clocks in at real server time). Exists so the FR-HRM-023
   * EXACT-boundary case ("exactly at allowed boundary => accept") can be
   * tested deterministically at the service layer, since no external HTTP
   * caller can hit a millisecond-exact wall-clock instant.
   */
  now?: Date;
}

export interface ClockOutInput {
  employeeId: string;
  terminalId: string;
  gps?: Gps;
  /** Testability seam ONLY — see `ClockInInput.now`'s doc-comment. */
  now?: Date;
}

export interface AttendanceRecordRow {
  id: string;
  tenantId: string;
  branchId: string;
  employeeId: string;
  scheduledShiftId: string | null;
  status: 'open' | 'closed';
  clockInAt: Date;
  clockOutAt: Date | null;
  lateArrival: boolean;
  earlyDeparture: boolean;
  missingClockOut: boolean;
  outsideGeofence: boolean;
  unscheduled: boolean;
  createdAt: Date;
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as
      | { driverAdapterError?: { cause?: { originalCode?: string } } }
      | undefined;
    if (meta?.driverAdapterError?.cause?.originalCode === '23505') return true;
  }
  return (
    err instanceof Error &&
    /duplicate key value violates unique constraint/i.test(err.message)
  );
}

/** Metres between two WGS-84 points (haversine). */
function haversineMetres(a: Gps, b: Gps): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: WorkforceEmployeesService,
    private readonly settings: AttendanceSettingsService,
  ) {}

  /**
   * Find the scheduled shift this clock-in is most plausibly for: the
   * employee's shift at this branch whose `startsAt` is closest to `now`,
   * among shifts starting or ending within 12 hours of `now`. The SRS gives
   * no exact matching algorithm; this is a documented, bounded heuristic — a
   * shift next week never matches today's clock-in.
   */
  /**
   * FR-HRM-021 — append the immutable clock event. Raw INSERT, not
   * `tx.clockEvent.create`: Prisma's typed `.create()` names EVERY column
   * (DEFAULT for omitted ones), which would need INSERT privilege on
   * `occurred_at` too and defeat the migration's narrow column-level GRANT —
   * `occurred_at` is deliberately DB-defaulted and un-writable so the
   * process clock can never forge it.
   */
  private async insertClockEvent(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      branchId: string;
      employeeId: string;
      attendanceRecordId: string;
      eventType: 'clock_in' | 'clock_out';
      terminalId: string;
      gps?: Gps;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "workforce"."clock_events" (
        "id", "tenant_id", "branch_id", "employee_id", "attendance_record_id",
        "event_type", "method", "terminal_id", "gps_lat", "gps_lng"
      ) VALUES (
        ${newId()}::uuid, ${input.tenantId}::uuid, ${input.branchId}::uuid,
        ${input.employeeId}::uuid, ${input.attendanceRecordId}::uuid,
        ${input.eventType}::"workforce"."ClockEventType", 'pos_pin', ${input.terminalId}::uuid,
        ${input.gps?.lat ?? null}, ${input.gps?.lng ?? null}
      )
    `;
  }

  private async findMatchingScheduledShift(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    employeeId: string,
    now: Date,
  ) {
    const WINDOW_MS = 12 * 60 * 60 * 1000;
    const candidates = await tx.scheduledShift.findMany({
      where: {
        tenantId,
        branchId,
        employeeId,
        startsAt: { gte: new Date(now.getTime() - WINDOW_MS) },
        endsAt: { lte: new Date(now.getTime() + WINDOW_MS) },
      },
    });
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) =>
        Math.abs(a.startsAt.getTime() - now.getTime()) -
        Math.abs(b.startsAt.getTime() - now.getTime()),
    );
    return candidates[0];
  }

  /** FR-HRM-020/021/022/023 — POS-terminal PIN clock-in. */
  async clockIn(tenantId: string, actorId: string, input: ClockInInput) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const facts = await this.employees.activeEmploymentFacts(
          tx,
          tenantId,
          input.employeeId,
        );
        if (!facts) {
          throw new NotFoundException('Employee not found.');
        }
        if (!facts.active) {
          throw new ConflictException('Inactive employee cannot clock in.');
        }
        if (!facts.permittedBranchIds.includes(input.branchId)) {
          throw new ConflictException(
            'FR-SEC-021: employee is not permitted for this branch.',
          );
        }

        const now = input.now ?? new Date();
        const scheduledShift = await this.findMatchingScheduledShift(
          tx,
          tenantId,
          input.branchId,
          input.employeeId,
          now,
        );

        let lateArrival = false;
        let unscheduled = false;

        if (scheduledShift) {
          const attendanceSettings = await this.settings.resolveTx(
            tx,
            tenantId,
            input.branchId,
            now,
          );

          // FR-HRM-023 — enforced atomically, in this same transaction,
          // against the immutable scheduled shift. NULL = not configured =
          // this specific check is inactive (see the settings service doc).
          if (attendanceSettings?.earlyClockInMinutes != null) {
            const boundary = new Date(
              scheduledShift.startsAt.getTime() -
                attendanceSettings.earlyClockInMinutes * 60_000,
            );
            if (now < boundary) {
              throw new ConflictException(
                `FR-HRM-023: too early to clock in. Earliest allowed: ${boundary.toISOString()}.`,
              );
            }
          }

          if (attendanceSettings?.graceMinutes != null) {
            const graceBoundary = new Date(
              scheduledShift.startsAt.getTime() +
                attendanceSettings.graceMinutes * 60_000,
            );
            lateArrival = now > graceBoundary;
          }
        } else {
          unscheduled = true;
        }

        let outsideGeofence = false;
        if (input.gps) {
          const attendanceSettings = await this.settings.resolveTx(
            tx,
            tenantId,
            input.branchId,
            now,
          );
          if (
            attendanceSettings?.geofenceCenterLat != null &&
            attendanceSettings.geofenceCenterLng != null &&
            attendanceSettings.geofenceRadiusMeters != null
          ) {
            const distance = haversineMetres(input.gps, {
              lat: Number(attendanceSettings.geofenceCenterLat),
              lng: Number(attendanceSettings.geofenceCenterLng),
            });
            outsideGeofence =
              distance > attendanceSettings.geofenceRadiusMeters;
          }
        }

        // Raw INSERT, not `tx.attendanceRecord.create` — Prisma's typed
        // `.create()` names EVERY column (DEFAULT for omitted ones), which
        // would need INSERT privilege on `created_at` too and defeat the
        // migration's narrow column-level GRANT (`CashClosePolicyService.create`
        // precedent — see the migration header).
        const recordId = newId();
        let record: AttendanceRecordRow;
        try {
          [record] = await tx.$queryRaw<AttendanceRecordRow[]>`
            INSERT INTO "workforce"."attendance_records" (
              "id", "tenant_id", "branch_id", "employee_id", "scheduled_shift_id",
              "status", "clock_in_at", "late_arrival", "unscheduled", "outside_geofence"
            ) VALUES (
              ${recordId}::uuid, ${tenantId}::uuid, ${input.branchId}::uuid,
              ${input.employeeId}::uuid, ${scheduledShift?.id ?? null}::uuid,
              'open', ${now}::timestamptz, ${lateArrival}, ${unscheduled}, ${outsideGeofence}
            )
            RETURNING
              "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
              "employee_id" AS "employeeId", "scheduled_shift_id" AS "scheduledShiftId",
              "status", "clock_in_at" AS "clockInAt", "clock_out_at" AS "clockOutAt",
              "late_arrival" AS "lateArrival", "early_departure" AS "earlyDeparture",
              "missing_clock_out" AS "missingClockOut", "outside_geofence" AS "outsideGeofence",
              "unscheduled", "created_at" AS "createdAt"
          `;
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictException(
              'Employee already has an open attendance record (already clocked in).',
            );
          }
          throw err;
        }

        await this.insertClockEvent(tx, {
          tenantId,
          branchId: input.branchId,
          employeeId: input.employeeId,
          attendanceRecordId: record.id,
          eventType: 'clock_in',
          terminalId: input.terminalId,
          gps: input.gps,
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CLOCK_IN_RECORDED,
          entityType: AUDIT_ENTITY.ATTENDANCE_RECORD,
          actorType: 'user',
          actorId,
          entityId: record.id,
          terminalId: input.terminalId,
          metadata: {
            employeeId: input.employeeId,
            branchId: input.branchId,
            scheduledShiftId: scheduledShift?.id ?? null,
            lateArrival,
            unscheduled,
            outsideGeofence,
          },
        });

        return record;
      },
    );
  }

  /** FR-HRM-020/021/022 — POS-terminal PIN clock-out. */
  async clockOut(tenantId: string, actorId: string, input: ClockOutInput) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const open = await tx.attendanceRecord.findFirst({
          where: { tenantId, employeeId: input.employeeId, status: 'open' },
          include: { scheduledShift: true },
        });
        if (!open) {
          throw new ConflictException(
            'No open attendance record for this employee.',
          );
        }

        const now = input.now ?? new Date();
        const earlyDeparture = open.scheduledShift
          ? now < open.scheduledShift.endsAt
          : false;

        // Atomic close: WHERE status = 'open' means a concurrent second
        // clock-out for the same employee affects zero rows, never a second
        // close (test 38).
        const result = await tx.attendanceRecord.updateMany({
          where: { id: open.id, tenantId, status: 'open' },
          data: { status: 'closed', clockOutAt: now, earlyDeparture },
        });
        if (result.count === 0) {
          throw new ConflictException(
            'No open attendance record for this employee.',
          );
        }

        await this.insertClockEvent(tx, {
          tenantId,
          branchId: open.branchId,
          employeeId: input.employeeId,
          attendanceRecordId: open.id,
          eventType: 'clock_out',
          terminalId: input.terminalId,
          gps: input.gps,
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CLOCK_OUT_RECORDED,
          entityType: AUDIT_ENTITY.ATTENDANCE_RECORD,
          actorType: 'user',
          actorId,
          entityId: open.id,
          terminalId: input.terminalId,
          metadata: { employeeId: input.employeeId, earlyDeparture },
        });

        return {
          ...open,
          status: 'closed' as const,
          clockOutAt: now,
          earlyDeparture,
        };
      },
    );
  }

  async get(tenantId: string, attendanceRecordId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.attendanceRecord.findUnique({
        where: { id: attendanceRecordId },
        include: {
          clockEvents: { orderBy: { occurredAt: 'asc' } },
          corrections: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
  }

  /**
   * FR-HRM-022 "missing clock-out" DETECTION surface. No scheduled job
   * exists in this slice (FR-HRM-024 auto-close is NOT implemented — see the
   * HR-1 report); this is the read-side alternative: attendance records
   * still open a given number of hours after they started.
   */
  async listOpenPastThreshold(
    tenantId: string,
    branchId: string,
    olderThanHours: number,
  ) {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.attendanceRecord.findMany({
        where: { branchId, status: 'open', clockInAt: { lt: cutoff } },
        orderBy: { clockInAt: 'asc' },
      }),
    );
  }
}
