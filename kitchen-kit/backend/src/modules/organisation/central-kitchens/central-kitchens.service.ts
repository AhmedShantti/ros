import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { LocationsService } from '../locations/locations.service';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import {
  CentralKitchenSummary,
  toCentralKitchenSummary,
} from './central-kitchen.view';

const WAREHOUSE_NOT_FOUND = 'Warehouse not found.';
// Two unique constraints can fire here: (tenant_id, name) and (warehouse_id).
const CONFLICT =
  'A central kitchen with this name, or one for this warehouse, already exists.';

export interface CreateCentralKitchenInput {
  name: string;
  warehouseId: string;
}

export type UpdateCentralKitchenInput = Partial<CreateCentralKitchenInput>;

/**
 * Central Kitchen administration. TENANT-owned (ADR 0008 D-08), bound to exactly
 * one warehouse — `@@unique([warehouseId])` per D-15, because the approved SQL's
 * NOT NULL warehouse_id implies 1:1 without enforcing it, and two kitchens on one
 * warehouse would make later stock attribution ambiguous.
 *
 * SRS §7.3 defines no Central Kitchen aggregate; it is treated as a root because
 * the approved SQL gives it its own tenant-scoped table.
 */
@Injectable()
export class CentralKitchensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly locations: LocationsService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    input: CreateCentralKitchenInput,
  ): Promise<CentralKitchenSummary> {
    try {
      const ck = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const created = await tx.centralKitchen.create({
            data: {
              id: newId(),
              tenantId,
              name: input.name,
              warehouseId: input.warehouseId,
            },
          });
          // P15-4: register in org.locations within the same transaction.
          await this.locations.register(
            tx,
            tenantId,
            'central_kitchen',
            created.id,
          );
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.CENTRAL_KITCHEN_CREATED,
            entityType: AUDIT_ENTITY.CENTRAL_KITCHEN,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: { name: created.name, warehouseId: created.warehouseId },
          });
          return created;
        },
      );
      return toCentralKitchenSummary(ck);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, WAREHOUSE_NOT_FOUND, CONFLICT);
    }
  }

  list(tenantId: string): Promise<CentralKitchenSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.centralKitchen.findMany({ orderBy: { name: 'asc' } }),
      )
      .then((rows) => rows.map(toCentralKitchenSummary));
  }

  async findOne(tenantId: string, id: string): Promise<CentralKitchenSummary> {
    const ck = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.centralKitchen.findUnique({ where: { id } }),
    );
    if (!ck) {
      throw new NotFoundException('Central kitchen not found.');
    }
    return toCentralKitchenSummary(ck);
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    input: UpdateCentralKitchenInput,
  ): Promise<CentralKitchenSummary> {
    try {
      const ck = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.centralKitchen.findUnique({
            where: { id },
          });
          if (!existing) {
            throw new NotFoundException('Central kitchen not found.');
          }
          const updated = await tx.centralKitchen.update({
            where: { id },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.warehouseId !== undefined
                ? { warehouseId: input.warehouseId }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.CENTRAL_KITCHEN_UPDATED,
            entityType: AUDIT_ENTITY.CENTRAL_KITCHEN,
            actorType: 'user',
            actorId,
            entityId: id,
            before: {
              name: existing.name,
              warehouseId: existing.warehouseId,
            },
            metadata: { name: updated.name, warehouseId: updated.warehouseId },
          });
          return updated;
        },
      );
      return toCentralKitchenSummary(ck);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, WAREHOUSE_NOT_FOUND, CONFLICT);
    }
  }
}
