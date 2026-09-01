import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  DayCloseStateQuery,
  DayCloseStateQueryInput,
} from '../contract/day-close-state.query';

/**
 * PRIVATE Prisma-backed implementation of `DayCloseStateQuery`
 * (`treasury/contract/day-close-state.query.ts`). Never imported directly
 * by another module — only through the `DAY_CLOSE_STATE_QUERY` token
 * `TreasuryModule` binds it to. A single indexed lookup on `day_closes`'
 * own `uq_day_closes_branch_business_day` unique target — no new index.
 */
@Injectable()
export class DayCloseStateQueryService implements DayCloseStateQuery {
  async isClosed(
    tx: Prisma.TransactionClient,
    input: DayCloseStateQueryInput,
  ): Promise<boolean> {
    const existing = await tx.dayClose.findUnique({
      where: {
        tenantId_branchId_businessDay: {
          tenantId: input.tenantId,
          branchId: input.branchId,
          businessDay: input.businessDay,
        },
      },
      select: { id: true },
    });
    return existing !== null;
  }
}
