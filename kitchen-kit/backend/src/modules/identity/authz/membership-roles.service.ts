import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Assign/remove roles on memberships. Every query is scoped to the acting tenant
 * (from the signed principal), which is what prevents cross-tenant (BOLA/IDOR)
 * assignment: a caller cannot bind a role or membership from another tenant by
 * changing ids in the request.
 */
@Injectable()
export class MembershipRolesService {
  constructor(private readonly prisma: PrismaService) {}

  async assign(
    actingTenantId: string,
    membershipId: string,
    roleId: string,
  ): Promise<void> {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, tenantId: actingTenantId },
      select: { id: true },
    });
    if (!membership) {
      throw new NotFoundException('Membership not found.');
    }

    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    if (role.isSystem) {
      throw new ForbiddenException('System roles cannot be assigned here.');
    }
    // Cross-tenant role → hidden as not-found (no probing other tenants' roles).
    if (role.tenantId !== actingTenantId) {
      throw new NotFoundException('Role not found.');
    }

    await this.prisma.membershipRole.upsert({
      where: { membershipId_roleId: { membershipId, roleId } },
      update: {},
      create: { membershipId, roleId },
    });
  }

  async remove(
    actingTenantId: string,
    membershipId: string,
    roleId: string,
  ): Promise<void> {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, tenantId: actingTenantId },
      select: { id: true },
    });
    if (!membership) {
      throw new NotFoundException('Membership not found.');
    }
    await this.prisma.membershipRole.deleteMany({
      where: { membershipId, roleId },
    });
  }
}
