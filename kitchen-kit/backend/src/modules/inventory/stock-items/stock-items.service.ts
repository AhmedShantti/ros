import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  BatchStrategy,
  CostingMethod,
  Prisma,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { defaultBatchStrategy } from '../costing';

const SKU_CONFLICT = 'A stock item with this SKU already exists in the tenant.';
const PARENT_NOT_FOUND = 'Unit, category or location not found.';

export interface CreateStockItemInput {
  sku: string;
  names: Record<string, unknown>;
  baseUnitId: string;
  recipeUnitId?: string;
  categoryId?: string;
  costingMethod?: CostingMethod;
  standardCost?: string;
  isBatchTracked?: boolean;
  expiryTracked?: boolean;
  shelfLifeDays?: number;
  batchStrategy?: BatchStrategy;
  storageRequirements?: Record<string, unknown>;
}

/**
 * Stock item master (FR-INV-001) — the STOCKABLE item, distinct from Catalogue's
 * sellable item (SRS §5.3 ubiquitous language).
 *
 * D-INV-04: `expiryTracked` and `shelfLifeDays` exist because FR-INV-021 and
 * FR-INV-023 cannot operate without them. Reorder configuration is PER LOCATION
 * (FR-INV-065), not on the item.
 *
 * FR-INV-002: the base unit is immutable once any movement exists — enforced
 * here, because the condition depends on ledger state and cannot be a CHECK.
 */
@Injectable()
export class StockItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(tenantId: string, actorId: string, input: CreateStockItemInput) {
    try {
      const item = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const expiryTracked = input.expiryTracked ?? false;
          const created = await tx.stockItem.create({
            data: {
              id: newId(),
              tenantId,
              sku: input.sku,
              names: input.names as Prisma.InputJsonValue,
              baseUnitId: input.baseUnitId,
              recipeUnitId: input.recipeUnitId ?? null,
              categoryId: input.categoryId ?? null,
              ...(input.costingMethod !== undefined
                ? { costingMethod: input.costingMethod }
                : {}),
              standardCost:
                input.standardCost !== undefined
                  ? BigInt(input.standardCost)
                  : null,
              ...(input.isBatchTracked !== undefined
                ? { isBatchTracked: input.isBatchTracked }
                : {}),
              expiryTracked,
              shelfLifeDays: input.shelfLifeDays ?? null,
              // FR-INV-023: FEFO defaults for expiry-tracked items unless the
              // caller states otherwise. Selection only — never costing.
              batchStrategy:
                input.batchStrategy ?? defaultBatchStrategy(expiryTracked),
              ...(input.storageRequirements !== undefined
                ? {
                    storageRequirements:
                      input.storageRequirements as Prisma.InputJsonValue,
                  }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.STOCK_ITEM_CREATED,
            entityType: AUDIT_ENTITY.STOCK_ITEM,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: {
              sku: created.sku,
              costingMethod: created.costingMethod,
              batchStrategy: created.batchStrategy,
            },
          });
          return created;
        },
      );
      return this.view(item);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND, SKU_CONFLICT);
    }
  }

  list(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.stockItem.findMany({ orderBy: { sku: 'asc' } }),
      )
      .then((rows) => rows.map((r) => this.view(r)));
  }

  async findOne(tenantId: string, id: string) {
    const item = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.stockItem.findUnique({ where: { id } }),
    );
    if (!item) throw new NotFoundException('Stock item not found.');
    return this.view(item);
  }

  /** FR-INV-002: base unit immutable once a movement exists. */
  async changeBaseUnit(
    tenantId: string,
    actorId: string,
    id: string,
    baseUnitId: string,
  ) {
    const item = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.stockItem.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Stock item not found.');
        const movements = await tx.stockMovement.count({
          where: { stockItemId: id },
        });
        if (movements > 0) {
          throw new ConflictException(
            'Base unit is immutable once stock movements exist (FR-INV-002).',
          );
        }
        const updated = await tx.stockItem.update({
          where: { id },
          data: { baseUnitId },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.STOCK_ITEM_UPDATED,
          entityType: AUDIT_ENTITY.STOCK_ITEM,
          actorType: 'user',
          actorId,
          entityId: id,
          before: { baseUnitId: existing.baseUnitId },
          metadata: { baseUnitId: updated.baseUnitId },
        });
        return updated;
      },
    );
    return this.view(item);
  }

  /** D-INV-04 / FR-INV-065: reorder configuration is per (item, location). */
  async setReorderConfig(
    tenantId: string,
    actorId: string,
    stockItemId: string,
    locationId: string,
    reorderPoint: string,
    reorderQuantity: string,
  ) {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.stockItemReorderConfig.findUnique({
            where: {
              tenantId_stockItemId_locationId: {
                tenantId,
                stockItemId,
                locationId,
              },
            },
          });
          const saved = existing
            ? await tx.stockItemReorderConfig.update({
                where: { id: existing.id },
                data: { reorderPoint, reorderQuantity },
              })
            : await tx.stockItemReorderConfig.create({
                data: {
                  id: newId(),
                  tenantId,
                  stockItemId,
                  locationId,
                  reorderPoint,
                  reorderQuantity,
                },
              });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.REORDER_CONFIG_SET,
            entityType: AUDIT_ENTITY.REORDER_CONFIG,
            actorType: 'user',
            actorId,
            entityId: saved.id,
            metadata: { stockItemId, locationId },
          });
          return {
            id: saved.id,
            stockItemId: saved.stockItemId,
            locationId: saved.locationId,
            reorderPoint: saved.reorderPoint?.toString() ?? null,
            reorderQuantity: saved.reorderQuantity?.toString() ?? null,
          };
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND);
    }
  }

  /** FR-INV-057: tenant reason-code taxonomy. */
  async createReasonCode(
    tenantId: string,
    actorId: string,
    category: string,
    code: string,
    label: Record<string, unknown>,
  ) {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const created = await tx.reasonCode.create({
            data: {
              id: newId(),
              tenantId,
              category,
              code,
              label: label as Prisma.InputJsonValue,
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.REASON_CODE_CREATED,
            entityType: AUDIT_ENTITY.REASON_CODE,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: { category, code },
          });
          return { id: created.id, category, code, label: created.label };
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(
        err,
        'Reason code parent not found.',
        'A reason code with this category and code already exists.',
      );
    }
  }

  listReasonCodes(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.reasonCode.findMany({
          orderBy: [{ category: 'asc' }, { code: 'asc' }],
        }),
      )
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          category: r.category,
          code: r.code,
          label: r.label,
        })),
      );
  }

  private view(i: {
    id: string;
    sku: string;
    names: unknown;
    categoryId: string | null;
    baseUnitId: string;
    recipeUnitId: string | null;
    costingMethod: CostingMethod;
    standardCost: bigint | null;
    isBatchTracked: boolean;
    expiryTracked: boolean;
    shelfLifeDays: number | null;
    batchStrategy: BatchStrategy;
    isActive: boolean;
  }) {
    return {
      id: i.id,
      sku: i.sku,
      names: i.names,
      categoryId: i.categoryId,
      baseUnitId: i.baseUnitId,
      recipeUnitId: i.recipeUnitId,
      costingMethod: i.costingMethod,
      standardCost: i.standardCost?.toString() ?? null,
      isBatchTracked: i.isBatchTracked,
      expiryTracked: i.expiryTracked,
      shelfLifeDays: i.shelfLifeDays,
      batchStrategy: i.batchStrategy,
      isActive: i.isActive,
    };
  }
}
