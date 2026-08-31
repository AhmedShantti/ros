import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  KdsBranchConfigQuery,
  KdsBranchConfigQueryInput,
  KdsBranchConfigResult,
} from '../contract/kds-branch-config.query';

/** `branch_kds_config.recall_window_seconds`' own schema `@default(1800)` —
 *  applied here, not invented, for the "no row configured yet" case
 *  (`schema.prisma`, `BranchKdsConfig.recallWindowSeconds`). */
const DEFAULT_RECALL_WINDOW_SECONDS = 1800;

/**
 * PRIVATE Organisation implementation of `KdsBranchConfigQuery`. Queries
 * `kitchen.branch_kds_config` directly — legal here for the same reason
 * `RoutingConfigQueryService` may (ADR 0008 D-06/D-07: Organisation owns this
 * configuration regardless of which Postgres schema physically stores it).
 */
@Injectable()
export class KdsBranchConfigQueryService implements KdsBranchConfigQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: KdsBranchConfigQueryInput,
  ): Promise<KdsBranchConfigResult> {
    const config = await tx.branchKdsConfig.findUnique({
      where: {
        tenantId_branchId: {
          tenantId: input.tenantId,
          branchId: input.branchId,
        },
      },
      select: {
        recallWindowSeconds: true,
        cancelledLineVisibilitySeconds: true,
      },
    });
    return {
      recallWindowSeconds:
        config?.recallWindowSeconds ?? DEFAULT_RECALL_WINDOW_SECONDS,
      cancelledLineVisibilitySeconds:
        config?.cancelledLineVisibilitySeconds ?? null,
    };
  }
}
