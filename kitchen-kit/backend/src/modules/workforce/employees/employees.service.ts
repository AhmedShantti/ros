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
import { canonicalRoleKeyForName, ensureCanonicalRole } from '../../identity/authz/canonical-role-templates';
import {
  AssignmentScopeInput,
  MembershipRolesService,
} from '../../identity/authz/membership-roles.service';
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
    private readonly membershipRoles: MembershipRolesService,
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

  /**
   * FR-HRM-001/002/005.
   *
   * LIVE-DEMO-HOTFIX-1: when the caller does NOT supply an existing `userId`
   * (the common case — a brand-new POS-only hire with no prior account), this
   * method ALSO auto-provisions, inline on this SAME transaction (mirroring
   * `RegistrationsService.register()`'s own inline-`tx` composition, since
   * `withAuthContext` cannot nest): a minimal internal `User` (a real email is
   * required by the schema and this employee has none — see
   * `SYNTHETIC_EMAIL_SUFFIX` below — and NO password credential, since a PIN,
   * set separately via `POST /workforce/employees/:employeeId/pin`, is this
   * user's only ever credential), an ACTIVE `Membership`, and a tenant-owned
   * "Cashier" `Role` (reused by name if one already exists) holding the same
   * minimal POS permission set `seed-dev-data.ts`'s own seeded Cashier role
   * gets, assigned at BRANCH scope on `homeBranchId` only (least privilege for
   * a single-branch hire). Without this, an employee created through the real
   * UI could never pass `POST /auth/pin` (no `userId` ⇒ `PinService.
   * authenticate` fails at its very first employee check) — see the
   * LIVE-DEMO-HOTFIX-1 report for the full root-cause trace.
   *
   * The pre-existing `userId`-supplied path (linking an already-provisioned
   * user) is completely unchanged.
   */
  async create(tenantId: string, actorId: string, input: CreateEmployeeInput) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        await this.assertBranch(tx, input.homeBranchId);

        let linkedUserId: string | undefined = input.userId;

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

        const employeeId = newId();
        let autoProvisioned = false;
        if (linkedUserId === undefined) {
          autoProvisioned = true;
          linkedUserId = newId();
          // The schema requires a globally-unique, non-null email; a POS-only
          // employee has none. This is a technical necessity of `users.email
          // NOT NULL UNIQUE`, not a business feature — the address is never
          // shown anywhere and can never be used to sign in with a password
          // (no password credential is ever created for this user).
          const syntheticEmail = `pos-employee-${employeeId}@employees.ros.internal`;
          await tx.user.create({
            data: {
              id: linkedUserId,
              email: syntheticEmail,
              displayName: input.displayName,
              preferredLocale: 'ar',
            },
          });
          await tx.membership.create({
            data: {
              id: newId(),
              userId: linkedUserId,
              tenantId,
              status: 'active',
            },
          });
        }

        let employee: Prisma.EmployeeGetPayload<{
          select: typeof EMPLOYEE_SELECT;
        }>;
        try {
          employee = await tx.employee.create({
            data: {
              id: employeeId,
              tenantId,
              code: input.code,
              displayName: input.displayName,
              homeBranchId: input.homeBranchId,
              employmentType: input.employmentType,
              ...(linkedUserId !== undefined ? { userId: linkedUserId } : {}),
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

        if (autoProvisioned && linkedUserId !== undefined) {
          await this.grantAutoCashierRole(
            tx,
            tenantId,
            actorId,
            linkedUserId,
            input.homeBranchId,
          );
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
            linkedUser: linkedUserId !== undefined,
            autoProvisionedIdentity: autoProvisioned,
          },
        });

        return { ...employee, permittedBranchIds: [...permitted] };
      },
    );
  }

  /**
   * LIVE-DEMO-HOTFIX-1 (role fixed under DEMO-EMPLOYEE-RBAC-1) — grant the
   * canonical "Cashier" role, at BRANCH scope, to a freshly auto-provisioned
   * employee's membership. `ensureCanonicalRole` is the SAME idempotent
   * create-or-reuse-by-name helper `RegistrationsService` uses to seed all 4
   * canonical demo roles at signup — this is no longer a separate, narrower
   * permission list of its own (the original LIVE-DEMO-HOTFIX-1 cut was
   * missing `cash.session.open`/`cash.session.close`/`pos.payment.capture`;
   * DEMO-EMPLOYEE-RBAC-1 folds the fix into the one shared template instead
   * of hardcoding the extra codes onto this one call site). Mirrors
   * `MembershipRolesService.create`'s exact write shape (assignment insert +
   * epoch bump + audit, all atomic with the caller's transaction) and
   * `RegistrationsService.register()`'s own inline-`tx` role-grant pattern.
   */
  private async grantAutoCashierRole(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorId: string,
    userId: string,
    homeBranchId: string,
  ): Promise<void> {
    const role = await ensureCanonicalRole(tx, tenantId, 'cashier');

    const membership = await tx.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { id: true },
    });
    if (!membership) return; // unreachable: this method only runs right after creating it

    const membershipRoleId = newId();
    await tx.membershipRole.create({
      data: {
        id: membershipRoleId,
        tenantId,
        membershipId: membership.id,
        roleId: role.id,
        scopeType: 'branch',
        scopeBrandId: null,
        scopeBranchId: homeBranchId,
        origin: 'explicit',
      },
    });
    await tx.membership.update({
      where: { id: membership.id },
      data: { authzEpoch: { increment: 1 } },
    });
    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.ROLE_ASSIGNED,
      entityType: AUDIT_ENTITY.ROLE_ASSIGNMENT,
      actorType: 'user',
      actorId,
      entityId: membershipRoleId,
      metadata: {
        membershipId: membership.id,
        roleId: role.id,
        scopeType: 'branch',
        scopeBrandId: null,
        scopeBranchId: homeBranchId,
        origin: 'explicit',
      },
    });
  }

  /**
   * DEMO-EMPLOYEE-RBAC-1 — resolve an employee id to the `Membership.id`
   * behind it, for the three role-assignment facade methods below. The
   * Employees UI knows only `employeeId`; it must never learn a raw
   * `membershipId` (an internal identity concept it has no other reason to
   * see). 404s (never leaks whether an employee id exists cross-tenant,
   * matching `assertBranch`'s own RLS-invisibility convention) if the
   * employee doesn't exist, has no linked user (`Employee.userId` is
   * nullable — SRS §14 permits an employee with none; such an employee
   * simply cannot hold a role assignment either), or — unreachable in
   * practice given this service always creates one alongside a `userId` —
   * has no membership.
   */
  private async resolveMembershipId(
    tx: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
  ): Promise<string> {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found.');
    }
    if (!employee.userId) {
      throw new ConflictException(
        'This employee has no linked user, so it cannot hold a role assignment.',
      );
    }
    const membership = await tx.membership.findUnique({
      where: { userId_tenantId: { userId: employee.userId, tenantId } },
      select: { id: true },
    });
    if (!membership) {
      throw new NotFoundException('Employee not found.');
    }
    return membership.id;
  }

  /**
   * DEMO-EMPLOYEE-RBAC-1 — this employee's scoped role assignments, each
   * enriched with its role's `name` so the Employees UI can label them
   * without a second round trip. Delegates entirely to
   * `MembershipRolesService.listForMembership` — no query duplicated here.
   */
  async listRoleAssignments(tenantId: string, employeeId: string) {
    const membershipId = await this.prisma.withAuthContext(
      { tenantId },
      (tx) => this.resolveMembershipId(tx, tenantId, employeeId),
    );
    const assignments = await this.membershipRoles.listForMembership(
      tenantId,
      membershipId,
    );
    const roleIds = [...new Set(assignments.map((a) => a.roleId))];
    const roles = roleIds.length
      ? await this.prisma.withAuthContext({ tenantId }, (tx) =>
          tx.role.findMany({
            where: { id: { in: roleIds } },
            select: { id: true, name: true },
          }),
        )
      : [];
    const nameById = new Map(roles.map((r) => [r.id, r.name]));
    return assignments.map((a) => ({
      ...a,
      roleName: nameById.get(a.roleId) ?? null,
    }));
  }

  /**
   * DEMO-EMPLOYEE-RBAC-1 — assign one role to this employee at an EXPLICIT
   * scope. Resolves `employeeId -> membershipId` then delegates verbatim to
   * `MembershipRolesService.create` — the atomic epoch-bump + audit write is
   * entirely its own, unchanged. `roleId`/`scope` come from the caller
   * exactly as `POST /auth/memberships/{membershipId}/roles` already accepts
   * them (same `AssignRoleDto`/`AssignmentScopeDto` shape) — no parallel
   * contract invented.
   */
  async assignRoleToEmployee(
    tenantId: string,
    actorId: string,
    employeeId: string,
    input: { roleId: string; scope: AssignmentScopeInput },
  ) {
    const membershipId = await this.prisma.withAuthContext(
      { tenantId },
      (tx) => this.resolveMembershipId(tx, tenantId, employeeId),
    );

    // DEMO-OPS-HOTFIX-2 — if `input.roleId` names one of the canonical
    // templates, reconcile its permission grants to the CURRENT template
    // before handing out a new assignment to it. Without this, a role row
    // created under an earlier, narrower template version (found here by id,
    // unchanged since) would keep silently under-granting every employee
    // assigned it afterwards, even through this exact UI. `ensureCanonicalRole`
    // is idempotent (create-or-reuse-by-name, upsert-only) — safe to call on
    // every assignment.
    await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const role = await tx.role.findUnique({
          where: { id: input.roleId },
          select: { name: true },
        });
        const canonicalKey = role
          ? canonicalRoleKeyForName(role.name)
          : undefined;
        if (canonicalKey) {
          await ensureCanonicalRole(tx, tenantId, canonicalKey);
        }
      },
    );

    const created = await this.membershipRoles.create(tenantId, actorId, {
      membershipId,
      roleId: input.roleId,
      scope: input.scope,
    });
    const role = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.role.findUnique({ where: { id: input.roleId }, select: { name: true } }),
    );
    return { ...created, roleName: role?.name ?? null };
  }

  /**
   * DEMO-EMPLOYEE-RBAC-1 — remove ONE of this employee's role assignments by
   * its stable id. Confirms the assignment actually belongs to THIS
   * employee's membership before delegating to
   * `MembershipRolesService.remove` — so one employee's assignment id can
   * never be used to probe or remove another employee's assignment (404
   * either way, mirroring every other cross-entity check in this service).
   */
  async removeRoleAssignment(
    tenantId: string,
    actorId: string,
    employeeId: string,
    assignmentId: string,
  ): Promise<void> {
    const membershipId = await this.prisma.withAuthContext(
      { tenantId },
      (tx) => this.resolveMembershipId(tx, tenantId, employeeId),
    );
    const assignments = await this.membershipRoles.listForMembership(
      tenantId,
      membershipId,
    );
    if (!assignments.some((a) => a.id === assignmentId)) {
      throw new NotFoundException('Role assignment not found.');
    }
    await this.membershipRoles.remove(tenantId, actorId, assignmentId);
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
