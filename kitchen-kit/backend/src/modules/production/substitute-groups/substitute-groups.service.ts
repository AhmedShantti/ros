import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';

const MEMBER_NOT_FOUND = 'Substitute group or stock item not found.';

/**
 * Substitute groups (§7.4.4 "Alternatives permitted", approved SQL L483–494).
 *
 * Exactly what the sources establish and nothing more. **No substitution
 * selection algorithm exists**: no source defines how a substitute is chosen,
 * when, by whom, or with what cost consequence, so in this phase substitute
 * groups are pure configuration.
 *
 * Per D-17-06 every operation here is governed by `recipe.edit`; no new
 * permission code is introduced.
 */
@Injectable()
export class SubstituteGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    input: { name: string; stockItemIds?: string[] },
  ) {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const group = await tx.substituteGroup.create({
            data: { id: newId(), tenantId, name: input.name },
          });
          const members = input.stockItemIds ?? [];
          if (members.length) {
            await tx.substituteGroupMember.createMany({
              data: members.map((stockItemId) => ({
                tenantId,
                substituteGroupId: group.id,
                stockItemId,
              })),
              skipDuplicates: true,
            });
          }
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.SUBSTITUTE_GROUP_CREATED,
            entityType: AUDIT_ENTITY.SUBSTITUTE_GROUP,
            entityId: group.id,
            actorType: 'user',
            actorId,
            metadata: { name: group.name, memberCount: members.length },
          });
          return group;
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, MEMBER_NOT_FOUND);
    }
  }

  async addMember(
    tenantId: string,
    actorId: string,
    groupId: string,
    stockItemId: string,
  ) {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          // Cross-tenant groups are invisible under RLS -> 404, not 403.
          const group = await tx.substituteGroup.findUnique({
            where: { id: groupId },
            select: { id: true },
          });
          if (!group)
            throw new NotFoundException('Substitute group not found.');

          const member = await tx.substituteGroupMember.create({
            data: { tenantId, substituteGroupId: groupId, stockItemId },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.SUBSTITUTE_GROUP_UPDATED,
            entityType: AUDIT_ENTITY.SUBSTITUTE_GROUP,
            entityId: groupId,
            actorType: 'user',
            actorId,
            metadata: { addedStockItemId: stockItemId },
          });
          return member;
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(
        err,
        MEMBER_NOT_FOUND,
        'That stock item is already a member of this substitute group.',
      );
    }
  }

  list(tenantId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.substituteGroup.findMany({
        orderBy: { name: 'asc' },
        include: { members: { select: { stockItemId: true } } },
      }),
    );
  }
}
