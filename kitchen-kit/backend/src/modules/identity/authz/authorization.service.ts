import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedPrincipal } from '../auth/auth.types';

/**
 * Resolves the effective permissions of the ACTIVE membership by walking
 * Membership → MembershipRole → Role → RolePermission → Permission entirely
 * server-side. The query re-asserts, from the DB, that the membership named in
 * the signed principal is active and belongs to this user AND tenant, and only
 * counts roles that belong to the tenant or are system roles — so a stale or
 * inconsistent token, or a cross-tenant role, grants nothing.
 */
@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePermissions(
    principal: AuthenticatedPrincipal,
  ): Promise<Set<string>> {
    if (!principal.tenantId || !principal.membershipId) {
      return new Set();
    }

    const rows = await this.prisma.membershipRole.findMany({
      where: {
        membershipId: principal.membershipId,
        membership: {
          userId: principal.userId,
          tenantId: principal.tenantId,
          status: 'active',
        },
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
    });

    const codes = new Set<string>();
    for (const row of rows) {
      for (const rp of row.role.rolePermissions) {
        codes.add(rp.permission.code);
      }
    }
    return codes;
  }

  async hasAll(
    principal: AuthenticatedPrincipal,
    codes: string[],
  ): Promise<boolean> {
    const effective = await this.getEffectivePermissions(principal);
    return codes.every((code) => effective.has(code));
  }

  async hasAny(
    principal: AuthenticatedPrincipal,
    codes: string[],
  ): Promise<boolean> {
    const effective = await this.getEffectivePermissions(principal);
    return codes.some((code) => effective.has(code));
  }
}
