import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedPrincipal } from '../auth/auth.types';
import { RequestAuthorization, TenantContext } from './tenant-context';

export type AuthorizedRequest = Request & {
  principal?: AuthenticatedPrincipal;
  authorization?: RequestAuthorization;
};

/**
 * The single authoritative resolver of the request's tenant authorization
 * context. Nothing else reconstructs user → membership → tenant.
 *
 * Resolution is derived exclusively from the signed principal (JWT claims that
 * JwtAuthGuard verified) and validated against the database in ONE query, which
 * simultaneously loads the effective permissions. It is memoized on the request
 * object, so multiple guards/handlers on the same request share a single query.
 * Because state lives on the (per-request) request object — not a global, not
 * AsyncLocalStorage, not a PostgreSQL session — there is no cross-request leak.
 */
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
   * Validate the principal's tenant context and load effective permissions.
   * Rejects (403) when there is no active tenant selection, or the membership
   * is inactive / does not belong to this user / does not belong to this tenant
   * / the tenant is inactive. JWT tampering never reaches here — the signature
   * check in JwtAuthGuard fails first (401).
   */
  async resolve(
    principal: AuthenticatedPrincipal,
  ): Promise<RequestAuthorization> {
    if (!principal.tenantId || !principal.membershipId) {
      throw new ForbiddenException('No active tenant context.');
    }

    // Resolve under the transaction-local RLS context (tenant + user). The same
    // context both validates the membership and gates the nested role/permission
    // reads at the database level.
    const membership = await this.prisma.withAuthContext(
      { userId: principal.userId, tenantId: principal.tenantId },
      (tx) =>
        tx.membership.findFirst({
          where: {
            id: principal.membershipId,
            userId: principal.userId,
            tenantId: principal.tenantId,
            status: 'active',
            tenant: { status: 'active' },
          },
          select: {
            id: true,
            membershipRoles: {
              where: {
                role: {
                  OR: [{ tenantId: principal.tenantId }, { isSystem: true }],
                },
              },
              select: {
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
        }),
    );

    if (!membership) {
      throw new ForbiddenException('Invalid tenant context.');
    }

    const permissions = new Set<string>();
    for (const mr of membership.membershipRoles) {
      for (const rp of mr.role.rolePermissions) {
        permissions.add(rp.permission.code);
      }
    }

    const context: TenantContext = {
      userId: principal.userId,
      sessionId: principal.sessionId,
      tenantId: principal.tenantId,
      membershipId: principal.membershipId,
      ...(principal.terminalId ? { terminalId: principal.terminalId } : {}),
    };

    return { context, permissions };
  }
}
