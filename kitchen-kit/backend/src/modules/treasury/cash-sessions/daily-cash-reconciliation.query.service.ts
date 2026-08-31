import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  CashSessionWholeSessionFacts,
  DailyCashReconciliationQuery,
  DailyCashReconciliationQueryInput,
} from '../contract/daily-cash-reconciliation.query';

/**
 * PRIVATE Prisma-backed implementation of `DailyCashReconciliationQuery`
 * (`treasury/contract/daily-cash-reconciliation.query.ts`). Never imported
 * directly by another module — only through the
 * `DAILY_CASH_RECONCILIATION_QUERY` token `TreasuryModule` binds it to.
 *
 * Two statements, both bounded by the size of the CALLER-supplied
 * `cashSessionIds` set (never by branch/tenant-wide row counts): the
 * sessions themselves (`(tenant_id, branch_id, id)` unique target), and
 * their movement totals grouped by type (`(tenant_id, cash_session_id)`
 * index). `CashSessionCloseAttempt` and `cash_count_denominations` are
 * never queried.
 */
@Injectable()
export class DailyCashReconciliationQueryService implements DailyCashReconciliationQuery {
  async forSessions(
    tx: Prisma.TransactionClient,
    input: DailyCashReconciliationQueryInput,
  ): Promise<readonly CashSessionWholeSessionFacts[]> {
    const { tenantId, branchId, cashSessionIds } = input;
    if (cashSessionIds.length === 0) return [];

    const sessions = await tx.cashSession.findMany({
      where: { tenantId, branchId, id: { in: [...cashSessionIds] } },
      select: {
        id: true,
        employeeId: true,
        drawerId: true,
        openedAt: true,
        closedAt: true,
        status: true,
        currency: true,
        openingFloat: true,
        expectedCash: true,
        countedCash: true,
        variance: true,
      },
    });
    if (sessions.length === 0) return [];

    const resolvedIds = sessions.map((s) => s.id);
    const movementTotals = await tx.cashMovement.groupBy({
      by: ['cashSessionId', 'movementType'],
      where: { tenantId, cashSessionId: { in: resolvedIds } },
      _sum: { amount: true },
    });

    const movementsBySession = new Map<
      string,
      { payIn: bigint; payOut: bigint; safeDrop: bigint }
    >();
    for (const row of movementTotals) {
      let acc = movementsBySession.get(row.cashSessionId);
      if (!acc) {
        acc = { payIn: 0n, payOut: 0n, safeDrop: 0n };
        movementsBySession.set(row.cashSessionId, acc);
      }
      const amount = row._sum.amount ?? 0n;
      if (row.movementType === 'pay_in') acc.payIn += amount;
      else if (row.movementType === 'pay_out') acc.payOut += amount;
      else if (row.movementType === 'safe_drop') acc.safeDrop += amount;
    }

    return sessions.map((session) => {
      const movements = movementsBySession.get(session.id);
      return {
        cashSessionId: session.id,
        employeeId: session.employeeId,
        drawerId: session.drawerId,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        status: session.status,
        currency: session.currency,
        openingFloat: session.openingFloat,
        expectedCash: session.expectedCash,
        countedCash: session.countedCash,
        variance: session.variance,
        payInTotal: movements?.payIn ?? 0n,
        payOutTotal: movements?.payOut ?? 0n,
        safeDropTotal: movements?.safeDrop ?? 0n,
      };
    });
  }
}
