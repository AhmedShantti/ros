/**
 * D-17-07 resolution — the real, structured replacement for the permanently
 * opaque `catalogue.modifiers.recipe_delta` (P1E-5: created, never read;
 * stays that way permanently per P1F2E-A's NON-GOALS). Full-replace via
 * `PUT /modifiers/{modifierId}/recipe-effects`, shaped like `PUT
 * /recipes/:id/versions/:v/lines` (`RecipeVersionsService.replaceLines`):
 * `deleteMany` + `createMany`, one audit entry, `rethrowAsNotFoundOnFk` for a
 * bad `modifierId`.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { ModifierKind, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';

export interface ModifierRecipeEffectInput {
  sequence: number;
  operation: 'add' | 'remove_all';
  componentType: 'stock_item' | 'sub_recipe';
  stockItemId?: string;
  subRecipeId?: string;
  quantity?: string;
  unitId?: string;
}

const PARENT_NOT_FOUND = 'Modifier, stock item, sub-recipe or unit not found.';

@Injectable()
export class ModifierRecipeEffectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private validate(effects: ModifierRecipeEffectInput[]): void {
    for (const e of effects) {
      const hasStockItem = !!e.stockItemId;
      const hasSubRecipe = !!e.subRecipeId;
      if (e.componentType === 'stock_item' && (!hasStockItem || hasSubRecipe)) {
        throw new BadRequestException(
          `Effect ${e.sequence}: a stock_item effect requires exactly a stockItemId.`,
        );
      }
      if (e.componentType === 'sub_recipe' && (!hasSubRecipe || hasStockItem)) {
        throw new BadRequestException(
          `Effect ${e.sequence}: a sub_recipe effect requires exactly a subRecipeId.`,
        );
      }
      if (e.operation === 'remove_all') {
        if (e.componentType !== 'stock_item') {
          throw new BadRequestException(
            `Effect ${e.sequence}: remove_all targets a stock_item only.`,
          );
        }
        if (e.quantity !== undefined || e.unitId !== undefined) {
          throw new BadRequestException(
            `Effect ${e.sequence}: remove_all must not carry a quantity or unit.`,
          );
        }
      } else {
        // add
        if (!e.quantity || Number(e.quantity) <= 0) {
          throw new BadRequestException(
            `Effect ${e.sequence}: add requires a positive quantity.`,
          );
        }
        if (!e.unitId) {
          throw new BadRequestException(
            `Effect ${e.sequence}: add requires a unit.`,
          );
        }
      }
    }
  }

  /**
   * Kind<->effect consistency (service-level; `Modifier.kind` is nullable
   * for legacy rows, so a null kind carries no constraint). `addition` may
   * only ADD; `removal` may only REMOVE_ALL; `substitution` may do both
   * (remove the displaced ingredient, add the substitute).
   */
  private assertKindConsistency(
    kind: ModifierKind | null,
    effects: ModifierRecipeEffectInput[],
  ): void {
    if (kind === null) return;
    const hasAdd = effects.some((e) => e.operation === 'add');
    const hasRemoveAll = effects.some((e) => e.operation === 'remove_all');
    if (kind === 'addition' && hasRemoveAll) {
      throw new BadRequestException(
        'An "addition" modifier cannot carry a remove_all recipe effect.',
      );
    }
    if (kind === 'removal' && hasAdd) {
      throw new BadRequestException(
        'A "removal" modifier cannot carry an add recipe effect.',
      );
    }
  }

  private async requireModifier(
    tx: Prisma.TransactionClient,
    modifierId: string,
  ) {
    const modifier = await tx.modifier.findUnique({
      where: { id: modifierId },
      select: { id: true, kind: true },
    });
    if (!modifier) throw new NotFoundException('Modifier not found.');
    return modifier;
  }

  async list(tenantId: string, modifierId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      await this.requireModifier(tx, modifierId);
      return tx.modifierRecipeEffect.findMany({
        where: { modifierId },
        orderBy: { sequence: 'asc' },
      });
    });
  }

  async replace(
    tenantId: string,
    actorId: string,
    modifierId: string,
    effects: ModifierRecipeEffectInput[],
  ) {
    this.validate(effects);
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const modifier = await this.requireModifier(tx, modifierId);
          this.assertKindConsistency(modifier.kind, effects);

          await tx.modifierRecipeEffect.deleteMany({ where: { modifierId } });
          if (effects.length) {
            await tx.modifierRecipeEffect.createMany({
              data: effects.map((e) => ({
                id: newId(),
                tenantId,
                modifierId,
                sequence: e.sequence,
                operation: e.operation,
                componentType: e.componentType,
                stockItemId: e.stockItemId ?? null,
                subRecipeId: e.subRecipeId ?? null,
                quantity: e.quantity ? new Prisma.Decimal(e.quantity) : null,
                unitId: e.unitId ?? null,
              })),
            });
          }

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.MODIFIER_RECIPE_EFFECTS_REPLACED,
            entityType: AUDIT_ENTITY.MODIFIER,
            entityId: modifierId,
            actorType: 'user',
            actorId,
            metadata: { modifierId, effectCount: effects.length },
          });

          const rows = await tx.modifierRecipeEffect.findMany({
            where: { modifierId },
            orderBy: { sequence: 'asc' },
          });
          return { modifierId, effects: rows };
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND);
    }
  }
}
