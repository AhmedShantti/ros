import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  DAILY_TRADING_SALES_QUERY,
  type DailyTradingSalesQuery,
} from '../contract/daily-trading-sales.query';
import type {
  DayCloseOrderTypeAggregate,
  DayCloseSalesFacts,
  DayCloseSalesFactsQuery,
  DayCloseSalesFactsQueryInput,
  DayCloseVoidSummary,
} from '../contract/day-close-sales-facts.query';

/** `orders.state` values that keep an order open for further change — the
 *  SAME set `DailyTradingSalesQueryService` already uses, verbatim. */
const OPEN_ORDER_STATES = [
  'draft',
  'open',
  'held',
  'parked',
  'partially_paid',
] as const;

/**
 * PRIVATE Prisma-backed implementation of `DayCloseSalesFactsQuery`
 * (`sales/contract/day-close-sales-facts.query.ts`). Never imported
 * directly by another module — only through the
 * `DAY_CLOSE_SALES_FACTS_QUERY` token `SalesModule` binds it to.
 *
 * Delegates every ratified figure to `DAILY_TRADING_SALES_QUERY.facts()` —
 * no second gross/net/tender/tax algorithm is written here. Adds exactly
 * two additional statements: (1) the day's orders again, projected onto
 * `openOrderIds`/`salesByOrderType` (a lighter select than the delegated
 * call's own order read — no N+1, bounded at one extra statement); (2) the
 * completed population's pre-fire void lines.
 */
@Injectable()
export class DayCloseSalesFactsQueryService implements DayCloseSalesFactsQuery {
  constructor(
    @Inject(DAILY_TRADING_SALES_QUERY)
    private readonly dailyTrading: DailyTradingSalesQuery,
  ) {}

  async facts(
    tx: Prisma.TransactionClient,
    input: DayCloseSalesFactsQueryInput,
  ): Promise<DayCloseSalesFacts> {
    const { tenantId, branchId, businessDay } = input;

    const base = await this.dailyTrading.facts(tx, {
      tenantId,
      branchId,
      businessDay,
    });

    // ── openOrderIds / salesByOrderType — one lighter order-id/type select ──
    const orders = await tx.order.findMany({
      where: { tenantId, branchId, businessDay },
      select: {
        id: true,
        state: true,
        orderType: true,
        grandTotal: true,
        taxTotal: true,
      },
    });

    const openStateSet: ReadonlySet<string> = new Set(OPEN_ORDER_STATES);
    const openOrderIds: string[] = [];
    const completedOrderIds: string[] = [];
    interface TypeAcc {
      grossSales: bigint;
      netSales: bigint;
      orderCount: number;
    }
    const byType = new Map<string, TypeAcc>();

    for (const order of orders) {
      if (order.state === 'completed') {
        completedOrderIds.push(order.id);
        let acc = byType.get(order.orderType);
        if (!acc) {
          acc = { grossSales: 0n, netSales: 0n, orderCount: 0 };
          byType.set(order.orderType, acc);
        }
        acc.grossSales += order.grandTotal;
        // discounts/refunds are structurally 0n at this HEAD (DC-R1 clause 3).
        acc.netSales += order.grandTotal - order.taxTotal;
        acc.orderCount += 1;
      } else if (openStateSet.has(order.state)) {
        openOrderIds.push(order.id);
      }
    }
    const salesByOrderType: DayCloseOrderTypeAggregate[] = [
      ...byType.entries(),
    ].map(([orderType, acc]) => ({ orderType, ...acc }));

    // ── voidSummary — pre-fire voids on the SAME completed population ──────
    const voidSummary: DayCloseVoidSummary =
      completedOrderIds.length === 0
        ? { voidedLineCount: 0, voidedLineValueMinorUnits: 0n }
        : await (async () => {
            const agg = await tx.orderLine.aggregate({
              where: {
                tenantId,
                businessDay,
                orderId: { in: completedOrderIds },
                state: 'voided',
              },
              _sum: { lineTotal: true },
              _count: { _all: true },
            });
            return {
              voidedLineCount: agg._count._all,
              voidedLineValueMinorUnits: agg._sum.lineTotal ?? 0n,
            };
          })();

    return {
      ...base,
      openOrderIds,
      salesByOrderType,
      voidSummary,
    };
  }
}
