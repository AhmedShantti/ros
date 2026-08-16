import {
  BadRequestException,
  ConflictException,
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
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import {
  nextVersionNumber,
  selectPublishedVersion,
  SubRecipeEdge,
  wouldCreateCycle,
} from '../recipe-graph';

export interface RecipeLineInput {
  sequence: number;
  componentType: 'stock_item' | 'sub_recipe';
  stockItemId?: string;
  subRecipeId?: string;
  quantity: string;
  unitId: string;
  wastagePercentage?: string;
  isOptional?: boolean;
  substituteGroupId?: string;
}

export interface CreateVersionInput {
  yieldQuantity: string;
  yieldUnitId: string;
  yieldPercentage?: string;
  prepTimeSeconds?: number;
  /** D-17-08 Q2: stored and echoed only. Never read for selection. */
  effectiveFrom?: string;
  instructions?: Record<string, unknown>;
  referenceImages?: Record<string, unknown>;
  lines?: RecipeLineInput[];
}

const PARENT_NOT_FOUND =
  'Recipe, unit, stock item, sub-recipe or substitute group not found.';

/**
 * Recipe versions — authoring, publication and supersession.
 *
 * D-17-04 lifecycle: `draft -> published -> superseded`. `archived` is not a
 * member of the enum, so it is unrepresentable rather than merely unused.
 *
 * D-17-08 selection: the effective version is THE single `published` row.
 * `effective_from` is informational and appears in no predicate, no ORDER BY
 * and no branch of the publish path. Uniqueness is guaranteed by the partial
 * unique index, not by application logic.
 *
 * Immutability (GAP-2) is enforced by the DATABASE, not here: `ros_app` holds
 * `UPDATE (status)` only on `recipe_versions`, and `recipe_lines` write
 * policies require the parent version to be `draft`. The service guards exist
 * to return clean 409s instead of raw privilege errors.
 */
@Injectable()
export class RecipeVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async requireRecipe(tx: Prisma.TransactionClient, recipeId: string) {
    // Cross-tenant recipes are invisible under RLS, so this is a 404 for both
    // "does not exist" and "belongs to another tenant" — no existence leak.
    const recipe = await tx.recipe.findUnique({ where: { id: recipeId } });
    if (!recipe) throw new NotFoundException('Recipe not found.');
    return recipe;
  }

  /**
   * BR-MNU-001 / FR-MNU-042 — reject a cycle, reporting the full path.
   *
   * Enforced in the service because PostgreSQL cannot express reachability as
   * a declarative constraint and triggers are not authorized. No depth limit is
   * applied: BR-MNU-003's limit of 10 belongs to deferred cost expansion.
   */
  private async assertNoCycle(
    tx: Prisma.TransactionClient,
    ownerRecipeId: string,
    componentRecipeIds: string[],
  ): Promise<void> {
    if (componentRecipeIds.length === 0) return;

    // The whole tenant's sub-recipe graph. Bounded by RLS to this tenant.
    const rows = await tx.recipeLine.findMany({
      where: { componentType: 'sub_recipe' },
      select: {
        subRecipeId: true,
        recipeVersion: { select: { recipeId: true } },
      },
    });
    const edges: SubRecipeEdge[] = rows
      .filter((r) => r.subRecipeId !== null)
      .map((r) => ({
        fromRecipeId: r.recipeVersion.recipeId,
        toRecipeId: r.subRecipeId as string,
      }));

    for (const componentId of componentRecipeIds) {
      const cycle = wouldCreateCycle(ownerRecipeId, componentId, edges);
      if (cycle) {
        throw new BadRequestException({
          message:
            'Circular sub-recipe reference rejected (BR-MNU-001). ' +
            `Cycle path: ${cycle.join(' -> ')}`,
          cyclePath: cycle,
        });
      }
      edges.push({ fromRecipeId: ownerRecipeId, toRecipeId: componentId });
    }
  }

  private lineData(
    tenantId: string,
    recipeVersionId: string,
    lines: RecipeLineInput[],
  ) {
    return lines.map((l) => {
      if (
        l.componentType === 'stock_item' &&
        (!l.stockItemId || l.subRecipeId)
      ) {
        throw new BadRequestException(
          'A stock_item line requires exactly a stockItemId.',
        );
      }
      if (
        l.componentType === 'sub_recipe' &&
        (!l.subRecipeId || l.stockItemId)
      ) {
        throw new BadRequestException(
          'A sub_recipe line requires exactly a subRecipeId.',
        );
      }
      return {
        id: newId(),
        tenantId,
        recipeVersionId,
        sequence: l.sequence,
        componentType: l.componentType,
        stockItemId: l.stockItemId ?? null,
        subRecipeId: l.subRecipeId ?? null,
        quantity: new Prisma.Decimal(l.quantity),
        unitId: l.unitId,
        wastagePercentage: new Prisma.Decimal(l.wastagePercentage ?? '0'),
        isOptional: l.isOptional ?? false,
        substituteGroupId: l.substituteGroupId ?? null,
      };
    });
  }

  /** FR-MNU-045 — create a new DRAFT version of an existing recipe. */
  async createDraft(
    tenantId: string,
    actorId: string,
    recipeId: string,
    input: CreateVersionInput,
  ) {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          await this.requireRecipe(tx, recipeId);

          const existing = await tx.recipeVersion.findMany({
            where: { recipeId },
            select: { version: true },
          });
          const version = nextVersionNumber(existing);

          const lines = input.lines ?? [];
          await this.assertNoCycle(
            tx,
            recipeId,
            lines
              .filter((l) => l.componentType === 'sub_recipe')
              .map((l) => l.subRecipeId as string),
          );

          const created = await tx.recipeVersion.create({
            data: {
              id: newId(),
              tenantId,
              recipeId,
              version,
              // Always draft. There is no path that inserts a published row.
              status: 'draft',
              yieldQuantity: new Prisma.Decimal(input.yieldQuantity),
              yieldUnitId: input.yieldUnitId,
              yieldPercentage: new Prisma.Decimal(
                input.yieldPercentage ?? '100',
              ),
              prepTimeSeconds: input.prepTimeSeconds ?? null,
              // Stored verbatim; never consulted (D-17-08 Q2).
              effectiveFrom: input.effectiveFrom
                ? new Date(input.effectiveFrom)
                : null,
              instructions: (input.instructions ??
                null) as Prisma.InputJsonValue,
              referenceImages: (input.referenceImages ??
                null) as Prisma.InputJsonValue,
            },
          });

          if (lines.length) {
            await tx.recipeLine.createMany({
              data: this.lineData(tenantId, created.id, lines),
            });
          }

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.RECIPE_VERSION_CREATED,
            entityType: AUDIT_ENTITY.RECIPE_VERSION,
            entityId: created.id,
            actorType: 'user',
            actorId,
            metadata: { recipeId, version, lineCount: lines.length },
          });
          return created;
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND);
    }
  }

  /**
   * Replace a DRAFT version's lines. Published versions are refused here with a
   * 409; the database would refuse them anyway through the status-predicated
   * RLS policies, so this guard is for the error message, not the guarantee.
   */
  async replaceLines(
    tenantId: string,
    actorId: string,
    recipeId: string,
    versionNo: number,
    lines: RecipeLineInput[],
  ) {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const version = await this.requireVersion(tx, recipeId, versionNo);
          if (version.status !== 'draft') {
            throw new ConflictException(
              'Only a draft version may be edited. Published versions are immutable (D-17-04).',
            );
          }
          await this.assertNoCycle(
            tx,
            recipeId,
            lines
              .filter((l) => l.componentType === 'sub_recipe')
              .map((l) => l.subRecipeId as string),
          );
          await tx.recipeLine.deleteMany({
            where: { recipeVersionId: version.id },
          });
          if (lines.length) {
            await tx.recipeLine.createMany({
              data: this.lineData(tenantId, version.id, lines),
            });
          }
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.RECIPE_VERSION_UPDATED,
            entityType: AUDIT_ENTITY.RECIPE_VERSION,
            entityId: version.id,
            actorType: 'user',
            actorId,
            metadata: { recipeId, version: versionNo, lineCount: lines.length },
          });
          return { ...version, lineCount: lines.length };
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND);
    }
  }

  private async requireVersion(
    tx: Prisma.TransactionClient,
    recipeId: string,
    versionNo: number,
  ) {
    await this.requireRecipe(tx, recipeId);
    const version = await tx.recipeVersion.findFirst({
      where: { recipeId, version: versionNo },
    });
    if (!version) throw new NotFoundException('Recipe version not found.');
    return version;
  }

  /**
   * FR-MNU-045 publication, in ONE transaction:
   *   1. require the target to be a draft;
   *   2. demote the incumbent published version to `superseded`;
   *   3. promote the target to `published`.
   *
   * Step 2 MUST precede step 3: `uq_recipe_single_published` is a partial
   * unique index and is not deferrable, so promoting first would raise a unique
   * violation. Supersession never deletes (FR-MNU-045).
   *
   * `effective_from` is not read anywhere in this method.
   */
  async publish(
    tenantId: string,
    actorId: string,
    recipeId: string,
    versionNo: number,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const target = await this.requireVersion(tx, recipeId, versionNo);
        if (target.status !== 'draft') {
          throw new ConflictException(
            `Only a draft version may be published; version ${versionNo} is ${target.status}.`,
          );
        }

        const incumbent = await tx.recipeVersion.findFirst({
          where: { recipeId, status: 'published' },
          select: { id: true, version: true },
        });
        if (incumbent) {
          // Demote FIRST — the partial unique index is not deferrable.
          await tx.recipeVersion.update({
            where: { id: incumbent.id },
            data: { status: 'superseded' },
          });
        }

        const published = await tx.recipeVersion.update({
          where: { id: target.id },
          data: { status: 'published' },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.RECIPE_VERSION_PUBLISHED,
          entityType: AUDIT_ENTITY.RECIPE_VERSION,
          entityId: published.id,
          actorType: 'user',
          actorId,
          metadata: {
            recipeId,
            version: versionNo,
            supersededVersionId: incumbent?.id ?? null,
            supersededVersion: incumbent?.version ?? null,
          },
        });

        return {
          published,
          supersededVersionId: incumbent?.id ?? null,
        };
      },
    );
  }

  /** FR-MNU-045 version history, newest first. */
  async list(tenantId: string, recipeId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      await this.requireRecipe(tx, recipeId);
      return tx.recipeVersion.findMany({
        where: { recipeId },
        orderBy: { version: 'desc' },
        include: { lines: { orderBy: { sequence: 'asc' } } },
      });
    });
  }

  /**
   * D-17-08 — the effective version for a recipe identity: the single row whose
   * status is `published`. No date participates. Returns null when none is
   * published; that is not an error and never falls back to draft or superseded.
   */
  async effectiveVersion(tenantId: string, recipeId: string) {
    const versions = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.recipeVersion.findMany({
        where: { recipeId },
        include: { lines: { orderBy: { sequence: 'asc' } } },
      }),
    );
    return selectPublishedVersion(versions);
  }
}
