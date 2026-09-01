import { Prisma } from '../../../generated/prisma/client';
import type { DailyTradingSalesFacts } from './daily-trading-sales.query';

/**
 * Sales PUBLIC contract — the DayClose-specific facts `FR-FIN-022`'s Z
 * snapshot needs, beyond what the accepted `DAILY_TRADING_SALES_QUERY`
 * already exposes (final design gate §8.9, design-gate acceptance
 * correction §21 — "a NEW, additive, DayClose-specific Sales contract; do
 * NOT extend `DAILY_TRADING_SALES_QUERY`"). Extending the Reporting
 * contract would either change the ACCEPTED Reporting HTTP response shape
 * or push dead fields into a ratified read surface — DayClose is a sealed,
 * permanent snapshot, a genuinely different acceptance class from a live,
 * recomputable report.
 *
 * `facts()` REUSES `DailyTradingSalesQueryService.facts()` internally for
 * every figure that already has a ratified formula (gross/discounts/
 * refunds/tax/tender/unsettled/completedExcess/taxByClass/openOrderCount) —
 * `DailyTradingSalesFacts` is embedded verbatim below, never recomputed.
 * This contract adds exactly three NEW facts DayClose needs that Reporting
 * does not expose: the exact `openOrderIds` set (Reporting only needs the
 * count; DayClose's 409 body lists blocking orders), `salesByOrderType`
 * (FR-FIN-022 class C — `orders.order_type` is a NOT NULL enum on the order
 * itself, no master-data join), and `voidSummary` (class C — pre-fire voids
 * only, `order_lines.state = 'voided'` on the SAME completed population;
 * comps are structurally zero, DC-R1 clause 3, and are not derived here).
 *
 * `tx`-FIRST — DayClose composes its ENTIRE close inside one transaction
 * (READ COMMITTED, under the shared `ros_order_number` fence); every read
 * here shares that transaction, never a second one.
 */
export const DAY_CLOSE_SALES_FACTS_QUERY = Symbol(
  'DAY_CLOSE_SALES_FACTS_QUERY',
);

export interface DayCloseSalesFactsQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly businessDay: Date;
}

/** One `orders.order_type` group, over the completed population (class C). */
export interface DayCloseOrderTypeAggregate {
  readonly orderType: string;
  /** Σ completed `orders.grand_total` for this order type. */
  readonly grossSales: bigint;
  /** `grossSales` for this type, minus its share of discounts/refunds/tax
   *  — `0n`/`0n` at this HEAD, so numerically `grossSales - taxTotal`. */
  readonly netSales: bigint;
  readonly orderCount: number;
}

/** Pre-fire void summary only (class C) — comps are structurally zero (DC-R1). */
export interface DayCloseVoidSummary {
  readonly voidedLineCount: number;
  readonly voidedLineValueMinorUnits: bigint;
}

export interface DayCloseSalesFacts extends DailyTradingSalesFacts {
  /** Exact ids of the branch-day's `draft`/`open`/`held`/`parked`/
   *  `partially_paid` orders — the FR-FIN-023 finality precondition's
   *  blocking set (§15 of the final design gate). */
  readonly openOrderIds: readonly string[];
  readonly salesByOrderType: readonly DayCloseOrderTypeAggregate[];
  readonly voidSummary: DayCloseVoidSummary;
}

export interface DayCloseSalesFactsQuery {
  facts(
    tx: Prisma.TransactionClient,
    input: DayCloseSalesFactsQueryInput,
  ): Promise<DayCloseSalesFacts>;
}
