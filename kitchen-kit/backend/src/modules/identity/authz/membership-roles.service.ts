import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Assign/remove roles on memberships. Every query runs under the acting tenant's
 * RLS context (app.tenant_id), so cross-tenant (BOLA/IDOR) assignment is
 * impossible at BOTH layers: the foreign membership/role is invisible to the
 * query, and the membership_roles write policy rejects it.
 */
@Injectable()
export class MembershipRolesService {
  constructor(private readonly prisma: PrismaService) {}

  async assign(
    actingTenantId: string,
    membershipId: string,
    roleId: string,
  ): Promise<void> {
    await this.prisma.withAuthContext(
      { tenantId: actingTenantId },
      async (tx) => {
        const membership = await tx.membership.findFirst({
          where: { id: membershipId, tenantId: actingTenantId },
          select: { id: true },
        });
        if (!membership) {
          throw new NotFoundException('Membership not found.');
        }
        const role = await tx.role.findUnique({ where: { id: roleId } });
        if (!role) {
          throw new NotFoundException('Role not found.');
        }
        if (role.isSystem) {
          throw new ForbiddenException('System roles cannot be assigned here.');
        }
        if (role.tenantId !== actingTenantId) {
          throw new NotFoundException('Role not found.');
        }
        await tx.membershipRole.upsert({
          where: { membershipId_roleId: { membershipId, roleId } },
          update: {},
          create: { membershipId, roleId },
        });
      },
    );
  }

  async remove(
    actingTenantId: string,
    membershipId: string,
    roleId: string,
  ): Promise<void> {
    await this.prisma.withAuthContext(
      { tenantId: actingTenantId },
      async (tx) => {
        const membership = await tx.membership.findFirst({
          where: { id: membershipId, tenantId: actingTenantId },
          select: { id: true },
        });
        if (!membership) {
          throw new NotFoundException('Membership not found.');
        }
        await tx.membershipRole.deleteMany({ where: { membershipId, roleId } });
      },
    );
  }
}
