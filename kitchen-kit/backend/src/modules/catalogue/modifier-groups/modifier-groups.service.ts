import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { toModifierGroupView, toModifierView } from '../catalogue.views';
import { assertSelectionRules } from './selection-rules';

export interface CreateModifierGroupInput {
  name: Record<string, unknown>;
  minSelections?: number;
  maxSelections?: number;
  isRequired?: boolean;
  allowRepeat?: boolean;
  freeQuantityThreshold?: number;
}

export interface CreateModifierInput {
  name: Record<string, unknown>;
  priceDelta?: string;
  stockItemId?: string;
  consumptionQuantity?: string;
  consumptionUnitId?: string;
  recipeDelta?: Record<string, unknown>;
  isDefault?: boolean;
  sortOrder?: number;
}

/**
 * ModifierGroup (FR-MNU-010/011).
 *
 * SRS §7.3 #8 invariants (min ≤ max; required ⇒ min ≥ 1) are enforced BOTH in
 * the service (400 with a clear message) and by DB CHECK constraints
 * `ck_min_le_max` / `ck_required_min` — the database is the final boundary.
 */
@Injectable()
export class ModifierGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    input: CreateModifierGroupInput,
  ) {
    const min = input.minSelections ?? 0;
    const max = input.maxSelections ?? 1;
    assertSelectionRules(min, max, input.isRequired ?? false);

    const group = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const created = await tx.modifierGroup.create({
          data: {
            id: newId(),
            tenantId,
            name: input.name as Prisma.InputJsonValue,
            minSelections: min,
            maxSelections: max,
            isRequired: input.isRequired ?? false,
            allowRepeat: input.allowRepeat ?? false,
            freeQuantityThreshold: input.freeQuantityThreshold ?? 0,
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MODIFIER_GROUP_CREATED,
          entityType: AUDIT_ENTITY.MODIFIER_GROUP,
          actorType: 'user',
          actorId,
          entityId: created.id,
          metadata: {
            minSelections: created.minSelections,
            maxSelections: created.maxSelections,
            isRequired: created.isRequired,
          },
        });
        return created;
      },
    );
    return toModifierGroupView(group);
  }

  list(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) => tx.modifierGroup.findMany())
      .then((rows) => rows.map(toModifierGroupView));
  }

  async update(
    tenantId: string,
    actorId: string,
    groupId: string,
    input: Partial<CreateModifierGroupInput>,
  ) {
    const group = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.modifierGroup.findUnique({
          where: { id: groupId },
        });
        if (!existing) {
          throw new NotFoundException('Modifier group not found.');
        }
        const min = input.minSelections ?? existing.minSelections;
        const max = input.maxSelections ?? existing.maxSelections;
        assertSelectionRules(min, max, input.isRequired ?? existing.isRequired);

        const updated = await tx.modifierGroup.update({
          where: { id: groupId },
          data: {
            ...(input.name !== undefined
              ? { name: input.name as Prisma.InputJsonValue }
              : {}),
            minSelections: min,
            maxSelections: max,
            ...(input.isRequired !== undefined
              ? { isRequired: input.isRequired }
              : {}),
            ...(input.allowRepeat !== undefined
              ? { allowRepeat: input.allowRepeat }
              : {}),
            ...(input.freeQuantityThreshold !== undefined
              ? { freeQuantityThreshold: input.freeQuantityThreshold }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MODIFIER_GROUP_UPDATED,
          entityType: AUDIT_ENTITY.MODIFIER_GROUP,
          actorType: 'user',
          actorId,
          entityId: groupId,
          before: {
            minSelections: existing.minSelections,
            maxSelections: existing.maxSelections,
          },
          metadata: {
            minSelections: updated.minSelections,
            maxSelections: updated.maxSelections,
          },
        });
        return updated;
      },
    );
    return toModifierGroupView(group);
  }

  /** FR-MNU-012/013: stock linkage and recipe delta are RECORDED, never executed. */
  async addModifier(
    tenantId: string,
    actorId: string,
    groupId: string,
    input: CreateModifierInput,
  ) {
    let priceDelta: bigint;
    try {
      priceDelta = BigInt(input.priceDelta ?? '0');
    } catch {
      throw new BadRequestException('priceDelta must be an integer string.');
    }

    const modifier = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const group = await tx.modifierGroup.findUnique({
          where: { id: groupId },
        });
        if (!group) {
          throw new NotFoundException('Modifier group not found.');
        }
        const created = await tx.modifier.create({
          data: {
            id: newId(),
            modifierGroupId: groupId,
            name: input.name as Prisma.InputJsonValue,
            priceDelta,
            stockItemId: input.stockItemId ?? null,
            consumptionQuantity: input.consumptionQuantity ?? null,
            consumptionUnitId: input.consumptionUnitId ?? null,
            ...(input.recipeDelta !== undefined
              ? { recipeDelta: input.recipeDelta as Prisma.InputJsonValue }
              : {}),
            isDefault: input.isDefault ?? false,
            ...(input.sortOrder !== undefined
              ? { sortOrder: input.sortOrder }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.MODIFIER_CREATED,
          entityType: AUDIT_ENTITY.MODIFIER,
          actorType: 'user',
          actorId,
          entityId: created.id,
          metadata: {
            modifierGroupId: groupId,
            priceDelta: created.priceDelta.toString(),
          },
        });
        return created;
      },
    );
    return toModifierView(modifier);
  }

  listModifiers(tenantId: string, groupId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        const group = await tx.modifierGroup.findUnique({
          where: { id: groupId },
        });
        if (!group) {
          throw new NotFoundException('Modifier group not found.');
        }
        return tx.modifier.findMany({
          where: { modifierGroupId: groupId },
          orderBy: { sortOrder: 'asc' },
        });
      })
      .then((rows) => rows.map(toModifierView));
  }
}
