import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { toAssignmentScope } from '../context/tenant-context.service';
import type { ScopedGrant } from '../context/tenant-context';
import type { ScopeAuthorizationActor } from '../contract/authorization-target';
import type {
  PosActorAuthorizationPort,
  ResolvePosActorInput,
} from '../contract/pos-actor-authorization';

/**
 * `POS_ACTOR_AUTHORIZATION` — see the contract's docblock
 * (`identity/contract/pos-actor-authorization.ts`) for why this exists and
 * exactly what it reuses from `TenantContextService`.
 *
 * Deliberately mirrors — rather than calls — `TenantContextService.resolve`:
 * that method requires a signed `AuthenticatedPrincipal` and enforces the
 * T-4-LIVE epoch fence against a token this caller does not have. Nothing here
 * is a second definition of the scope LATTICE (`scope.ts`'s `coversTarget` is
 * untouched and unduplicated) — only the "which live rows describe this
 * employee's authority" read is repeated, at the same live-database-wins
 * discipline `TenantContextService.resolve` already documents.
 */
@Injectable()
export class PosActorAuthorizationService implements PosActorAuthorizationPort {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ResolvePosActorInput,
  ): Promise<ScopeAuthorizationActor | null> {
    const { tenantId, employeeId, branchId } = input;

    const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;

    const employee = await tx.employee.findFirst({
      where: { tenantId, id: employeeId, status: 'active' },
      select: { userId: true },
    });
    if (!employee?.userId) {
      // No employee, inactive employee, or an employee with no linked User —
      // none can hold a Membership. Fail closed.
      return null;
    }
    const userId = employee.userId;

    // AND-only narrowing (amendment clause 6), re-verified live — identical
    // check to `TenantContextService.resolvePosBranch`, keyed by employeeId
    // instead of a principal's `terminalId`, since Sync already derived the
    // terminal's branch server-side (`SyncTerminalGuard`) before this runs.
    const permitted = await tx.employeeBranch.findFirst({
      where: { tenantId, employeeId, branchId },
      select: { branchId: true },
    });
    if (!permitted) {
      return null;
    }

    const membership = await tx.membership.findFirst({
      where: {
        userId,
        tenantId,
        status: 'active',
        tenant: { status: 'active' },
      },
      select: {
        id: true,
        authzEpoch: true,
        membershipRoles: {
          where: {
            validFrom: { lte: now },
            OR: [{ validTo: null }, { validTo: { gt: now } }],
            role: { OR: [{ tenantId }, { isSystem: true }] },
          },
          select: {
            id: true,
            roleId: true,
            scopeType: true,
            scopeBrandId: true,
            scopeBranchId: true,
            role: {
              select: {
                rolePermissions: {
                  select: { permission: { select: { code: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!membership) {
      return null;
    }

    const grants: ScopedGrant[] = [];
    const tenantPermissions = new Set<string>();
    for (const mr of membership.membershipRoles) {
      const permissions = new Set<string>();
      for (const rp of mr.role.rolePermissions) {
        permissions.add(rp.permission.code);
      }
      const scope = toAssignmentScope(mr);
      if (scope === null) {
        // Unreachable under the DB CHECK constraint; fail closed exactly as
        // `TenantContextService.resolve` does rather than granting a wildcard.
        continue;
      }
      grants.push({
        assignmentId: mr.id,
        roleId: mr.roleId,
        scope,
        permissions,
      });
      if (scope.type === 'tenant') {
        for (const code of permissions) tenantPermissions.add(code);
      }
    }

    return {
      context: {
        userId,
        // No HTTP session backs this resolution; a stable, non-empty, clearly
        // synthetic id keeps `TenantContext.sessionId` non-optional without
        // implying a session was minted.
        sessionId: `sync:${employeeId}`,
        tenantId,
        membershipId: membership.id,
        sessionType: 'pos',
        employeeId,
        branchId,
      },
      permissions: tenantPermissions,
      grants,
      authzEpoch: membership.authzEpoch,
      // No token snapshot exists for a sync-asserted actor, so there is
      // nothing to flag for M-4+ review from this resolution path.
      scopeReviewRequired: false,
    };
  }
}
