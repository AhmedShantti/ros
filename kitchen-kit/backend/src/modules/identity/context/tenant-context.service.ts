import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedPrincipal } from '../auth/auth.types';
import type { AssignmentScope } from '../authz/scope';
import {
  RequestAuthorization,
  ScopedGrant,
  TenantContext,
} from './tenant-context';

export type AuthorizedRequest = Request & {
  principal?: AuthenticatedPrincipal;
  authorization?: RequestAuthorization;
};

/** Uniform refusal text — a stale snapshot must not describe WHY in detail. */
const STALE_SNAPSHOT =
  'Authorization snapshot is stale; obtain a new access token.';

@Injectable()
export class TenantContextService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve once per request; cached at request.authorization. */
  async require(request: AuthorizedRequest): Promise<RequestAuthorization> {
    if (request.authorization) {
      return request.authorization;
    }
    if (!request.principal) {
      throw new UnauthorizedException();
    }
    const resolved = await this.resolve(request.principal);
    request.authorization = resolved;
    return resolved;
  }

  /**
   * Validate the principal's tenant context and load its SCOPED authorization.
   *
   * ── LIVE RESOLUTION IS THE AUTHORITY (T-4-LIVE, amendment clause 7) ─────────
   * The access token carries a scope snapshot and an epoch. NEITHER authorises
   * anything. Every protected request re-reads the current scoped assignments
   * from the database, inside the request's own RLS transaction, and decides
   * from THAT. The snapshot exists so a token minted before an authority change
   * can be DETECTED as stale — never so a claim can grant.
   *
   * Consequences that are deliberate, not incidental:
   *   - a removed / re-scoped / expired assignment stops authorising on the
   *     NEXT request, with no token blacklist and no revocation sweep;
   *   - `valid_from` / `valid_to` are compared against the DATABASE clock read
   *     inside this same transaction, never the Node process clock, so expiry
   *     cannot drift with a mis-set application host;
   *   - a POS session's operating branch and its employee's permitted-branch
   *     membership are re-verified from live state on every request.
   *
   * Rejects (403) when there is no active tenant selection, the membership is
   * inactive / foreign / for an inactive tenant, the token's epoch does not
   * match the live membership, or a POS session's terminal or employee no
   * longer permits the branch it is bound to. JWT tampering never reaches here —
   * the signature check in JwtAuthGuard fails first (401).
   */
  async resolve(
    principal: AuthenticatedPrincipal,
  ): Promise<RequestAuthorization> {
    if (!principal.tenantId || !principal.membershipId) {
      throw new ForbiddenException('No active tenant context.');
    }
    const tenantId = principal.tenantId;
    const membershipId = principal.membershipId;

    return this.prisma.withAuthContext(
      { userId: principal.userId, tenantId },
      async (tx) => {
        // DATABASE clock, read inside this transaction and used for every
        // validity comparison below. FR-SEC-005 expiry is therefore a property
        // of the database, not of whichever host happens to serve the request.
        const [{ now }] = await tx.$queryRaw<
          [{ now: Date }]
        >`SELECT now() AS now`;

        const membership = await tx.membership.findFirst({
          where: {
            id: membershipId,
            userId: principal.userId,
            tenantId,
            status: 'active',
            tenant: { status: 'active' },
          },
          select: {
            id: true,
            authzEpoch: true,
            membershipRoles: {
              where: {
                // FR-SEC-005 — effective dating, evaluated live.
                validFrom: { lte: now },
                OR: [{ validTo: null }, { validTo: { gt: now } }],
                role: {
                  OR: [{ tenantId }, { isSystem: true }],
                },
              },
              select: {
                id: true,
                roleId: true,
                scopeType: true,
                scopeBrandId: true,
                scopeBranchId: true,
                origin: true,
                reviewedAt: true,
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
          throw new ForbiddenException('Invalid tenant context.');
        }

        // ── T-4-LIVE staleness fence ────────────────────────────────────────
        // A tenant-bound token MUST carry the epoch it was minted at. Absent or
        // mismatched means the snapshot no longer describes this membership's
        // authority, so the request is refused and the caller must obtain a new
        // token. This never GRANTS: the grants below were already read live.
        if (
          principal.authzEpoch === undefined ||
          principal.authzEpoch !== membership.authzEpoch
        ) {
          throw new ForbiddenException(STALE_SNAPSHOT);
        }

        const context: TenantContext = {
          userId: principal.userId,
          sessionId: principal.sessionId,
          tenantId,
          membershipId: membership.id,
          ...(principal.terminalId ? { terminalId: principal.terminalId } : {}),
          ...(principal.sessionType
            ? { sessionType: principal.sessionType }
            : {}),
          ...(principal.employeeId ? { employeeId: principal.employeeId } : {}),
        };

        // ── POS narrowing, re-verified live (amendment clause 6) ────────────
        // EmployeeBranch is AND-only and is never a grant: it can only ever
        // REMOVE a branch from what the scoped assignments already allow.
        if (principal.sessionType === 'pos') {
          context.branchId = await this.resolvePosBranch(tx, principal);
        }

        const grants: ScopedGrant[] = [];
        const tenantPermissions = new Set<string>();
        let scopeReviewRequired = false;

        for (const mr of membership.membershipRoles) {
          if (mr.origin === 'migration' && mr.reviewedAt === null) {
            scopeReviewRequired = true;
          }
          const permissions = new Set<string>();
          for (const rp of mr.role.rolePermissions) {
            permissions.add(rp.permission.code);
          }
          const scope = toAssignmentScope(mr);
          if (scope === null) {
            // Unknown/inconsistent scope shape → the assignment grants nothing
            // (fail closed, R-11). The DB CHECK makes this unreachable; the
            // branch exists so that a future enum member cannot silently become
            // an unrestricted grant by being unhandled here.
            continue;
          }
          grants.push({
            assignmentId: mr.id,
            roleId: mr.roleId,
            scope,
            permissions,
          });
          // TRANSITIONAL: only tenant-scoped authority reaches the flat set the
          // legacy permission-only guard consumes. See `tenant-context.ts`.
          if (scope.type === 'tenant') {
            for (const code of permissions) {
              tenantPermissions.add(code);
            }
          }
        }

        return {
          context,
          permissions: tenantPermissions,
          grants,
          authzEpoch: membership.authzEpoch,
          scopeReviewRequired,
        };
      },
    );
  }

  /**
   * The branch a POS session may operate on, from LIVE server state only.
   *
   * Three live facts, all required (amendment clause 6):
   *   1. the bound terminal still exists and is `active` — so FR-SEC-028
   *      revocation takes effect on the very next request;
   *   2. the session names the employee it authenticated (FR-SEC-021);
   *   3. that employee is STILL permitted at the terminal's branch — so an HR
   *      removal takes effect on the very next request.
   *
   * Any failure is the same generic 403: a POS terminal must not be able to
   * probe which of the three conditions it failed.
   */
  private async resolvePosBranch(
    tx: Prisma.TransactionClient,
    principal: AuthenticatedPrincipal,
  ): Promise<string> {
    const denied = new ForbiddenException('POS session is not permitted here.');

    if (!principal.terminalId || !principal.employeeId) {
      throw denied;
    }
    const terminal = await tx.terminal.findUnique({
      where: { id: principal.terminalId },
      select: { branchId: true, status: true },
    });
    if (!terminal || terminal.status !== 'active') {
      throw denied;
    }
    const permitted = await tx.employeeBranch.findFirst({
      where: {
        employeeId: principal.employeeId,
        branchId: terminal.branchId,
        employee: { status: 'active' },
      },
      select: { branchId: true },
    });
    if (!permitted) {
      throw denied;
    }
    return terminal.branchId;
  }
}

/** Map a persisted assignment row onto the pure `AssignmentScope` union. */
function toAssignmentScope(row: {
  scopeType: string;
  scopeBrandId: string | null;
  scopeBranchId: string | null;
}): AssignmentScope | null {
  switch (row.scopeType) {
    case 'tenant':
      return { type: 'tenant' };
    case 'brand':
      return row.scopeBrandId
        ? { type: 'brand', brandId: row.scopeBrandId }
        : null;
    case 'branch':
      return row.scopeBranchId
        ? { type: 'branch', branchId: row.scopeBranchId }
        : null;
    default:
      return null;
  }
}
