import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { BranchStatus, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { LocationsService } from '../locations/locations.service';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import { BranchSummary, toBranchSummary } from './branch.view';

const CODE_CONFLICT = 'A branch with this code already exists in the tenant.';
const BRAND_NOT_FOUND = 'Brand not found.';

export interface CreateBranchInput {
  brandId: string;
  code: string;
  name: string;
  timezone: string;
  baseCurrency: string;
  countryCode: string;
  address?: Record<string, unknown>;
  automaticAvailability?: boolean;
}

export interface UpdateBranchInput {
  name?: string;
  timezone?: string;
  baseCurrency?: string;
  countryCode?: string;
  address?: Record<string, unknown>;
  automaticAvailability?: boolean;
}

/**
 * Branch administration (SRS §7.3 #5 — aggregate root containing OperatingHours,
 * Tables and PrintRouting).
 *
 * Tenant safety is enforced at three layers: the tenant comes only from the
 * validated TenantContext; RLS hides other tenants' rows; and the composite FK
 * `(tenant_id, brand_id) → brands(tenant_id, id)` makes a branch pointing at
 * another tenant's brand structurally impossible (ADR 0008 D-09) — PostgreSQL
 * evaluates FK checks with row security disabled, so the FK is the only thing
 * that can enforce that edge.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly locations: LocationsService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    input: CreateBranchInput,
  ): Promise<BranchSummary> {
    try {
      const branch = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const created = await tx.branch.create({
            data: {
              id: newId(),
              tenantId,
              brandId: input.brandId,
              code: input.code,
              name: input.name,
              timezone: input.timezone,
              baseCurrency: input.baseCurrency,
              countryCode: input.countryCode,
              ...(input.address !== undefined
                ? { address: input.address as Prisma.InputJsonValue }
                : {}),
              ...(input.automaticAvailability !== undefined
                ? { automaticAvailability: input.automaticAvailability }
                : {}),
            },
          });
          // P15-4: register the branch in org.locations inside the SAME
          // transaction, so a branch can never exist without its location row
          // (the identity Inventory will FK against).
          await this.locations.register(tx, tenantId, 'branch', created.id);
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRANCH_CREATED,
            entityType: AUDIT_ENTITY.BRANCH,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: {
              code: created.code,
              name: created.name,
              brandId: created.brandId,
            },
          });
          return created;
        },
      );
      return toBranchSummary(branch);
    } catch (err) {
      // P2003 here means the brand is not in this tenant (or does not exist) —
      // 404 either way, so a foreign brand id is indistinguishable from a
      // missing one.
      rethrowAsNotFoundOnFk(err, BRAND_NOT_FOUND, CODE_CONFLICT);
    }
  }

  list(tenantId: string): Promise<BranchSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.branch.findMany({ orderBy: { createdAt: 'asc' } }),
      )
      .then((branches) => branches.map(toBranchSummary));
  }

  async findOne(tenantId: string, branchId: string): Promise<BranchSummary> {
    const branch = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.branch.findUnique({ where: { id: branchId } }),
    );
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }
    return toBranchSummary(branch);
  }

  async update(
    tenantId: string,
    actorId: string,
    branchId: string,
    input: UpdateBranchInput,
  ): Promise<BranchSummary> {
    const branch = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.branch.findUnique({
          where: { id: branchId },
        });
        if (!existing) {
          throw new NotFoundException('Branch not found.');
        }
        const updated = await tx.branch.update({
          where: { id: branchId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.timezone !== undefined
              ? { timezone: input.timezone }
              : {}),
            ...(input.baseCurrency !== undefined
              ? { baseCurrency: input.baseCurrency }
              : {}),
            ...(input.countryCode !== undefined
              ? { countryCode: input.countryCode }
              : {}),
            ...(input.address !== undefined
              ? { address: input.address as Prisma.InputJsonValue }
              : {}),
            ...(input.automaticAvailability !== undefined
              ? { automaticAvailability: input.automaticAvailability }
              : {}),
          },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.BRANCH_UPDATED,
          entityType: AUDIT_ENTITY.BRANCH,
          actorType: 'user',
          actorId,
          entityId: branchId,
          before: { name: existing.name, timezone: existing.timezone },
          metadata: { name: updated.name, timezone: updated.timezone },
        });
        return updated;
      },
    );
    return toBranchSummary(branch);
  }

  /** ADR 0008 D-03: explicit status change, audited; not a generic PATCH field. */
  async setStatus(
    tenantId: string,
    actorId: string,
    branchId: string,
    status: BranchStatus,
  ): Promise<BranchSummary> {
    const branch = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.branch.findUnique({
          where: { id: branchId },
        });
        if (!existing) {
          throw new NotFoundException('Branch not found.');
        }
        const updated = await tx.branch.update({
          where: { id: branchId },
          data: { status },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.BRANCH_STATUS_CHANGED,
          entityType: AUDIT_ENTITY.BRANCH,
          actorType: 'user',
          actorId,
          entityId: branchId,
          before: { status: existing.status },
          metadata: { status: updated.status },
        });
        return updated;
      },
    );
    return toBranchSummary(branch);
  }

  /**
   * Reassign a branch to another brand **within the same tenant**
   * (FR-PLT-004 [S], ADR 0008 D-13). A dedicated operation rather than a PATCH
   * field, so the audit entry names the action rather than burying it in a diff.
   *
   * `code` is never touched — FR-POS-002 embeds it in offline-generated order
   * numbers, so changing it would make historical order numbers ambiguous.
   * A cross-tenant target brand is rejected by the composite FK, not by an
   * application check.
   */
  async reassignBrand(
    tenantId: string,
    actorId: string,
    branchId: string,
    brandId: string,
  ): Promise<BranchSummary> {
    try {
      const branch = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.branch.findUnique({
            where: { id: branchId },
          });
          if (!existing) {
            throw new NotFoundException('Branch not found.');
          }
          const updated = await tx.branch.update({
            where: { id: branchId },
            data: { brandId },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRANCH_BRAND_REASSIGNED,
            entityType: AUDIT_ENTITY.BRANCH,
            actorType: 'user',
            actorId,
            entityId: branchId,
            before: { brandId: existing.brandId },
            metadata: { brandId: updated.brandId, code: updated.code },
          });
          return updated;
        },
      );
      return toBranchSummary(branch);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, BRAND_NOT_FOUND);
    }
  }

  /**
   * Resolve a branch id within the acting tenant, for services that own
   * branch-scoped children. Returns 404 for a foreign/missing branch so child
   * endpoints cannot be used to probe branch existence across tenants.
   */
  async assertBranchInTenant(
    tx: Prisma.TransactionClient,
    branchId: string,
  ): Promise<void> {
    const branch = await tx.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }
  }
}
