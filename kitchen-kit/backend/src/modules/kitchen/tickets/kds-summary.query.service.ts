import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  KdsSummaryFacts,
  KdsSummaryQuery,
  KdsSummaryQueryInput,
} from '../contract/kds-summary.query';

/**
 * PRIVATE Prisma-backed implementation of `KdsSummaryQuery`
 * (`kitchen/contract/kds-summary.query.ts`). Bound to `KDS_SUMMARY_QUERY`
 * only inside `KitchenModule` (`useExisting`) — never imported directly by
 * a consumer.
 */
@Injectable()
export class KdsSummaryQueryService implements KdsSummaryQuery {
  async forBranch(
    tx: Prisma.TransactionClient,
    input: KdsSummaryQueryInput,
  ): Promise<KdsSummaryFacts> {
    const tickets = await tx.ticket.findMany({
      where: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        businessDay: input.businessDay,
      },
      select: { status: true, startedAt: true, bumpedAt: true },
    });

    const statusCounts: Record<string, number> = {};
    let durationSecondsSum = 0;
    let measuredPrepDurationCount = 0;
    for (const ticket of tickets) {
      statusCounts[ticket.status] = (statusCounts[ticket.status] ?? 0) + 1;
      if (ticket.startedAt && ticket.bumpedAt) {
        durationSecondsSum +=
          (ticket.bumpedAt.getTime() - ticket.startedAt.getTime()) / 1000;
        measuredPrepDurationCount += 1;
      }
    }

    return {
      ticketCount: tickets.length,
      statusCounts,
      measuredPrepDurationCount,
      averagePrepDurationSeconds:
        measuredPrepDurationCount === 0
          ? null
          : Math.round((durationSecondsSum / measuredPrepDurationCount) * 10) /
            10,
    };
  }
}
