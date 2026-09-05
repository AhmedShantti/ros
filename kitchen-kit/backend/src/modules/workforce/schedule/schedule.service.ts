/**
 * Schedule / ScheduledShift — §7.3 #26, FR-HRM-010/012.
 *
 * ScheduledShift is a ROSTER PLAN. It is not, and must never become, a
 * second "Operational Shift": that remains `workforce/shifts` (P1D-A), the
 * POS/Treasury runtime/cash relationship, untouched by this file.
 *
 * FR-HRM-012's rule table gives LITERAL default values (max 6 consecutive
 * days, min 11h rest, max 12h shift, max 48h before overtime) — unlike
 * FR-HRM-022/023's grace period and early-clock-in window, which the SRS
 * gives NO number for. Those defaults are therefore enforced here as fixed
 * code constants, not invented. What IS a scope limitation, stated plainly:
 * they are NOT yet per-branch configurable (no override storage exists for
 * them — building one is out of this slice; FR-HRM-012 is reported PARTIAL
 * for that reason). "Warn or block" is resolved to BLOCK for all four: this
 * repository has no notification substrate to carry a warning
 * (`docs/governance/GOVERNANCE_DECISION_REGISTER.md` "N-A" ratified no
 * notification implementation), so a silent warning would be no different
 * from doing nothing.
 */
import {
  BadRequestException,
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

/** FR-HRM-012 literal defaults. See file header for why these are constants. */
const MAX_CONSECUTIVE_DAYS = 6;
const MIN_REST_HOURS = 11;
const MAX_SHIFT_HOURS = 12;
const MAX_WEEKLY_HOURS_BEFORE_OVERTIME = 48;

export interface CreateScheduledShiftInput {
  employeeId: string;
  position?: string;
  startsAt: Date;
  endsAt: Date;
}

function isExclusionViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as
      | { driverAdapterError?: { cause?: { originalCode?: string } } }
      | undefined;
    if (meta?.driverAdapterError?.cause?.originalCode === '23P01') return true;
  }
  return (
    err instanceof Error &&
    /conflicting key value violates exclusion constraint/i.test(err.message)
  );
}

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employees: WorkforceEmployeesService,
  ) {}

  /** FR-HRM-010 — create schedules by branch and week. */
  async createSchedule(
    tenantId: string,
    actorId: string,
    branchId: string,
    weekStartDate: Date,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const branch = await tx.branch.findUnique({ where: { id: branchId } });
        if (!branch) {
          throw new NotFoundException('Branch not found.');
        }

        // Raw INSERT, not `tx.schedule.create` — Prisma's typed `.create()`
        // names EVERY column (DEFAULT for omitted ones), which would need
        // INSERT privilege on `created_at` too and defeat the migration's
        // narrow column-level GRANT (`CashClosePolicyService.create` precedent).
        const id = newId();
        const [schedule] = await tx.$queryRaw<
          {
            id: string;
            tenantId: string;
            branchId: string;
            weekStartDate: Date;
            createdBy: string;
            createdAt: Date;
          }[]
        >`
          INSERT INTO "workforce"."schedules" ("id", "tenant_id", "branch_id", "week_start_date", "created_by")
          VALUES (${id}::uuid, ${tenantId}::uuid, ${branchId}::uuid, ${weekStartDate}::date, ${actorId}::uuid)
          RETURNING
            "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
            "week_start_date" AS "weekStartDate", "created_by" AS "createdBy",
            "created_at" AS "createdAt"
        `;

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.SCHEDULE_CREATED,
          entityType: AUDIT_ENTITY.SCHEDULE,
          actorType: 'user',
          actorId,
          entityId: schedule.id,
          metadata: { branchId, weekStartDate: weekStartDate.toISOString() },
        });

        return schedule;
      },
    );
  }

  /** FR-HRM-010/012 — create one scheduled shift, validated. */
  async createScheduledShift(
    tenantId: string,
    actorId: string,
    scheduleId: string,
    input: CreateScheduledShiftInput,
  ) {
    if (input.startsAt >= input.endsAt) {
      throw new BadRequestException('startsAt must be before endsAt.');
    }
    const shiftHours =
      (input.endsAt.getTime() - input.startsAt.getTime()) / (1000 * 60 * 60);
    if (shiftHours > MAX_SHIFT_HOURS) {
      throw new BadRequestException(
        `FR-HRM-012: a scheduled shift may not exceed ${MAX_SHIFT_HOURS} hours.`,
      );
    }

    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const schedule = await tx.schedule.findUnique({
          where: { id: scheduleId },
        });
        if (!schedule) {
          throw new NotFoundException('Schedule not found.');
        }

        const facts = await this.employees.activeEmploymentFacts(
          tx,
          tenantId,
          input.employeeId,
        );
        if (!facts) {
          throw new NotFoundException('Employee not found.');
        }
        if (!facts.active) {
          throw new ConflictException(
            'FR-HRM-012: an inactive employee cannot be scheduled.',
          );
        }
        if (!facts.permittedBranchIds.includes(schedule.branchId)) {
          throw new ConflictException(
            'FR-HRM-012: the employee is not permitted for this branch.',
          );
        }

        await this.assertMinRest(tx, tenantId, input.employeeId, input);
        await this.assertMaxConsecutiveDays(
          tx,
          tenantId,
          input.employeeId,
          input,
        );
        await this.assertMaxWeeklyHours(
          tx,
          tenantId,
          input.employeeId,
          schedule.weekStartDate,
          shiftHours,
        );

        // Raw INSERT — see `createSchedule`'s comment: Prisma's typed
        // `.create()` would name `created_at` too and defeat the narrow grant.
        const shiftId = newId();
        let shift: {
          id: string;
          tenantId: string;
          branchId: string;
          scheduleId: string;
          employeeId: string;
          position: string | null;
          startsAt: Date;
          endsAt: Date;
          createdBy: string;
          createdAt: Date;
        };
        try {
          [shift] = await tx.$queryRaw<(typeof shift)[]>`
            INSERT INTO "workforce"."scheduled_shifts" (
              "id", "tenant_id", "branch_id", "schedule_id", "employee_id",
              "position", "starts_at", "ends_at", "created_by"
            ) VALUES (
              ${shiftId}::uuid, ${tenantId}::uuid, ${schedule.branchId}::uuid,
              ${scheduleId}::uuid, ${input.employeeId}::uuid,
              ${input.position ?? null}, ${input.startsAt}::timestamptz,
              ${input.endsAt}::timestamptz, ${actorId}::uuid
            )
            RETURNING
              "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
              "schedule_id" AS "scheduleId", "employee_id" AS "employeeId",
              "position", "starts_at" AS "startsAt", "ends_at" AS "endsAt",
              "created_by" AS "createdBy", "created_at" AS "createdAt"
          `;
        } catch (err) {
          if (isExclusionViolation(err)) {
            throw new ConflictException(
              'SRS §7.3 #26: this employee already has an overlapping scheduled shift.',
            );
          }
          throw err;
        }

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.SCHEDULED_SHIFT_CREATED,
          entityType: AUDIT_ENTITY.SCHEDULED_SHIFT,
          actorType: 'user',
          actorId,
          entityId: shift.id,
          metadata: {
            scheduleId,
            employeeId: input.employeeId,
            startsAt: input.startsAt.toISOString(),
            endsAt: input.endsAt.toISOString(),
          },
        });

        return shift;
      },
    );
  }

  private async assertMinRest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    input: CreateScheduledShiftInput,
  ): Promise<void> {
    const windowStart = new Date(
      input.startsAt.getTime() - 48 * 60 * 60 * 1000,
    );
    const windowEnd = new Date(input.endsAt.getTime() + 48 * 60 * 60 * 1000);
    const neighbours = await tx.scheduledShift.findMany({
      where: {
        tenantId,
        employeeId,
        startsAt: { lt: windowEnd },
        endsAt: { gt: windowStart },
      },
      select: { startsAt: true, endsAt: true },
    });
    const minRestMs = MIN_REST_HOURS * 60 * 60 * 1000;
    for (const n of neighbours) {
      const gapBefore = input.startsAt.getTime() - n.endsAt.getTime();
      const gapAfter = n.startsAt.getTime() - input.endsAt.getTime();
      if (
        (gapBefore >= 0 && gapBefore < minRestMs) ||
        (gapAfter >= 0 && gapAfter < minRestMs)
      ) {
        throw new ConflictException(
          `FR-HRM-012: less than ${MIN_REST_HOURS} hours rest between shifts for this employee.`,
        );
      }
    }
  }

  private async assertMaxConsecutiveDays(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    input: CreateScheduledShiftInput,
  ): Promise<void> {
    const windowStart = new Date(
      input.startsAt.getTime() - 14 * 24 * 60 * 60 * 1000,
    );
    const windowEnd = new Date(
      input.endsAt.getTime() + 14 * 24 * 60 * 60 * 1000,
    );
    const neighbours = await tx.scheduledShift.findMany({
      where: {
        tenantId,
        employeeId,
        startsAt: { gte: windowStart, lte: windowEnd },
      },
      select: { startsAt: true },
    });
    const days = new Set<string>();
    for (const n of neighbours) {
      days.add(n.startsAt.toISOString().slice(0, 10));
    }
    days.add(input.startsAt.toISOString().slice(0, 10));

    const sorted = [...days].sort();
    let run = 1;
    let longest = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1] + 'T00:00:00Z').getTime();
      const cur = new Date(sorted[i] + 'T00:00:00Z').getTime();
      if (cur - prev === 24 * 60 * 60 * 1000) {
        run += 1;
        longest = Math.max(longest, run);
      } else {
        run = 1;
      }
    }
    if (longest > MAX_CONSECUTIVE_DAYS) {
      throw new ConflictException(
        `FR-HRM-012: this would schedule the employee for more than ${MAX_CONSECUTIVE_DAYS} consecutive days.`,
      );
    }
  }

  private async assertMaxWeeklyHours(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
    weekStartDate: Date,
    newShiftHours: number,
  ): Promise<void> {
    const weekEnd = new Date(weekStartDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const existing = await tx.scheduledShift.findMany({
      where: {
        tenantId,
        employeeId,
        startsAt: { gte: weekStartDate, lt: weekEnd },
      },
      select: { startsAt: true, endsAt: true },
    });
    const existingHours = existing.reduce(
      (sum, s) =>
        sum + (s.endsAt.getTime() - s.startsAt.getTime()) / (1000 * 60 * 60),
      0,
    );
    if (existingHours + newShiftHours > MAX_WEEKLY_HOURS_BEFORE_OVERTIME) {
      throw new ConflictException(
        `FR-HRM-012: this would take the employee's scheduled week above ${MAX_WEEKLY_HOURS_BEFORE_OVERTIME} hours.`,
      );
    }
  }

  async getSchedule(tenantId: string, scheduleId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.schedule.findUnique({
        where: { id: scheduleId },
        include: { shifts: { orderBy: { startsAt: 'asc' } } },
      }),
    );
  }
}
