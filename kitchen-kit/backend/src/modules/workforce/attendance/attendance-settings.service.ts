/**
 * FR-HRM-022/023 configurable thresholds — IMMUTABLE versioned rows, the
 * `treasury/cash-close-policy` shape. See the migration header and
 * `AttendanceSettings`'s schema doc-comment for why `graceMinutes` and
 * `earlyClockInMinutes` carry no invented default: an absent/NULL value
 * means that SPECIFIC check is INACTIVE for the branch, never zero and
 * never unlimited.
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

export interface SetAttendanceSettingsInput {
  branchId: string;
  graceMinutes?: number;
  earlyClockInMinutes?: number;
  /** Server-side geofence MODEL only — see the migration header. All three or none. */
  geofenceCenterLat?: number;
  geofenceCenterLng?: number;
  geofenceRadiusMeters?: number;
  effectiveFrom?: Date;
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
export class AttendanceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async set(
    tenantId: string,
    actorId: string,
    input: SetAttendanceSettingsInput,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const branch = await tx.branch.findUnique({
          where: { id: input.branchId },
        });
        if (!branch) {
          throw new NotFoundException('Branch not found.');
        }

        // Raw INSERT, not `tx.attendanceSettings.create` — Prisma's typed
        // `.create()` names EVERY column (DEFAULT for omitted ones), which
        // would need INSERT privilege on `created_at` too and defeat the
        // migration's narrow column-level GRANT.
        const id = newId();
        const effectiveFrom = input.effectiveFrom ?? null;
        let row: {
          id: string;
          tenantId: string;
          branchId: string;
          effectiveFrom: Date;
          graceMinutes: number | null;
          earlyClockInMinutes: number | null;
          geofenceCenterLat: Prisma.Decimal | null;
          geofenceCenterLng: Prisma.Decimal | null;
          geofenceRadiusMeters: number | null;
          createdBy: string;
          createdAt: Date;
        };
        try {
          [row] = await tx.$queryRaw<(typeof row)[]>`
            INSERT INTO "workforce"."attendance_settings" (
              "id", "tenant_id", "branch_id", "effective_from", "grace_minutes",
              "early_clock_in_minutes", "geofence_center_lat", "geofence_center_lng",
              "geofence_radius_meters", "created_by"
            ) VALUES (
              ${id}::uuid, ${tenantId}::uuid, ${input.branchId}::uuid,
              COALESCE(${effectiveFrom}::timestamptz, statement_timestamp()),
              ${input.graceMinutes ?? null}, ${input.earlyClockInMinutes ?? null},
              ${input.geofenceCenterLat ?? null}, ${input.geofenceCenterLng ?? null},
              ${input.geofenceRadiusMeters ?? null}, ${actorId}::uuid
            )
            RETURNING
              "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
              "effective_from" AS "effectiveFrom", "grace_minutes" AS "graceMinutes",
              "early_clock_in_minutes" AS "earlyClockInMinutes",
              "geofence_center_lat" AS "geofenceCenterLat",
              "geofence_center_lng" AS "geofenceCenterLng",
              "geofence_radius_meters" AS "geofenceRadiusMeters",
              "created_by" AS "createdBy", "created_at" AS "createdAt"
          `;
        } catch (err) {
          if (isCheckViolation(err)) {
            throw new BadRequestException(
              'Geofence centre and radius must be set together, or not at all.',
            );
          }
          throw err;
        }

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ATTENDANCE_SETTINGS_VERSION_CREATED,
          entityType: AUDIT_ENTITY.ATTENDANCE_SETTINGS,
          actorType: 'user',
          actorId,
          entityId: row.id,
          metadata: {
            branchId: input.branchId,
            graceMinutes: input.graceMinutes ?? null,
            earlyClockInMinutes: input.earlyClockInMinutes ?? null,
          },
        });

        return row;
      },
    );
  }

  /** Latest version effective at or before `asOf` (default now), or `null` if unconfigured. */
  async resolve(tenantId: string, branchId: string, asOf: Date = new Date()) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.resolveTx(tx, tenantId, branchId, asOf),
    );
  }

  /**
   * Same resolution, taking the CALLER's transaction — for
   * `AttendanceService.clockIn`, which must read this inside its own
   * transaction (nested `withAuthContext` is unsupported).
   */
  resolveTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    asOf: Date = new Date(),
  ) {
    return tx.attendanceSettings.findFirst({
      where: { tenantId, branchId, effectiveFrom: { lte: asOf } },
      orderBy: { effectiveFrom: 'desc' },
    });
  }
}
