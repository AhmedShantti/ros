import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { WarehouseType } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { LocationsService } from '../locations/locations.service';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import { WarehouseSummary, toWarehouseSummary } from './warehouse.view';

const NAME_CONFLICT =
  'A warehouse with this name already exists in the tenant.';
const BRANCH_NOT_FOUND = 'Branch not found.';

export interface CreateWarehouseInput {
  name: string;
  warehouseType?: WarehouseType;
  branchId?: string;
}

export type UpdateWarehouseInput = Partial<CreateWarehouseInput>;

/**
 * Warehouse administration. TENANT-owned (ADR 0008 D-08 — accepted deviation
 * from FR-PLT-001's hierarchy tree, on the weight of SRS §7.3 #6, the glossary,
 * BR-PLT-001 and FR-BRN-015). The optional branch link is protected by the
 * composite FK `(tenant_id, branch_id) → branches(tenant_id, id)`.
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly locations: LocationsService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    input: CreateWarehouseInput,
  ): Promise<WarehouseSummary> {
    try {
      const warehouse = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const created = await tx.warehouse.create({
            data: {
              id: newId(),
              tenantId,
              name: input.name,
              ...(input.warehouseType !== undefined
                ? { warehouseType: input.warehouseType }
                : {}),
              branchId: input.branchId ?? null,
            },
          });
          // P15-4: register in org.locations within the same transaction.
          await this.locations.register(tx, tenantId, 'warehouse', created.id);
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.WAREHOUSE_CREATED,
            entityType: AUDIT_ENTITY.WAREHOUSE,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: {
              name: created.name,
              warehouseType: created.warehouseType,
              branchId: created.branchId,
            },
          });
          return created;
        },
      );
      return toWarehouseSummary(warehouse);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, BRANCH_NOT_FOUND, NAME_CONFLICT);
    }
  }

  list(tenantId: string): Promise<WarehouseSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.warehouse.findMany({ orderBy: { createdAt: 'asc' } }),
      )
      .then((rows) => rows.map(toWarehouseSummary));
  }

  async findOne(tenantId: string, id: string): Promise<WarehouseSummary> {
    const warehouse = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.warehouse.findUnique({ where: { id } }),
    );
    if (!warehouse) {
      throw new NotFoundException('Warehouse not found.');
    }
    return toWarehouseSummary(warehouse);
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    input: UpdateWarehouseInput,
  ): Promise<WarehouseSummary> {
    try {
      const warehouse = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.warehouse.findUnique({ where: { id } });
          if (!existing) {
            throw new NotFoundException('Warehouse not found.');
          }
          const updated = await tx.warehouse.update({
            where: { id },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.warehouseType !== undefined
                ? { warehouseType: input.warehouseType }
                : {}),
              ...(input.branchId !== undefined
                ? { branchId: input.branchId }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.WAREHOUSE_UPDATED,
            entityType: AUDIT_ENTITY.WAREHOUSE,
            actorType: 'user',
            actorId,
            entityId: id,
            before: { name: existing.name, branchId: existing.branchId },
            metadata: { name: updated.name, branchId: updated.branchId },
          });
          return updated;
        },
      );
      return toWarehouseSummary(warehouse);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, BRANCH_NOT_FOUND, NAME_CONFLICT);
    }
  }
}
