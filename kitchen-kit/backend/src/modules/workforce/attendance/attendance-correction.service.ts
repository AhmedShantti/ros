/**
 * FR-HRM-025 — manual attendance corrections.
 *
 * The `ClockEvent` row(s) the record was derived from are NEVER touched —
 * this service only ever writes `AttendanceRecord` (the mutable projection)
 * and appends an `AttendanceCorrection` (immutable evidence: actor, reason,
 * before, after). "Preserve the original value" means the ORIGINAL clock
 * event stays exactly as recorded, and this correction's own `originalValue`
 * captures what the projection held immediately before THIS change — a chain
 * of corrections stays fully reconstructable from these rows alone.
 */
import {
  BadRequestException,
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

export interface CorrectAttendanceInput {
  field: 'clock_in_at' | 'clock_out_at';
  correctedValue: Date;
  reason: string;
}

function isCheckViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as
      | { driverAdapterError?: { cause?: { originalCode?: string } } }
      | undefined;
    if (meta?.driverAdapterError?.cause?.originalCode === '23514') return true;
  }
  return err instanceof Error && /violates check constraint/i.test(err.message);
}

@Injectable()
export class AttendanceCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async correct(
    tenantId: string,
    actorId: string,
    attendanceRecordId: string,
    input: CorrectAttendanceInput,
  ) {
    if (input.reason.trim().length === 0) {
      throw new BadRequestException('reason must not be blank.');
    }

    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const record = await tx.attendanceRecord.findUnique({
          where: { id: attendanceRecordId },
        });
        if (!record) {
          throw new NotFoundException('Attendance record not found.');
        }

        const originalValue =
          input.field === 'clock_in_at' ? record.clockInAt : record.clockOutAt;
        const wasResolvingMissingClockOut =
          input.field === 'clock_out_at' && record.clockOutAt === null;

        try {
          await tx.attendanceRecord.update({
            where: { id: attendanceRecordId },
            data: {
              ...(input.field === 'clock_in_at'
                ? { clockInAt: input.correctedValue }
                : {
                    clockOutAt: input.correctedValue,
                    status: 'closed' as const,
                  }),
              ...(wasResolvingMissingClockOut ? { missingClockOut: true } : {}),
            },
          });
        } catch (err) {
          if (isCheckViolation(err)) {
            throw new BadRequestException(
              'That correction would put clock-out at or before clock-in.',
            );
          }
          throw err;
        }

        // Raw INSERT, not `tx.attendanceCorrection.create` — Prisma's typed
        // `.create()` names EVERY column (DEFAULT for omitted ones), which
        // would need INSERT privilege on `created_at` too and defeat the
        // migration's narrow column-level GRANT.
        const correctionId = newId();
        const [correction] = await tx.$queryRaw<
          {
            id: string;
            tenantId: string;
            branchId: string;
            employeeId: string;
            attendanceRecordId: string;
            field: 'clock_in_at' | 'clock_out_at';
            originalValue: Date | null;
            correctedValue: Date;
            reason: string;
            actorId: string;
            createdAt: Date;
          }[]
        >`
          INSERT INTO "workforce"."attendance_corrections" (
            "id", "tenant_id", "branch_id", "employee_id", "attendance_record_id",
            "field", "original_value", "corrected_value", "reason", "actor_id"
          ) VALUES (
            ${correctionId}::uuid, ${tenantId}::uuid, ${record.branchId}::uuid,
            ${record.employeeId}::uuid, ${attendanceRecordId}::uuid,
            ${input.field}::"workforce"."AttendanceCorrectionField",
            ${originalValue}::timestamptz, ${input.correctedValue}::timestamptz,
            ${input.reason}, ${actorId}::uuid
          )
          RETURNING
            "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
            "employee_id" AS "employeeId", "attendance_record_id" AS "attendanceRecordId",
            "field", "original_value" AS "originalValue", "corrected_value" AS "correctedValue",
            "reason", "actor_id" AS "actorId", "created_at" AS "createdAt"
        `;

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ATTENDANCE_CORRECTED,
          entityType: AUDIT_ENTITY.ATTENDANCE_CORRECTION,
          actorType: 'user',
          actorId,
          entityId: correction.id,
          reasonText: input.reason,
          before: { [input.field]: originalValue?.toISOString() ?? null },
          metadata: {
            attendanceRecordId,
            field: input.field,
            correctedValue: input.correctedValue.toISOString(),
          },
        });

        return correction;
      },
    );
  }
}
