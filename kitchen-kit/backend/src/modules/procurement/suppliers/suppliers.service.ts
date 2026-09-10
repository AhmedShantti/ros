import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { currencyOf, CurrencyError } from '../../../common/money/currency';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import type {
  CreateSupplierDto,
  SetSupplierStatusDto,
  UpdateSupplierDto,
} from '../procurement.dto';
import { rethrowAsConflict } from '../procurement-errors';

/**
 * FR-PRC-005 [M] — Supplier master.
 *
 * Never hard-deletes a supplier (mission brief §2): there is no `delete`
 * method here, and the migration's own `ros_app` grant carries no DELETE
 * privilege on `procurement.suppliers` — deactivation is the ONLY lifecycle
 * change, via `setStatus`.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertCurrency(code: string): void {
    try {
      currencyOf(code);
    } catch (err) {
      if (err instanceof CurrencyError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  async create(tenantId: string, actorId: string, input: CreateSupplierDto) {
    this.assertCurrency(input.currency);
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const supplier = await tx.supplier.create({
            data: {
              id: newId(),
              tenantId,
              code: input.code,
              legalName: input.legalName,
              tradingName: input.tradingName ?? null,
              taxRegistrationNumber: input.taxRegistrationNumber ?? null,
              addresses: (input.addresses ??
                []) as unknown as Prisma.InputJsonValue,
              contacts: (input.contacts ??
                []) as unknown as Prisma.InputJsonValue,
              paymentTermsNetDays: input.paymentTermsNetDays,
              currency: input.currency,
              deliveryLeadTimeDays: input.deliveryLeadTimeDays,
              minimumOrderValue: BigInt(input.minimumOrderValue),
              deliveryDays: input.deliveryDays ?? [],
            },
          });

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.SUPPLIER_CREATED,
            entityType: AUDIT_ENTITY.SUPPLIER,
            actorType: 'user',
            actorId,
            entityId: supplier.id,
            metadata: { code: supplier.code, currency: supplier.currency },
          });

          return supplier;
        },
      );
    } catch (err) {
      rethrowAsConflict(
        err,
        `Supplier code "${input.code}" is already in use for this tenant.`,
      );
    }
  }

  async findById(tenantId: string, actorId: string, id: string) {
    return this.prisma.withAuthContext({ userId: actorId, tenantId }, (tx) =>
      tx.supplier.findUnique({ where: { id } }),
    );
  }

  async findAll(
    tenantId: string,
    actorId: string,
    filter?: { status?: 'active' | 'inactive' },
  ) {
    return this.prisma.withAuthContext({ userId: actorId, tenantId }, (tx) =>
      tx.supplier.findMany({
        where: filter?.status ? { status: filter.status } : undefined,
        orderBy: { code: 'asc' },
      }),
    );
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    input: UpdateSupplierDto,
  ) {
    if (input.currency) this.assertCurrency(input.currency);
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.supplier.findUnique({ where: { id } });
          if (!existing) throw new NotFoundException('Supplier not found.');

          const updated = await tx.supplier.update({
            where: { id },
            data: {
              code: input.code,
              legalName: input.legalName,
              tradingName: input.tradingName,
              taxRegistrationNumber: input.taxRegistrationNumber,
              addresses:
                input.addresses !== undefined
                  ? (input.addresses as unknown as Prisma.InputJsonValue)
                  : undefined,
              contacts:
                input.contacts !== undefined
                  ? (input.contacts as unknown as Prisma.InputJsonValue)
                  : undefined,
              paymentTermsNetDays: input.paymentTermsNetDays,
              currency: input.currency,
              deliveryLeadTimeDays: input.deliveryLeadTimeDays,
              minimumOrderValue:
                input.minimumOrderValue !== undefined
                  ? BigInt(input.minimumOrderValue)
                  : undefined,
              deliveryDays: input.deliveryDays,
            },
          });

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.SUPPLIER_UPDATED,
            entityType: AUDIT_ENTITY.SUPPLIER,
            actorType: 'user',
            actorId,
            entityId: updated.id,
            metadata: { code: updated.code },
          });

          return updated;
        },
      );
    } catch (err) {
      rethrowAsConflict(
        err,
        `Supplier code "${input.code}" is already in use for this tenant.`,
      );
    }
  }

  async setStatus(
    tenantId: string,
    actorId: string,
    id: string,
    input: SetSupplierStatusDto,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.supplier.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Supplier not found.');

        const updated = await tx.supplier.update({
          where: { id },
          data: { status: input.status },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.SUPPLIER_STATUS_CHANGED,
          entityType: AUDIT_ENTITY.SUPPLIER,
          actorType: 'user',
          actorId,
          entityId: updated.id,
          metadata: { from: existing.status, to: updated.status },
        });

        return updated;
      },
    );
  }
}
