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
import { toMenuView } from '../catalogue.views';

const BRANCH_NOT_FOUND = 'Branch not found.';
const ASSIGNMENT_EXISTS = 'This menu is already assigned to that branch.';

export interface CreateMenuInput {
  name: Record<string, unknown>;
  orderTypes?: string[];
  activeWindow?: Record<string, unknown>;
  priority?: number;
}

export type UpdateMenuInput = Partial<CreateMenuInput>;

/**
 * Menu administration (FR-MNU-001/002/003).
 *
 * Menu applicability is the combination of an explicit branch assignment
 * (C-01), `orderTypes`, `activeWindow`, `priority` and `isActive`. No implicit
 * tenant-global resolution exists: a menu with no branch assignment applies to
 * no branch.
 */
@Injectable()
export class MenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(tenantId: string, actorId: string, input: CreateMenuInput) {
    const menu = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const created = await tx.menu.create({
          data: {
            id: newId(),
            tenantId,
            name: input.name as Prisma.InputJsonValue,
            orderTypes: input.orderTypes ?? [],
            ...(input.activeWindow !== undefined
              ? { activeWindow: input.activeWindow as Prisma.InputJsonValue }
              : {}),
            ...(input.priority !== undefined
              ? { priority: input.priority }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MENU_CREATED,
          entityType: AUDIT_ENTITY.MENU,
          actorType: 'user',
          actorId,
          entityId: created.id,
          metadata: {
            orderTypes: created.orderTypes,
            priority: created.priority,
          },
        });
        return created;
      },
    );
    return toMenuView(menu);
  }

  list(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.menu.findMany({
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        }),
      )
      .then((rows) => rows.map(toMenuView));
  }

  async findOne(tenantId: string, menuId: string) {
    const menu = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.menu.findUnique({ where: { id: menuId } }),
    );
    if (!menu) {
      throw new NotFoundException('Menu not found.');
    }
    return toMenuView(menu);
  }

  async update(
    tenantId: string,
    actorId: string,
    menuId: string,
    input: UpdateMenuInput,
  ) {
    const menu = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.menu.findUnique({ where: { id: menuId } });
        if (!existing) {
          throw new NotFoundException('Menu not found.');
        }
        const updated = await tx.menu.update({
          where: { id: menuId },
          data: {
            ...(input.name !== undefined
              ? { name: input.name as Prisma.InputJsonValue }
              : {}),
            ...(input.orderTypes !== undefined
              ? { orderTypes: input.orderTypes }
              : {}),
            ...(input.activeWindow !== undefined
              ? { activeWindow: input.activeWindow as Prisma.InputJsonValue }
              : {}),
            ...(input.priority !== undefined
              ? { priority: input.priority }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MENU_UPDATED,
          entityType: AUDIT_ENTITY.MENU,
          actorType: 'user',
          actorId,
          entityId: menuId,
          before: {
            priority: existing.priority,
            orderTypes: existing.orderTypes,
          },
          metadata: {
            priority: updated.priority,
            orderTypes: updated.orderTypes,
          },
        });
        return updated;
      },
    );
    return toMenuView(menu);
  }

  /** C-09: Catalogue lifecycle is an explicit, audited operation. */
  async setActive(
    tenantId: string,
    actorId: string,
    menuId: string,
    isActive: boolean,
  ) {
    const menu = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.menu.findUnique({ where: { id: menuId } });
        if (!existing) {
          throw new NotFoundException('Menu not found.');
        }
        const updated = await tx.menu.update({
          where: { id: menuId },
          data: { isActive },
        });
        await this.audit.record(tx, {
          tenantId,
          action: isActive
            ? AUDIT_ACTION.MENU_ACTIVATED
            : AUDIT_ACTION.MENU_DEACTIVATED,
          entityType: AUDIT_ENTITY.MENU,
          actorType: 'user',
          actorId,
          entityId: menuId,
          before: { isActive: existing.isActive },
          metadata: { isActive: updated.isActive },
        });
        return updated;
      },
    );
    return toMenuView(menu);
  }

  /**
   * C-01 / FR-MNU-002: assign a menu to a branch. Both edges use composite
   * tenant-safe FKs, so neither the menu nor the branch can belong to another
   * tenant.
   */
  async assignBranch(
    tenantId: string,
    actorId: string,
    menuId: string,
    branchId: string,
  ): Promise<void> {
    try {
      await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const menu = await tx.menu.findUnique({ where: { id: menuId } });
          if (!menu) {
            throw new NotFoundException('Menu not found.');
          }
          await tx.menuBranch.create({
            data: { id: newId(), tenantId, menuId, branchId },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.MENU_BRANCH_ASSIGNED,
            entityType: AUDIT_ENTITY.MENU_BRANCH,
            actorType: 'user',
            actorId,
            entityId: menuId,
            metadata: { menuId, branchId },
          });
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, BRANCH_NOT_FOUND, ASSIGNMENT_EXISTS);
    }
  }

  async unassignBranch(
    tenantId: string,
    actorId: string,
    menuId: string,
    branchId: string,
  ): Promise<void> {
    await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const link = await tx.menuBranch.findUnique({
          where: {
            tenantId_menuId_branchId: { tenantId, menuId, branchId },
          },
        });
        if (!link) {
          throw new NotFoundException('Menu branch assignment not found.');
        }
        await tx.menuBranch.delete({ where: { id: link.id } });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MENU_BRANCH_UNASSIGNED,
          entityType: AUDIT_ENTITY.MENU_BRANCH,
          actorType: 'user',
          actorId,
          entityId: menuId,
          before: { menuId, branchId },
        });
      },
    );
  }

  listBranches(tenantId: string, menuId: string): Promise<string[]> {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        const menu = await tx.menu.findUnique({ where: { id: menuId } });
        if (!menu) {
          throw new NotFoundException('Menu not found.');
        }
        return tx.menuBranch.findMany({
          where: { menuId },
          select: { branchId: true },
        });
      })
      .then((rows) => rows.map((r) => r.branchId));
  }

  /**
   * FR-MNU-002/003: menus applicable to a branch, ordered by explicit priority.
   * Resolution is assignment + isActive + priority; `orderTypes` and
   * `activeWindow` are returned for the caller to evaluate — this phase does not
   * implement time-window evaluation (no source defines the window format).
   */
  async resolveForBranch(tenantId: string, branchId: string) {
    const rows = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.menuBranch.findMany({
        where: { branchId },
        select: { menu: true },
      }),
    );
    const menus = rows
      .map((r) => r.menu)
      .filter((m) => m.isActive)
      .sort((a, b) => b.priority - a.priority);
    // FR-MNU-003: warn when the configuration is ambiguous.
    const ambiguous = menus.some(
      (m, i) => i > 0 && m.priority === menus[i - 1].priority,
    );
    return {
      menus: menus.map(toMenuView),
      ambiguous,
      ...(ambiguous
        ? {
            warning:
              'Multiple active menus share the same priority for this branch; resolution order is not deterministic.',
          }
        : {}),
    };
  }
}
