import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  CurrentBusinessDayInput,
  DailySessionTenderTotals,
  DailyTaxClassAggregate,
  DailyTradingSalesFacts,
  DailyTradingSalesQuery,
  DailyTradingSalesQueryInput,
} from '../contract/daily-trading-sales.query';
import { cutoverLookup, resolveBusinessDay } from './business-day';

/** `orders.state` values that keep an order open for further change (§12/§28). */
const OPEN_ORDER_STATES = [
  'draft',
  'open',
  'held',
  'parked',
  'partially_paid',
] as const;

/**
 * PRIVATE Prisma-backed implementation of `DailyTradingSalesQuery`
 * (`sales/contract/daily-trading-sales.query.ts`). Never imported directly
 * by another module — only through the `DAILY_TRADING_SALES_QUERY` token
 * `SalesModule` binds it to.
 *
 * Every query below is ORDERS-FIRST: `sales.order_payments` and
 * `sales.order_lines` are filtered by an order-id set already resolved from
 * `sales.orders` (indexed on `(tenant_id, branch_id, business_day)`), never
 * by a bare `(tenant_id, branch_id, business_day)` predicate against
 * `order_payments`/`order_lines` directly — neither carries that index, and
 * none is added (no migration authorised). This mirrors the accepted
 * `EXPLAIN` evidence in the design acceptance correction §15.
 *
 * Query count for `facts()` is bounded at four statements regardless of how
 * many orders/lines/payments/sessions exist that day (no N+1): (1) the
 * day's orders, (2) the day's branch-inclusive payments joined via the
 * order-id set, (3) the contributing sessions' FULL payment history (for
 * `businessDayCount`), (4) the completed orders' tax lines.
 *
 * `completedExcessCapturedTotal` (acceptance correction, 2026-08-31) is
 * derived from the SAME step-(1) order rows already loaded for
 * `grossSales` — no new statement, no new query shape.
 */
@Injectable()
export class DailyTradingSalesQueryService implements DailyTradingSalesQuery {
  async currentBusinessDay(
    tx: Prisma.TransactionClient,
    input: CurrentBusinessDayInput,
  ): Promise<Date> {
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
      select: {
        timezone: true,
        operatingHours: {
          select: { dayOfWeek: true, businessDayCutover: true },
        },
      },
    });
    // Unreachable in practice: the caller (Reporting) has already resolved
    // this exact branch as the tenant's single active branch, inside the
    // SAME RepeatableRead transaction, before calling this method.
    if (!branch) {
      throw new Error(
        'currentBusinessDay: branch not found — caller must validate branch existence first.',
      );
    }
    return resolveBusinessDay(
      new Date(),
      branch.timezone,
      cutoverLookup(branch.operatingHours),
    );
  }

  async facts(
    tx: Prisma.TransactionClient,
    input: DailyTradingSalesQueryInput,
  ): Promise<DailyTradingSalesFacts> {
    const { tenantId, branchId, businessDay } = input;

    // ── (1) the day's orders — Index Scan on (tenant_id, branch_id, business_day) ──
    const orders = await tx.order.findMany({
      where: { tenantId, branchId, businessDay },
      select: {
        id: true,
        state: true,
        currency: true,
        grandTotal: true,
        discountTotal: true,
        taxTotal: true,
        paidTotal: true,
      },
    });

    let grossSales = 0n;
    let discounts = 0n;
    let taxTotal = 0n;
    let completedOrderCount = 0;
    let openOrderCount = 0;
    // P1F-2 permits `paidTotal > grandTotal` on a completed order (the
    // completion threshold is `paidTotal >= grandTotal`, never equality,
    // and `SalesPaymentService.capture` places no upper bound on
    // `amountMinor`). The excess is captured tender with no defined
    // business/accounting disposition — reconciliation-only, never revenue.
    let completedExcessCapturedTotal = 0n;
    const orderCurrencySet = new Set<string>();
    const allOrderIds: string[] = [];
    const completedOrderIds: string[] = [];
    const openStateSet: ReadonlySet<string> = new Set(OPEN_ORDER_STATES);
    // POS-FIN-1 — design gate §6/§8 revisit: `partially_refunded`/`refunded`
    // are newly-reachable states for an order that WAS completed. CR-04/
    // BR-POS-001 never rewrite the posted totals a refund's original order
    // carries, so that order's grossSales/discounts/taxTotal contribution
    // must not silently disappear the moment a refund is issued against it
    // — the refund's own negative effect is captured separately, in the
    // `refunds` field (§ facts()'s own step 5), never by excluding the
    // order here.
    const settledStateSet: ReadonlySet<string> = new Set([
      'completed',
      'partially_refunded',
      'refunded',
    ]);

    for (const order of orders) {
      allOrderIds.push(order.id);
      if (settledStateSet.has(order.state)) {
        completedOrderCount += 1;
        completedOrderIds.push(order.id);
        grossSales += order.grandTotal;
        discounts += order.discountTotal;
        taxTotal += order.taxTotal;
        orderCurrencySet.add(order.currency);
        const excess = order.paidTotal - order.grandTotal;
        if (excess > 0n) completedExcessCapturedTotal += excess;
      } else if (openStateSet.has(order.state)) {
        openOrderCount += 1;
      }
    }
    const completedOrderIdSet = new Set(completedOrderIds);

    // ── (2) branch-inclusive payments, joined via the order-id set ──────────
    const payments =
      allOrderIds.length === 0
        ? []
        : await tx.orderPayment.findMany({
            where: { tenantId, businessDay, orderId: { in: allOrderIds } },
            select: {
              orderId: true,
              tender: true,
              amount: true,
              roundingAdjustment: true,
              currency: true,
              cashSessionId: true,
            },
          });

    let cashAmountTotal = 0n;
    let cashRoundingTotal = 0n;
    let cashPaymentCount = 0;
    let cardAmountTotal = 0n;
    let cardPaymentCount = 0;
    let unsettledCapturedTotal = 0n;
    const paymentCurrencySet = new Set<string>();
    const contributingCashSessionIdSet = new Set<string>();
    interface SessionAccumulator {
      cashSalesTotal: bigint;
      cashRoundingAdjustments: bigint;
      manualExternalCardTotal: bigint;
      paymentCount: number;
    }
    const sessionAccumulators = new Map<string, SessionAccumulator>();

    for (const payment of payments) {
      paymentCurrencySet.add(payment.currency);
      contributingCashSessionIdSet.add(payment.cashSessionId);

      let acc = sessionAccumulators.get(payment.cashSessionId);
      if (!acc) {
        acc = {
          cashSalesTotal: 0n,
          cashRoundingAdjustments: 0n,
          manualExternalCardTotal: 0n,
          paymentCount: 0,
        };
        sessionAccumulators.set(payment.cashSessionId, acc);
      }
      acc.paymentCount += 1;

      if (payment.tender === 'cash') {
        cashAmountTotal += payment.amount;
        cashRoundingTotal += payment.roundingAdjustment;
        cashPaymentCount += 1;
        acc.cashSalesTotal += payment.amount;
        acc.cashRoundingAdjustments += payment.roundingAdjustment;
      } else {
        cardAmountTotal += payment.amount;
        cardPaymentCount += 1;
        acc.manualExternalCardTotal += payment.amount;
      }

      if (!completedOrderIdSet.has(payment.orderId)) {
        unsettledCapturedTotal += payment.amount;
      }
    }
    const contributingCashSessionIds = [...contributingCashSessionIdSet];

    // ── (3) contributing sessions' FULL payment history, for businessDayCount ──
    const businessDayCountBySession = new Map<string, number>();
    if (contributingCashSessionIds.length > 0) {
      const spanRows = await tx.orderPayment.findMany({
        where: { tenantId, cashSessionId: { in: contributingCashSessionIds } },
        select: { cashSessionId: true, businessDay: true },
        distinct: ['cashSessionId', 'businessDay'],
      });
      for (const row of spanRows) {
        businessDayCountBySession.set(
          row.cashSessionId,
          (businessDayCountBySession.get(row.cashSessionId) ?? 0) + 1,
        );
      }
    }

    const sessionTenderTotals: DailySessionTenderTotals[] =
      contributingCashSessionIds.map((cashSessionId) => {
        const acc = sessionAccumulators.get(cashSessionId);
        return {
          cashSessionId,
          cashSalesTotal: acc?.cashSalesTotal ?? 0n,
          cashRoundingAdjustments: acc?.cashRoundingAdjustments ?? 0n,
          manualExternalCardTotal: acc?.manualExternalCardTotal ?? 0n,
          paymentCount: acc?.paymentCount ?? 0,
          businessDayCount: businessDayCountBySession.get(cashSessionId) ?? 0,
        };
      });

    // ── (4) completed orders' tax lines, excluding voided/comped ─────────────
    const taxByClass: DailyTaxClassAggregate[] =
      completedOrderIds.length === 0
        ? []
        : (
            await tx.orderLine.groupBy({
              by: ['taxClassId'],
              where: {
                tenantId,
                businessDay,
                orderId: { in: completedOrderIds },
                state: { notIn: ['voided', 'comped'] },
              },
              _sum: { taxAmount: true, lineTotal: true },
              _count: { _all: true },
            })
          ).map((row) => {
            const taxAmount = row._sum.taxAmount ?? 0n;
            const grossAmount = row._sum.lineTotal ?? 0n;
            return {
              taxClassId: row.taxClassId,
              taxAmount,
              netAmount: grossAmount - taxAmount,
              grossAmount,
              lineCount: row._count._all,
            };
          });

    // ── (5) refunds ISSUED on this business day, for this branch ────────────
    // POS-FIN-1 — scoped by the refund's OWN `refund_business_day`, never
    // the original order's `business_day` (see the contract's own doc
    // comment): a refund issued today against a sale from an earlier day
    // reduces TODAY's net sales, not that earlier day's.
    const refundAggregate = await tx.refund.aggregate({
      where: { tenantId, branchId, refundBusinessDay: businessDay },
      _sum: { amountMinor: true },
    });
    const refunds = refundAggregate._sum.amountMinor ?? 0n;

    return {
      grossSales,
      discounts,
      refunds,
      taxTotal,
      completedOrderCount,
      openOrderCount,
      cash: {
        amountTotal: cashAmountTotal,
        roundingAdjustmentTotal: cashRoundingTotal,
        paymentCount: cashPaymentCount,
      },
      manualExternalCard: {
        amountTotal: cardAmountTotal,
        roundingAdjustmentTotal: 0n,
        paymentCount: cardPaymentCount,
      },
      unsettledCapturedTotal,
      completedExcessCapturedTotal,
      taxByClass,
      orderCurrencies: [...orderCurrencySet],
      paymentCurrencies: [...paymentCurrencySet],
      contributingCashSessionIds,
      sessionTenderTotals,
    };
  }
}
