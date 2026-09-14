import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import { BranchKdsConfigView } from './branch-kds-config.view';

const PARENT_NOT_FOUND = 'Branch or fallback station not found.';

/**
 * KDS-BRANCH-FALLBACK-STATION-P0 — `RoutingResolverService`'s tier-5 branch
 * fallback already reads `kitchen.branch_kds_config.fallback_station_id`
 * (via `RoutingConfigQueryService`), but nothing could ever WRITE it: no
 * controller route, no `.create`/`.update`/`.upsert` call site anywhere.
 * Every branch with no line/modifier/menu-item/category rule for a fired
 * item hit `RoutingNoDestinationError` unconditionally. This is the smallest
 * proper contract that closes the gap — admin-facing get/set of exactly the
 * one field this incident needs.
 *
 * Deliberately separate from `KdsBranchConfigQueryService`
 * (`routing-config/kds-branch-config.query.service.ts`): that one is a
 * PRIVATE, Kitchen-only contract for two unrelated facts on the same table
 * (`recallWindowSeconds`, `cancelledLineVisibilitySeconds`). This service
 * owns the HTTP-facing `fallbackStationId` read/write only.
 *
 * `branch_kds_config` has no separate "create" concept: `@id branchId` means
 * a branch has at most one config row, so `upsert` is the correct primitive
 * and repeat calls with the same value are naturally idempotent.
 */
@Injectable()
export class BranchKdsConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async find(
    tenantId: string,
    branchId: string,
  ): Promise<BranchKdsConfigView> {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      await assertBranch(tx, branchId);
      const config = await tx.branchKdsConfig.findUnique({
        where: { tenantId_branchId: { tenantId, branchId } },
        select: { fallbackStationId: true },
      });
      return { fallbackStationId: config?.fallbackStationId ?? null };
    });
  }

  async set(
    tenantId: string,
    actorId: string,
    branchId: string,
    fallbackStationId: string | null,
  ): Promise<BranchKdsConfigView> {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          await assertBranch(tx, branchId);
          const before = await tx.branchKdsConfig.findUnique({
            where: { tenantId_branchId: { tenantId, branchId } },
            select: { fallbackStationId: true },
          });

          // ADR 0008 D-16's own pattern (Station.displayTerminalId): the
          // composite FK — `[branchId, fallbackStationId]` referencing
          // Station's `@@unique([branchId, id])` — forces the station to be
          // in THIS branch, hence this tenant. Not validated by an
          // application check alone; `rethrowAsNotFoundOnFk` below maps its
          // violation to the same 404 a genuinely missing station gets.
          const updated = await tx.branchKdsConfig.upsert({
            where: { tenantId_branchId: { tenantId, branchId } },
            create: { branchId, tenantId, fallbackStationId },
            update: { fallbackStationId },
            select: { fallbackStationId: true },
          });

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRANCH_KDS_CONFIG_UPDATED,
            entityType: AUDIT_ENTITY.BRANCH_KDS_CONFIG,
            actorType: 'user',
            actorId,
            entityId: branchId,
            before: { fallbackStationId: before?.fallbackStationId ?? null },
            metadata: { fallbackStationId: updated.fallbackStationId },
          });

          return { fallbackStationId: updated.fallbackStationId };
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND);
    }
  }
}

async function assertBranch(
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
