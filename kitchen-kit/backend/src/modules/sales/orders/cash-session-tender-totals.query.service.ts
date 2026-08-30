import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  CashSessionTenderTotals,
  CashSessionTenderTotalsQuery,
} from '../contract';

/**
 * PRIVATE Prisma-backed implementation of `CashSessionTenderTotalsQuery`
 * (P1G-1 migration 34). Never imported directly by another module — only
 * through the `CASH_SESSION_TENDER_TOTALS_QUERY` token `SalesModule` binds
 * it to, mirroring `CashSessionFactsQueryService`'s own module-boundary
 * discipline in Treasury.
 *
 * Groups the immutable `order_payments` ledger by tender — no maintained
 * projection, nothing computed or stored here, exactly the
 * `CashMovementTotalsQueryService` precedent.
 */
@Injectable()
export class CashSessionTenderTotalsQueryService
  implements CashSessionTenderTotalsQuery
{
  async totalsForSession(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cashSessionId: string,
  ): Promise<CashSessionTenderTotals> {
    const grouped = await tx.orderPayment.groupBy({
      by: ['tender'],
      where: { tenantId, cashSessionId },
      _sum: { amount: true, roundingAdjustment: true },
      _count: { _all: true },
    });

    const forTender = (tender: 'cash' | 'manual_external_card') =>
      grouped.find((g) => g.tender === tender);

    const cash = forTender('cash');
    const manualExternalCard = forTender('manual_external_card');
    const paymentCount = grouped.reduce((sum, g) => sum + g._count._all, 0);

    return {
      cashSessionId,
      cashSalesTotal: cash?._sum.amount ?? 0n,
      cashRoundingAdjustments: cash?._sum.roundingAdjustment ?? 0n,
      manualExternalCardTotal: manualExternalCard?._sum.amount ?? 0n,
      paymentCount,
    };
  }
}
