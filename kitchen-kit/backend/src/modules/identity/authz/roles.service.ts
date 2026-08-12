import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma, Role } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionsService } from './permissions.service';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Create a tenant-owned role. tenantId comes from the server-side principal,
   *  never the client; isSystem is always false here (system roles are seeded). */
  async createTenantRole(
    tenantId: string,
    input: { name: string; description?: string },
  ): Promise<Role> {
    try {
      return await this.prisma.role.create({
        data: {
          id: newId(),
          tenantId,
          name: input.name,
          description: input.description ?? null,
          isSystem: false,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('A role with this name already exists.');
      }
      throw err;
    }
  }

  /** Roles visible to a tenant: its own roles plus shared system roles. */
  listForTenant(tenantId: string): Promise<Role[]> {
    return this.prisma.role.findMany({
      where: { OR: [{ tenantId }, { isSystem: true }] },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Grant permissions to a tenant-owned role. Rejects modification of system
   * roles (403) and of roles that do not belong to the acting tenant (404, so a
   * caller cannot probe other tenants' role ids).
   */
  async addPermissions(
    actingTenantId: string,
    roleId: string,
    permissionCodes: string[],
  ): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    if (role.isSystem) {
      throw new ForbiddenException('System roles cannot be modified.');
    }
    if (role.tenantId !== actingTenantId) {
      throw new NotFoundException('Role not found.');
    }

    const permissions = await this.permissions.findByCodes(permissionCodes);
    if (permissions.length !== new Set(permissionCodes).size) {
      throw new BadRequestException('Unknown permission code.');
    }

    await this.prisma.$transaction(
      permissions.map((permission) =>
        this.prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId, permissionId: permission.id },
          },
          update: {},
          create: { roleId, permissionId: permission.id },
        }),
      ),
    );
  }
}
