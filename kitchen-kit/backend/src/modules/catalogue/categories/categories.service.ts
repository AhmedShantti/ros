import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { toCategoryView } from '../catalogue.views';

const PARENT_NOT_FOUND = 'Menu or parent category not found.';

export interface CreateCategoryInput {
  name: Record<string, unknown>;
  parentCategoryId?: string;
  sortOrder?: number;
  colour?: string;
}

/**
 * Category / sub-category (FR-MNU-001). Menu-scoped; the optional sub-category
 * level is the self-referencing `parentCategoryId`.
 *
 * C-09: categories have NO lifecycle column in the approved SQL, so there is no
 * activate/deactivate operation — none was added for symmetry.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    menuId: string,
    input: CreateCategoryInput,
  ) {
    try {
      const category = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const menu = await tx.menu.findUnique({ where: { id: menuId } });
          if (!menu) {
            throw new NotFoundException('Menu not found.');
          }
          const created = await tx.category.create({
            data: {
              id: newId(),
              tenantId,
              menuId,
              parentCategoryId: input.parentCategoryId ?? null,
              name: input.name as Prisma.InputJsonValue,
              ...(input.sortOrder !== undefined
                ? { sortOrder: input.sortOrder }
                : {}),
              colour: input.colour ?? null,
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.CATEGORY_CREATED,
            entityType: AUDIT_ENTITY.CATEGORY,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: { menuId, parentCategoryId: created.parentCategoryId },
          });
          return created;
        },
      );
      return toCategoryView(category);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND);
    }
  }

  listForMenu(tenantId: string, menuId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        const menu = await tx.menu.findUnique({ where: { id: menuId } });
        if (!menu) {
          throw new NotFoundException('Menu not found.');
        }
        return tx.category.findMany({
          where: { menuId },
          orderBy: { sortOrder: 'asc' },
        });
      })
      .then((rows) => rows.map(toCategoryView));
  }

  async update(
    tenantId: string,
    actorId: string,
    categoryId: string,
    input: Partial<CreateCategoryInput>,
  ) {
    try {
      const category = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.category.findUnique({
            where: { id: categoryId },
          });
          if (!existing) {
            throw new NotFoundException('Category not found.');
          }
          const updated = await tx.category.update({
            where: { id: categoryId },
            data: {
              ...(input.name !== undefined
                ? { name: input.name as Prisma.InputJsonValue }
                : {}),
              ...(input.parentCategoryId !== undefined
                ? { parentCategoryId: input.parentCategoryId }
                : {}),
              ...(input.sortOrder !== undefined
                ? { sortOrder: input.sortOrder }
                : {}),
              ...(input.colour !== undefined ? { colour: input.colour } : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.CATEGORY_UPDATED,
            entityType: AUDIT_ENTITY.CATEGORY,
            actorType: 'user',
            actorId,
            entityId: categoryId,
            before: { sortOrder: existing.sortOrder },
            metadata: { sortOrder: updated.sortOrder },
          });
          return updated;
        },
      );
      return toCategoryView(category);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND);
    }
  }
}
