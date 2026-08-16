import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { rethrowAsConflict } from '../prisma-errors';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { BrandSummary, toBrandSummary } from './brand.view';

/** (tenant_id, name) is unique per ADR 0008 D-15 → 409 on collision. */
const CONFLICT_MESSAGE = 'A brand with this name already exists in the tenant.';

export interface CreateBrandInput {
  name: string;
  theme?: Record<string, unknown>;
  defaultSettings?: Record<string, unknown>;
}

export type UpdateBrandInput = Partial<CreateBrandInput>;

/**
 * Brand administration (SRS §7.3 #4 — aggregate root, belongs to one tenant).
 * Every query runs under the acting tenant's RLS context, so a brand is only
 * ever visible/mutable within its own tenant; the database is the final
 * boundary. Audit entries are written with `record()` inside the same
 * transaction, so an audit failure rolls the mutation back (ADR 0008 §15).
 */
@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    input: CreateBrandInput,
  ): Promise<BrandSummary> {
    try {
      const brand = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const created = await tx.brand.create({
            data: {
              id: newId(),
              tenantId,
              name: input.name,
              ...(input.theme !== undefined
                ? { theme: input.theme as Prisma.InputJsonValue }
                : {}),
              ...(input.defaultSettings !== undefined
                ? {
                    defaultSettings:
                      input.defaultSettings as Prisma.InputJsonValue,
                  }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRAND_CREATED,
            entityType: AUDIT_ENTITY.BRAND,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: { name: created.name },
          });
          return created;
        },
      );
      return toBrandSummary(brand);
    } catch (err) {
      rethrowAsConflict(err, CONFLICT_MESSAGE);
    }
  }

  list(tenantId: string): Promise<BrandSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.brand.findMany({ orderBy: { createdAt: 'asc' } }),
      )
      .then((brands) => brands.map(toBrandSummary));
  }

  async findOne(tenantId: string, brandId: string): Promise<BrandSummary> {
    const brand = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.brand.findUnique({ where: { id: brandId } }),
    );
    if (!brand) {
      // Cross-tenant brands are invisible under RLS → 404, never 403, so a
      // foreign id cannot be probed for existence.
      throw new NotFoundException('Brand not found.');
    }
    return toBrandSummary(brand);
  }

  async update(
    tenantId: string,
    actorId: string,
    brandId: string,
    input: UpdateBrandInput,
  ): Promise<BrandSummary> {
    try {
      const brand = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.brand.findUnique({
            where: { id: brandId },
          });
          if (!existing) {
            throw new NotFoundException('Brand not found.');
          }
          const updated = await tx.brand.update({
            where: { id: brandId },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.theme !== undefined
                ? { theme: input.theme as Prisma.InputJsonValue }
                : {}),
              ...(input.defaultSettings !== undefined
                ? {
                    defaultSettings:
                      input.defaultSettings as Prisma.InputJsonValue,
                  }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRAND_UPDATED,
            entityType: AUDIT_ENTITY.BRAND,
            actorType: 'user',
            actorId,
            entityId: brandId,
            before: { name: existing.name },
            metadata: { name: updated.name },
          });
          return updated;
        },
      );
      return toBrandSummary(brand);
    } catch (err) {
      rethrowAsConflict(err, CONFLICT_MESSAGE);
    }
  }
}
