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

export interface CreateEmployeeInput {
  code: string;
  displayName: string;
  homeBranchId: string;
  /** Optional login link. SRS §7.3 #25: at most one User. */
  userId?: string;
  /** Extra permitted branches; the home branch is always included. */
  permittedBranchIds?: string[];
}

/**
 * Employee — the MINIMAL substrate authorised by the D-2 amendment for P0 PIN.
 *
 * SRS §14 keeps Employee and User distinct: "an Employee is a person in a job. A
 * User is [a login]… an Employee with no User" is legitimate, and a group
 * accountant is "a User who is not an Employee of any branch". This service
 * preserves that separation — it never treats a User as an Employee.
 *
 * NOT the full `FR-HRM-001` record: no employment terms, compensation,
 * certifications, documents, scheduling or attendance. Those stay deferred, so
 * FR-HRM-001 is PARTIAL by construction.
 *
 * The permitted-branch set is AUTHENTICATION INTEGRITY for FR-SEC-021 only. It
 * grants no permission and takes no part in permission resolution — D-2 still
 * defers FR-SEC-002/003/004 branch-scoped RBAC.
 */
@Injectable()
export class EmployeesService {
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

  async create(tenantId: string, actorId: string, input: CreateEmployeeInput) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        await this.assertBranch(tx, input.homeBranchId);

        if (input.userId !== undefined) {
          // The user must exist and must not already be another employee.
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

        const employee = await tx.employee.create({
          data: {
            id: newId(),
            tenantId,
            code: input.code,
            displayName: input.displayName,
            homeBranchId: input.homeBranchId,
            ...(input.userId !== undefined ? { userId: input.userId } : {}),
          },
        });

        // The home branch is always permitted; no implicit rule is left to the
        // reader, and FR-SEC-021's check has a single source of truth.
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
            homeBranchId: employee.homeBranchId,
            permittedBranchCount: permitted.size,
            linkedUser: input.userId !== undefined,
          },
        });

        return { ...employee, permittedBranchIds: [...permitted] };
      },
    );
  }

  /** Permitted branch ids for FR-SEC-021. */
  async permittedBranchIds(
    tenantId: string,
    employeeId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.employeeBranch.findMany({
        where: { employeeId },
        select: { branchId: true },
      }),
    );
    return rows.map((r) => r.branchId);
  }

  /**
   * Add a permitted branch.
   *
   * FR-SEC-022's branch PIN uniqueness must still hold afterwards, so the caller
   * supplies a validator that re-checks it for the newly reachable branch. The
   * check runs inside this transaction, so the assignment and the uniqueness
   * verdict commit or roll back together.
   */
  async addPermittedBranch(
    tenantId: string,
    actorId: string,
    employeeId: string,
    branchId: string,
    assertPinUnique?: (
      tx: Prisma.TransactionClient,
      employeeId: string,
      branchIds: string[],
    ) => Promise<void>,
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

        if (assertPinUnique) {
          await assertPinUnique(tx, employeeId, [branchId]);
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

  async findByUser(tenantId: string, userId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.employee.findFirst({
        where: { userId },
        select: {
          id: true,
          userId: true,
          status: true,
          homeBranchId: true,
          branches: { select: { branchId: true } },
        },
      }),
    );
  }

  list(tenantId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.employee.findMany({
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          displayName: true,
          homeBranchId: true,
          status: true,
          userId: true,
          branches: { select: { branchId: true } },
        },
      }),
    );
  }

  private throwIfBlank(value: string, field: string): void {
    if (value.trim().length === 0) {
      throw new BadRequestException(`${field} must not be blank.`);
    }
  }
}
