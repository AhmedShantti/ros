/**
 * Employee — the FULL FR-HRM-001..006 aggregate (§7.3 #25).
 *
 * Supersedes, for HR-1 purposes, `identity/employees/employees.service.ts`'s
 * MINIMAL D-2 substrate (code/displayName/homeBranch/userId/permitted
 * branches only). That service is UNCHANGED and continues to be the
 * transactional path `PinService` needs (nested `withAuthContext` is
 * unsupported — see `pin-verification.contract.ts` — so PIN verification
 * cannot call out to a second service's own transaction). This service is
 * the NEW write surface for every other Employee concern: the full HR
 * record, compensation, and deactivation.
 *
 * Both services write the SAME `identity.employees` / `identity.employee_branches`
 * tables (see the migration header for why the table itself was not moved).
 * That is a real, documented seam — not a boundary this repository's
 * `module-boundaries.spec.ts` can see, since it checks TypeScript imports,
 * not table ownership — and it is safe here because the two write DISJOINT
 * column sets: `identity/employees` never touches any FR-HRM-001 column this
 * service owns, and this service never touches `user_id`/PIN-linkage columns
 * `identity/employees` owns. No route in this repository calls both for the
 * same employee inside the same request.
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

export type EmploymentType =
  'full_time' | 'part_time' | 'casual' | 'contractor' | 'trainee';

export type CompensationBasis = 'hourly' | 'monthly_salary' | 'per_shift';

export interface CreateEmployeeInput {
  code: string;
  displayName: string;
  homeBranchId: string;
  employmentType: EmploymentType;
  userId?: string;
  permittedBranchIds?: string[];
  namesLocalized?: Record<string, string>;
  nationalId?: string;
  contactDetails?: Record<string, unknown>;
  emergencyContact?: Record<string, unknown>;
  dateOfBirth?: string;
  hireDate?: string;
  position?: string;
  department?: string;
}

export interface UpdateEmployeeInput {
  displayName?: string;
  employmentType?: EmploymentType;
  namesLocalized?: Record<string, string>;
  nationalId?: string;
  contactDetails?: Record<string, unknown>;
  emergencyContact?: Record<string, unknown>;
  dateOfBirth?: string;
  hireDate?: string;
  position?: string;
  department?: string;
}

export interface DeactivateEmployeeInput {
  status: 'suspended' | 'terminated';
  terminationDate?: string;
  reason: string;
}

export interface SetCompensationInput {
  basis: CompensationBasis;
  amountMinorUnits: bigint;
  currency: string;
  effectiveFrom?: string;
}

const EMPLOYEE_SELECT = {
  id: true,
  tenantId: true,
  code: true,
  displayName: true,
  namesLocalized: true,
  nationalId: true,
  contactDetails: true,
  emergencyContact: true,
  dateOfBirth: true,
  hireDate: true,
  terminationDate: true,
  position: true,
  department: true,
  employmentType: true,
  homeBranchId: true,
  status: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EmployeeSelect;

@Injectable()
export class WorkforceEmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertBranch(
    tx: Prisma.TransactionClient,
    branchId: string,
  ): Promise<void> {
    // Cross-tenant branches are invisible under RLS → 404, never 403.
    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }
  }

  /** FR-HRM-001/002/005. */
  async create(tenantId: string, actorId: string, input: CreateEmployeeInput) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        await this.assertBranch(tx, input.homeBranchId);

        if (input.userId !== undefined) {
          const user = await tx.user.findUnique({
            where: { id: input.userId },
            select: { id: true },
          });
          if (!user) {
            throw new NotFoundException('User not found.');
          }
          const taken = await tx.employee.findUnique({
            where: { userId: input.userId },
            select: { id: true },
          });
          if (taken) {
            throw new ConflictException(
              'That user is already linked to an employee. SRS §7.3 #25 allows at most one.',
            );
          }
        }

        let employee: Prisma.EmployeeGetPayload<{
          select: typeof EMPLOYEE_SELECT;
        }>;
        try {
          employee = await tx.employee.create({
            data: {
              id: newId(),
              tenantId,
              code: input.code,
              displayName: input.displayName,
              homeBranchId: input.homeBranchId,
              employmentType: input.employmentType,
              ...(input.userId !== undefined ? { userId: input.userId } : {}),
              ...(input.namesLocalized !== undefined
                ? {
                    namesLocalized: input.namesLocalized,
                  }
                : {}),
              ...(input.nationalId !== undefined
                ? { nationalId: input.nationalId }
                : {}),
              ...(input.contactDetails !== undefined
                ? {
                    contactDetails:
                      input.contactDetails as Prisma.InputJsonValue,
                  }
                : {}),
              ...(input.emergencyContact !== undefined
                ? {
                    emergencyContact:
                      input.emergencyContact as Prisma.InputJsonValue,
                  }
                : {}),
              ...(input.dateOfBirth !== undefined
                ? { dateOfBirth: new Date(input.dateOfBirth) }
                : {}),
              ...(input.hireDate !== undefined
                ? { hireDate: new Date(input.hireDate) }
                : {}),
              ...(input.position !== undefined
                ? { position: input.position }
                : {}),
              ...(input.department !== undefined
                ? { department: input.department }
                : {}),
            },
            select: EMPLOYEE_SELECT,
          });
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            throw new ConflictException(
              `Employee code "${input.code}" is already in use in this tenant.`,
            );
          }
          throw err;
        }

        const permitted = new Set<string>([
          input.homeBranchId,
          ...(input.permittedBranchIds ?? []),
        ]);
        for (const branchId of permitted) {
          if (branchId !== input.homeBranchId) {
            await this.assertBranch(tx, branchId);
          }
          await tx.employeeBranch.create({
            data: { tenantId, employeeId: employee.id, branchId },
          });
        }

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.EMPLOYEE_CREATED,
          entityType: AUDIT_ENTITY.EMPLOYEE,
          actorType: 'user',
          actorId,
          entityId: employee.id,
          metadata: {
            code: employee.code,
            employmentType: employee.employmentType,
            homeBranchId: employee.homeBranchId,
            permittedBranchCount: permitted.size,
            linkedUser: input.userId !== undefined,
          },
        });

        return { ...employee, permittedBranchIds: [...permitted] };
      },
    );
  }

  /** FR-HRM-001 record maintenance. Never touches `code`/`homeBranchId`/`status`. */
  async update(
    tenantId: string,
    actorId: string,
    employeeId: string,
    input: UpdateEmployeeInput,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.employee.findUnique({
          where: { id: employeeId },
          select: EMPLOYEE_SELECT,
        });
        if (!existing) {
          throw new NotFoundException('Employee not found.');
        }

        const before: Record<string, unknown> = {};
        const data: Prisma.EmployeeUpdateInput = {};
        for (const [key, value] of Object.entries(input)) {
          if (value === undefined) continue;
          before[key] = (existing as Record<string, unknown>)[key];
          (data as Record<string, unknown>)[key] =
            key === 'dateOfBirth' || key === 'hireDate'
              ? new Date(value as string)
              : value;
        }

        if (Object.keys(data).length === 0) {
          return existing;
        }

        const updated = await tx.employee.update({
          where: { id: employeeId },
          data,
          select: EMPLOYEE_SELECT,
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.EMPLOYEE_UPDATED,
          entityType: AUDIT_ENTITY.EMPLOYEE,
          actorType: 'user',
          actorId,
          entityId: employeeId,
          before,
          metadata: input as unknown as Record<string, unknown>,
        });

        return updated;
      },
    );
  }

  /** FR-HRM-006 — deactivatable, never hard-deletable. */
  async deactivate(
    tenantId: string,
    actorId: string,
    employeeId: string,
    input: DeactivateEmployeeInput,
  ) {
    this.throwIfBlank(input.reason, 'reason');
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.employee.findUnique({
          where: { id: employeeId },
          select: { id: true, status: true },
        });
        if (!existing) {
          throw new NotFoundException('Employee not found.');
        }
        if (existing.status === input.status) {
          throw new ConflictException(`Employee is already ${input.status}.`);
        }

        const updated = await tx.employee.update({
          where: { id: employeeId },
          data: {
            status: input.status,
            ...(input.terminationDate !== undefined
              ? { terminationDate: new Date(input.terminationDate) }
              : {}),
          },
          select: EMPLOYEE_SELECT,
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.EMPLOYEE_DEACTIVATED,
          entityType: AUDIT_ENTITY.EMPLOYEE,
          actorType: 'user',
          actorId,
          entityId: employeeId,
          before: { status: existing.status },
          reasonText: input.reason,
          metadata: { status: input.status },
        });

        return updated;
      },
    );
  }

  /**
   * Add a permitted branch — FR-HRM-005.
   *
   * Mirrors `identity/employees/employees.service.ts`'s own method exactly,
   * including the still-unwired-anywhere `assertPinUnique` extension point
   * (FR-SEC-022 branch-PIN-uniqueness re-check on widened reach): no caller
   * in this repository supplies it today, on either service, and wiring it
   * is FR-SEC-022 scope, not HR-1's.
   */
  async addPermittedBranch(
    tenantId: string,
    actorId: string,
    employeeId: string,
    branchId: string,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: { id: true },
        });
        if (!employee) {
          throw new NotFoundException('Employee not found.');
        }
        await this.assertBranch(tx, branchId);

        const existing = await tx.employeeBranch.findUnique({
          where: { employeeId_branchId: { employeeId, branchId } },
        });
        if (existing) {
          throw new ConflictException(
            'That branch is already permitted for this employee.',
          );
        }

        const row = await tx.employeeBranch.create({
          data: { tenantId, employeeId, branchId },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.EMPLOYEE_BRANCH_ASSIGNED,
          entityType: AUDIT_ENTITY.EMPLOYEE,
          actorType: 'user',
          actorId,
          entityId: employeeId,
          metadata: { branchId },
        });
        return row;
      },
    );
  }

  /** FR-HRM-003 — a NEW immutable version, never an edit. */
  async setCompensation(
    tenantId: string,
    actorId: string,
    employeeId: string,
    input: SetCompensationInput,
  ) {
    if (input.amountMinorUnits < 0n) {
      throw new BadRequestException('amountMinorUnits must not be negative.');
    }
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: { id: true },
        });
        if (!employee) {
          throw new NotFoundException('Employee not found.');
        }

        // Raw INSERT, not `tx.employeeCompensation.create` — Prisma's typed
        // `.create()` names EVERY column in its generated INSERT (DEFAULT
        // for omitted ones), which would require INSERT privilege on
        // `created_at` too and defeat the migration's narrow column-level
        // GRANT (the exact `CashClosePolicyService.create` precedent).
        const id = newId();
        const effectiveFrom = input.effectiveFrom ?? null;
        const [row] = await tx.$queryRaw<
          {
            id: string;
            tenantId: string;
            employeeId: string;
            basis: CompensationBasis;
            amountMinorUnits: bigint;
            currency: string;
            effectiveFrom: Date;
            createdBy: string;
            createdAt: Date;
          }[]
        >`
          INSERT INTO "workforce"."employee_compensations" (
            "id", "tenant_id", "employee_id", "basis", "amount_minor_units",
            "currency", "effective_from", "created_by"
          ) VALUES (
            ${id}::uuid, ${tenantId}::uuid, ${employeeId}::uuid,
            ${input.basis}::"workforce"."CompensationBasis",
            ${input.amountMinorUnits}, ${input.currency},
            COALESCE(${effectiveFrom}::timestamptz, statement_timestamp()),
            ${actorId}::uuid
          )
          RETURNING
            "id", "tenant_id" AS "tenantId", "employee_id" AS "employeeId",
            "basis", "amount_minor_units" AS "amountMinorUnits", "currency",
            "effective_from" AS "effectiveFrom", "created_by" AS "createdBy",
            "created_at" AS "createdAt"
        `;

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.EMPLOYEE_COMPENSATION_SET,
          entityType: AUDIT_ENTITY.EMPLOYEE_COMPENSATION,
          actorType: 'user',
          actorId,
          entityId: row.id,
          // Never the amount itself in plain audit metadata beyond what the
          // compensation-view permission already gates on read — the basis
          // and currency are not sensitive; the amount IS, so it stays out.
          metadata: {
            employeeId,
            basis: input.basis,
            currency: input.currency,
          },
        });

        return row;
      },
    );
  }

  /** Latest compensation version effective at or before `asOf` (default now). */
  async currentCompensation(
    tenantId: string,
    employeeId: string,
    asOf: Date = new Date(),
  ) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.employeeCompensation.findFirst({
        where: { employeeId, effectiveFrom: { lte: asOf } },
        orderBy: { effectiveFrom: 'desc' },
      }),
    );
  }

  async get(tenantId: string, employeeId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.employee.findUnique({
        where: { id: employeeId },
        select: {
          ...EMPLOYEE_SELECT,
          branches: { select: { branchId: true } },
        },
      }),
    );
  }

  async list(tenantId: string, branchId?: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.employee.findMany({
        where: branchId ? { branches: { some: { branchId } } } : undefined,
        orderBy: { code: 'asc' },
        select: {
          ...EMPLOYEE_SELECT,
          branches: { select: { branchId: true } },
        },
      }),
    );
  }

  /** Internal helper for Schedule/Attendance — FR-HRM-005/006 employment facts. */
  async activeEmploymentFacts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
  ): Promise<{ active: boolean; permittedBranchIds: string[] } | null> {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: {
        status: true,
        branches: { select: { branchId: true } },
      },
    });
    if (!employee) return null;
    return {
      active: employee.status === 'active',
      permittedBranchIds: employee.branches.map((b) => b.branchId),
    };
  }

  private throwIfBlank(value: string, field: string): void {
    if (value.trim().length === 0) {
      throw new BadRequestException(`${field} must not be blank.`);
    }
  }
}
