import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type { CashMovementTotals, CashMovementTotalsQuery } from '../contract';

/**
 * PRIVATE Prisma-backed implementation of `CashMovementTotalsQuery` (P1G-0).
 *
 * Never imported directly by another module — only through the
 * `CASH_MOVEMENT_TOTALS_QUERY` token `TreasuryModule` binds it to, mirroring
 * `CashSessionFactsQueryService`'s own module-boundary discipline.
 *
 * Groups the immutable `cash_movements` ledger by type — no maintained
 * projection, no `expected_cash` computed or stored here (design gate §6).
 */
@Injectable()
export class CashMovementTotalsQueryService implements CashMovementTotalsQuery {
  async totalsForSession(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cashSessionId: string,
  ): Promise<CashMovementTotals> {
    const grouped = await tx.cashMovement.groupBy({
      by: ['movementType'],
      where: { tenantId, cashSessionId },
      _sum: { amount: true },
    });

    const totalFor = (type: 'pay_in' | 'pay_out' | 'safe_drop'): bigint =>
      grouped.find((g) => g.movementType === type)?._sum.amount ?? 0n;

    const payInTotal = totalFor('pay_in');
    const payOutTotal = totalFor('pay_out');
    const safeDropTotal = totalFor('safe_drop');

    return {
      cashSessionId,
      payInTotal,
      payOutTotal,
      safeDropTotal,
      netCashMovementEffect: payInTotal - payOutTotal - safeDropTotal,
    };
  }
}
