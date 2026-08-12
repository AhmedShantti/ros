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

/**
 * Tenant role administration. All writes run under a tenant-scoped RLS context
 * (app.tenant_id) so PostgreSQL is the final boundary: even if a check were
 * missed, the roles / role_permissions policies reject cross-tenant writes.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Create a tenant-owned role. tenantId comes from the server-side principal;
   *  isSystem is always false (system roles are seeded by the migration role). */
  async createTenantRole(
    tenantId: string,
    input: { name: string; description?: string },
  ): Promise<Role> {
    try {
      return await this.prisma.withAuthContext({ tenantId }, (tx) =>
        tx.role.create({
          data: {
            id: newId(),
            tenantId,
            name: input.name,
            description: input.description ?? null,
            isSystem: false,
          },
        }),
      );
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
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.role.findMany({ orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] }),
    );
  }

  /**
   * Grant permissions to a tenant-owned role. Rejects system roles (403) and
   * roles not in the acting tenant (404, so foreign role ids can't be probed).
   */
  async addPermissions(
    actingTenantId: string,
    roleId: string,
    permissionCodes: string[],
  ): Promise<void> {
    const permissions = await this.permissions.findByCodes(permissionCodes);
    if (permissions.length !== new Set(permissionCodes).size) {
      throw new BadRequestException('Unknown permission code.');
    }

    await this.prisma.withAuthContext(
      { tenantId: actingTenantId },
      async (tx) => {
        // Under RLS a foreign-tenant role is simply invisible → treated as 404.
        const role = await tx.role.findUnique({ where: { id: roleId } });
        if (!role) {
          throw new NotFoundException('Role not found.');
        }
        if (role.isSystem) {
          throw new ForbiddenException('System roles cannot be modified.');
        }
        if (role.tenantId !== actingTenantId) {
          throw new NotFoundException('Role not found.');
        }
        for (const permission of permissions) {
          await tx.rolePermission.upsert({
            where: {
              roleId_permissionId: { roleId, permissionId: permission.id },
            },
            update: {},
            create: { roleId, permissionId: permission.id },
          });
        }
      },
    );
  }
}
