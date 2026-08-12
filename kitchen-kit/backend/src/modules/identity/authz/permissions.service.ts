import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Permission } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  IDENTITY_PERMISSION_DEFS,
  PermissionDef,
} from './permissions.constants';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent upsert of a permission by its stable code. */
  upsert(def: PermissionDef): Promise<Permission> {
    return this.prisma.permission.upsert({
      where: { code: def.code },
      update: { module: def.module, description: def.description },
      create: {
        id: newId(),
        code: def.code,
        module: def.module,
        description: def.description,
      },
    });
  }

  async upsertMany(defs: PermissionDef[]): Promise<void> {
    for (const def of defs) {
      await this.upsert(def);
    }
  }

  /** Seed the identity-domain permission catalog (safe to run repeatedly). */
  ensureIdentityPermissions(): Promise<void> {
    return this.upsertMany(IDENTITY_PERMISSION_DEFS);
  }

  findByCodes(codes: string[]): Promise<Permission[]> {
    return this.prisma.permission.findMany({ where: { code: { in: codes } } });
  }

  listAll(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }
}
