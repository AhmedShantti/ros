import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma, RoleScopeType } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import type { AssignmentScope } from './scope';

/** Input scope for a create/re-scope. Explicit ALWAYS — never defaulted. */
export type AssignmentScopeInput = AssignmentScope;

export interface CreateAssignmentInput {
  readonly membershipId: string;
  readonly roleId: string;
  /**
   * MANDATORY. Amendment clause 18 of the B1-2 brief: "Creating an assignment
   * must require EXPLICIT scope. Do NOT silently default a new assignment to
   * TENANT." A default here would quietly re-create the pre-B1-2 world.
   */
  readonly scope: AssignmentScopeInput;
  readonly validFrom?: Date;
  readonly validTo?: Date | null;
}

export interface AssignmentView {
  readonly id: string;
  readonly membershipId: string;
  readonly roleId: string;
  readonly scopeType: RoleScopeType;
  readonly scopeBrandId: string | null;
  readonly scopeBranchId: string | null;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly origin: 'explicit' | 'migration';
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
}

const NOT_FOUND = 'Role assignment not found.';

/**
 * Scoped role assignments — FR-SEC-002/003/004/005.
 *
 * Every query runs under the acting tenant's RLS context (`app.tenant_id`), so
 * cross-tenant (BOLA/IDOR) assignment is impossible at BOTH layers: the foreign
 * membership/role/brand/branch is invisible to the query, and the
 * `membership_roles` write policies reject the row. Scope references are
 * additionally guarded by tenant-safe COMPOSITE FKs — PostgreSQL evaluates
 * referential integrity with row security DISABLED, so RLS alone could never
 * make a cross-tenant scope reference impossible (ADR 0008 D-09).
 *
 * ── EPOCH AND AUDIT ARE ATOMIC WITH THE MUTATION ───────────────────────────
 * Every method below writes the assignment, bumps `memberships.authz_epoch`,
 * and records the audit entry INSIDE ONE transaction. There is deliberately no
 * window in which authority has changed but the epoch or the audit trail has
 * not: a rollback loses all three together (`AuditService.record`, the
 * mandatory in-transaction path, not the best-effort `emit`).
 */
@Injectable()
export class MembershipRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Create ONE scoped assignment. Scope is mandatory and validated. */
  async create(
    actingTenantId: string,
    actorId: string | null,
    input: CreateAssignmentInput,
  ): Promise<AssignmentView> {
    return this.prisma.withAuthContext(
      { userId: actorId ?? undefined, tenantId: actingTenantId },
      async (tx) => {
        await this.assertMembership(tx, actingTenantId, input.membershipId);
        await this.assertAssignableRole(tx, actingTenantId, input.roleId);
        const scope = await this.assertScopeVisible(tx, input.scope);

        const validFrom = input.validFrom ?? new Date();
        const validTo = input.validTo ?? null;
        if (validTo !== null && validTo <= validFrom) {
          throw new BadRequestException(
            'validTo must be strictly after validFrom.',
          );
        }

        const created = await this.write(tx, () =>
          tx.membershipRole.create({
            data: {
              id: newId(),
              tenantId: actingTenantId,
              membershipId: input.membershipId,
              roleId: input.roleId,
              scopeType: scope.scopeType,
              scopeBrandId: scope.scopeBrandId,
              scopeBranchId: scope.scopeBranchId,
              validFrom,
              validTo,
              // Created through the API with a stated scope — never inherited.
              origin: 'explicit',
            },
          }),
        );

        await this.bumpEpoch(tx, input.membershipId);
        await this.audit.record(tx, {
          tenantId: actingTenantId,
          action: AUDIT_ACTION.ROLE_ASSIGNED,
          entityType: AUDIT_ENTITY.ROLE_ASSIGNMENT,
          actorType: actorId ? 'user' : 'system',
          actorId,
          entityId: created.id,
          metadata: {
            membershipId: created.membershipId,
            roleId: created.roleId,
            ...describeScope(created),
            validFrom: created.validFrom.toISOString(),
            validTo: created.validTo?.toISOString() ?? null,
            origin: created.origin,
          },
        });
        return toAssignmentView(created);
      },
    );
  }

  /** All assignments of a membership, newest scope-change last. */
  async listForMembership(
    actingTenantId: string,
    membershipId: string,
  ): Promise<AssignmentView[]> {
    return this.prisma.withAuthContext(
      { tenantId: actingTenantId },
      async (tx) => {
        await this.assertMembership(tx, actingTenantId, membershipId);
        const rows = await tx.membershipRole.findMany({
          where: { tenantId: actingTenantId, membershipId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return rows.map(toAssignmentView);
      },
    );
  }

  /**
   * Re-scope and/or change the validity window of ONE assignment, by its stable
   * id. Both are authority changes, so both bump the epoch and are audited with
   * their before-state.
   */
  async update(
    actingTenantId: string,
    actorId: string | null,
    assignmentId: string,
    changes: {
      readonly scope?: AssignmentScopeInput;
      readonly validFrom?: Date;
      readonly validTo?: Date | null;
    },
  ): Promise<AssignmentView> {
    if (
      changes.scope === undefined &&
      changes.validFrom === undefined &&
      changes.validTo === undefined
    ) {
      throw new BadRequestException('No change requested.');
    }
    return this.prisma.withAuthContext(
      { userId: actorId ?? undefined, tenantId: actingTenantId },
      async (tx) => {
        const existing = await this.load(tx, actingTenantId, assignmentId);
        const scope =
          changes.scope !== undefined
            ? await this.assertScopeVisible(tx, changes.scope)
            : {
                scopeType: existing.scopeType,
                scopeBrandId: existing.scopeBrandId,
                scopeBranchId: existing.scopeBranchId,
              };
        const validFrom = changes.validFrom ?? existing.validFrom;
        const validTo =
          changes.validTo !== undefined ? changes.validTo : existing.validTo;
        if (validTo !== null && validTo <= validFrom) {
          throw new BadRequestException(
            'validTo must be strictly after validFrom.',
          );
        }

        const updated = await this.write(tx, () =>
          tx.membershipRole.update({
            where: { id: assignmentId },
            data: {
              scopeType: scope.scopeType,
              scopeBrandId: scope.scopeBrandId,
              scopeBranchId: scope.scopeBranchId,
              validFrom,
              validTo,
            },
          }),
        );

        await this.bumpEpoch(tx, existing.membershipId);
        const scopeChanged =
          changes.scope !== undefined &&
          (existing.scopeType !== updated.scopeType ||
            existing.scopeBrandId !== updated.scopeBrandId ||
            existing.scopeBranchId !== updated.scopeBranchId);
        await this.audit.record(tx, {
          tenantId: actingTenantId,
          action: scopeChanged
            ? AUDIT_ACTION.ROLE_ASSIGNMENT_RESCOPED
            : AUDIT_ACTION.ROLE_ASSIGNMENT_VALIDITY_CHANGED,
          entityType: AUDIT_ENTITY.ROLE_ASSIGNMENT,
          actorType: actorId ? 'user' : 'system',
          actorId,
          entityId: assignmentId,
          before: {
            ...describeScope(existing),
            validFrom: existing.validFrom.toISOString(),
            validTo: existing.validTo?.toISOString() ?? null,
            origin: existing.origin,
            reviewedAt: existing.reviewedAt?.toISOString() ?? null,
          },
          metadata: {
            membershipId: existing.membershipId,
            roleId: existing.roleId,
            ...describeScope(updated),
            validFrom: updated.validFrom.toISOString(),
            validTo: updated.validTo?.toISOString() ?? null,
            origin: updated.origin,
            reviewedAt: updated.reviewedAt?.toISOString() ?? null,
          },
        });
        return toAssignmentView(updated);
      },
    );
  }

  /**
   * M-4+ limb: explicitly REVIEW an inherited (migration-originated) grant.
   *
   * Outcome A of the amendment's clause 22 requirement: an administrator who
   * judges an inherited TENANT scope to be intentionally correct records that
   * judgement and clears the review condition — WITHOUT being forced to change
   * a scope that was already right. Outcome B (re-scope to BRAND/BRANCH) is
   * `update()`, which clears the condition by replacing the grant.
   */
  async review(
    actingTenantId: string,
    actorId: string,
    assignmentId: string,
  ): Promise<AssignmentView> {
    return this.prisma.withAuthContext(
      { userId: actorId ?? undefined, tenantId: actingTenantId },
      async (tx) => {
        const existing = await this.load(tx, actingTenantId, assignmentId);
        if (existing.origin !== 'migration') {
          throw new BadRequestException(
            'Only a migration-originated assignment can be reviewed.',
          );
        }
        if (existing.reviewedAt !== null) {
          // Idempotent: already reviewed is not an error, and must not bump the
          // epoch again (that would invalidate every live token for nothing).
          return toAssignmentView(existing);
        }
        const updated = await this.write(tx, () =>
          tx.membershipRole.update({
            where: { id: assignmentId },
            data: { reviewedAt: new Date(), reviewedBy: actorId },
          }),
        );
        await this.bumpEpoch(tx, existing.membershipId);
        await this.audit.record(tx, {
          tenantId: actingTenantId,
          action: AUDIT_ACTION.ROLE_ASSIGNMENT_REVIEWED,
          entityType: AUDIT_ENTITY.ROLE_ASSIGNMENT,
          actorType: actorId ? 'user' : 'system',
          actorId,
          entityId: assignmentId,
          before: { reviewedAt: null, origin: existing.origin },
          metadata: {
            membershipId: existing.membershipId,
            roleId: existing.roleId,
            ...describeScope(existing),
            origin: existing.origin,
            reviewedAt: updated.reviewedAt?.toISOString() ?? null,
            outcome: 'retained_tenant_scope',
          },
        });
        return toAssignmentView(updated);
      },
    );
  }

  /** Remove ONE assignment by its stable id. */
  async remove(
    actingTenantId: string,
    actorId: string | null,
    assignmentId: string,
  ): Promise<void> {
    await this.prisma.withAuthContext(
      { userId: actorId ?? undefined, tenantId: actingTenantId },
      async (tx) => {
        const existing = await this.load(tx, actingTenantId, assignmentId);
        await tx.membershipRole.delete({ where: { id: assignmentId } });
        await this.bumpEpoch(tx, existing.membershipId);
        await this.audit.record(tx, {
          tenantId: actingTenantId,
          action: AUDIT_ACTION.ROLE_ASSIGNMENT_REMOVED,
          entityType: AUDIT_ENTITY.ROLE_ASSIGNMENT,
          actorType: actorId ? 'user' : 'system',
          actorId,
          entityId: assignmentId,
          before: {
            membershipId: existing.membershipId,
            roleId: existing.roleId,
            ...describeScope(existing),
            origin: existing.origin,
          },
          metadata: { removed: true },
        });
      },
    );
  }

  /**
   * DEPRECATED legacy shape: remove "the" assignment of a role on a membership.
   *
   * Before B1-2 a membership+role pair identified exactly one row, so this was
   * unambiguous. It no longer is: FR-SEC-003 exists precisely so the same role
   * can be held at several scopes. Rather than silently deleting several grants
   * — which would be an unlogged, unintended revocation — this FAILS CLOSED
   * with 409 the moment more than one assignment matches, and the caller must
   * use the assignment-id route. Retained only so the pre-B1-2 route keeps
   * working for the single-assignment case.
   */
  async removeByRole(
    actingTenantId: string,
    actorId: string | null,
    membershipId: string,
    roleId: string,
  ): Promise<void> {
    const matches = await this.prisma.withAuthContext(
      { tenantId: actingTenantId },
      async (tx) => {
        await this.assertMembership(tx, actingTenantId, membershipId);
        return tx.membershipRole.findMany({
          where: { tenantId: actingTenantId, membershipId, roleId },
          select: { id: true },
        });
      },
    );
    if (matches.length === 0) {
      // Idempotent, as the pre-B1-2 route was.
      return;
    }
    if (matches.length > 1) {
      throw new ConflictException(
        `This role is held at ${matches.length} different scopes on this membership. ` +
          'Remove a specific assignment by its id (DELETE /auth/role-assignments/{assignmentId}); ' +
          'this deprecated route will not remove several assignments at once.',
      );
    }
    await this.remove(actingTenantId, actorId, matches[0].id);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async load(
    tx: Prisma.TransactionClient,
    tenantId: string,
    assignmentId: string,
  ) {
    const row = await tx.membershipRole.findFirst({
      where: { id: assignmentId, tenantId },
    });
    if (!row) {
      // Another tenant's assignment is invisible under RLS and lands here — 404
      // either way, so an assignment id cannot be probed across tenants.
      throw new NotFoundException(NOT_FOUND);
    }
    return row;
  }

  private async assertMembership(
    tx: Prisma.TransactionClient,
    tenantId: string,
    membershipId: string,
  ): Promise<void> {
    const membership = await tx.membership.findFirst({
      where: { id: membershipId, tenantId },
      select: { id: true },
    });
    if (!membership) {
      throw new NotFoundException('Membership not found.');
    }
  }

  private async assertAssignableRole(
    tx: Prisma.TransactionClient,
    tenantId: string,
    roleId: string,
  ): Promise<void> {
    const role = await tx.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    if (role.isSystem) {
      throw new ForbiddenException('System roles cannot be assigned here.');
    }
    if (role.tenantId !== tenantId) {
      throw new NotFoundException('Role not found.');
    }
  }

  /**
   * Application-side scope validation. The composite FK is the STRUCTURAL
   * guarantee; this is the layer that turns a foreign id into a tenant-safe
   * 404 instead of a database error, and keeps the two checks independent
   * (amendment clause 19: cross-tenant assignment is rejected by BOTH the
   * application and referential integrity, and RLS is never relied on as the
   * FK mechanism).
   */
  private async assertScopeVisible(
    tx: Prisma.TransactionClient,
    scope: AssignmentScopeInput,
  ): Promise<{
    scopeType: RoleScopeType;
    scopeBrandId: string | null;
    scopeBranchId: string | null;
  }> {
    switch (scope.type) {
      case 'tenant':
        return {
          scopeType: 'tenant',
          scopeBrandId: null,
          scopeBranchId: null,
        };
      case 'brand': {
        const brand = await tx.brand.findUnique({
          where: { id: scope.brandId },
          select: { id: true },
        });
        if (!brand) {
          throw new NotFoundException('Brand not found.');
        }
        return {
          scopeType: 'brand',
          scopeBrandId: scope.brandId,
          scopeBranchId: null,
        };
      }
      case 'branch': {
        const branch = await tx.branch.findUnique({
          where: { id: scope.branchId },
          select: { id: true },
        });
        if (!branch) {
          throw new NotFoundException('Branch not found.');
        }
        return {
          scopeType: 'branch',
          scopeBrandId: null,
          scopeBranchId: scope.branchId,
        };
      }
    }
  }

  /** Monotonic epoch bump — T-4-LIVE staleness detection. */
  private async bumpEpoch(
    tx: Prisma.TransactionClient,
    membershipId: string,
  ): Promise<void> {
    await tx.membership.update({
      where: { id: membershipId },
      data: { authzEpoch: { increment: 1 } },
    });
  }

  /** Translate the temporal EXCLUDE constraint into an actionable 409. */
  private async write<T>(
    _tx: Prisma.TransactionClient,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        // 23P01 exclusion_violation — surfaced by Prisma as a raw DB error.
        (err.code === 'P2010' || err.code === 'P2002')
      ) {
        throw new ConflictException(
          'This role is already assigned at this exact scope for an overlapping validity window.',
        );
      }
      const message = err instanceof Error ? err.message : '';
      if (message.includes('ex_membership_role_no_overlap')) {
        throw new ConflictException(
          'This role is already assigned at this exact scope for an overlapping validity window.',
        );
      }
      throw err;
    }
  }
}

function describeScope(row: {
  scopeType: RoleScopeType;
  scopeBrandId: string | null;
  scopeBranchId: string | null;
}): Record<string, unknown> {
  return {
    scopeType: row.scopeType,
    scopeBrandId: row.scopeBrandId,
    scopeBranchId: row.scopeBranchId,
  };
}

function toAssignmentView(row: {
  id: string;
  membershipId: string;
  roleId: string;
  scopeType: RoleScopeType;
  scopeBrandId: string | null;
  scopeBranchId: string | null;
  validFrom: Date;
  validTo: Date | null;
  origin: 'explicit' | 'migration';
  reviewedAt: Date | null;
  createdAt: Date;
}): AssignmentView {
  return {
    id: row.id,
    membershipId: row.membershipId,
    roleId: row.roleId,
    scopeType: row.scopeType,
    scopeBrandId: row.scopeBrandId,
    scopeBranchId: row.scopeBranchId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    origin: row.origin,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}
