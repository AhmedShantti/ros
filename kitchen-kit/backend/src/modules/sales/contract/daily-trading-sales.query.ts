import { Prisma } from '../../../generated/prisma/client';

/**
 * Sales PUBLIC contract — the daily-trading facts the Minimum Operational
 * Reporting slice needs (RPT-R1/R2/R3, governance register
 * "Minimum Operational Reporting Ratification — 2026-08-31"; design gate +
 * acceptance correction `docs/reports/claude/2026-08-31_MINIMUM-reporting-*`).
 *
 * `facts()` and `currentBusinessDay()` are both `tx`-FIRST — load-bearing,
 * not stylistic: the Reporting module composes the ENTIRE daily-trading
 * response inside ONE RepeatableRead transaction (branch existence, the
 * single-active-branch assertion, the future-day check and every financial
 * fact), so every read here must share that one MVCC snapshot. There is no
 * second transaction anywhere in this contract.
 *
 * `currentBusinessDay` reuses `resolveBusinessDay`/`cutoverLookup`
 * (`sales/orders/business-day.ts`) — the SAME FR-FIN-024 implementation
 * `OrdersService` uses to stamp a new Order's `business_day`. This is
 * deliberate: the report and Order creation must never be able to disagree
 * about what "today's business day" is. No second business-day algorithm
 * exists anywhere in this contract's implementation.
 *
 * ── SALES POPULATION (revenue) ──────────────────────────────────────────────
 * `orders.state = 'completed'` ONLY, for the requested `(tenantId, branchId,
 * businessDay)`. `draft`/`open`/`held`/`parked`/`partially_paid`/`cancelled`
 * are excluded — a partially-paid order's captured money is a TENDER fact,
 * never Sales Summary revenue (see `unsettledCapturedTotal` below).
 * `orders.subtotal` never participates in any of these figures: its meaning
 * differs between tax-inclusive and tax-exclusive pricing
 * (`order-lines.service.ts`), so a mixed-mode tenant would silently corrupt
 * any total derived from it. `grossSales` sums the tax-inclusive
 * `orders.grand_total`.
 *
 * ── TENDER POPULATION (reconciliation) ──────────────────────────────────────
 * ALL `order_payments` for `(tenantId, branchId, businessDay)`, regardless of
 * the owning Order's state — a payment captured on a `partially_paid` order
 * appears here and in `unsettledCapturedTotal`, never in `grossSales`/
 * `netSales`. `payment.amount` is the ONLY field summed into a tender total;
 * `tendered_amount` and `change_given` never are (a 90-due/100-tendered/
 * 10-change cash sale contributes exactly 90). Cash `rounding_adjustment` is
 * a separate, reconciliation-only figure — never added to any revenue/tax
 * total. Queries are ORDERS-FIRST (`orders` filtered by the existing
 * `(tenant_id, branch_id, business_day)` index, then `order_payments` joined
 * on the existing `(tenant_id, order_id, business_day)` index) — never a
 * payments-first scan, because `order_payments` carries no
 * `(tenant_id, branch_id, business_day)` index and none is added by this
 * slice (no migration authorised).
 *
 * ── COMPLETED OVERPAYMENT (acceptance correction, 2026-08-31) ─────────────
 * The original design/report asserted `tenderGrandTotal === grossSales +
 * unsettledCapturedTotal`. That identity is FALSE on a currently reachable
 * P1F-2 state: completion requires `paidTotal >= grandTotal`, not equality,
 * and `SalesPaymentService.capture` places no upper bound on a Payment's
 * amount, tender-agnostically. `completedExcessCapturedTotal` (below) is the
 * missing, deliberately NEUTRAL third term; the corrected identity is
 * `tenderGrandTotal === grossSales + unsettledCapturedTotal +
 * completedExcessCapturedTotal`.
 *
 * ── TAX BY CLASS ─────────────────────────────────────────────────────────
 * `order_lines` of the SAME completed-order population, excluding lines in
 * `state IN ('voided', 'comped')` (an `isComp` line that has not yet reached
 * `comped` cannot occur on a `completed` order under the current
 * `order-state.ts` transitions, so the `state` predicate alone is sufficient
 * — see the implementation's own note). Grouped by `tax_class_id` only — no
 * `byRate` breakdown (FR-FIN-032's component breakdown is not persisted).
 *
 * ── CURRENCY / SESSION ATTRIBUTION ───────────────────────────────────────
 * `orderCurrencies`/`paymentCurrencies` are the distinct currencies observed
 * over the Sales/Tender populations respectively — Reporting derives
 * `currency`/`currencySource` from their union (design correction §D), never
 * from `org.branches.base_currency` when a historical monetary fact exists
 * to contradict it. `sessionTenderTotals` gives, per DISTINCT
 * `order_payments.cash_session_id` in the tender population, the day-scoped
 * cash/card totals Reporting attaches to that session's row, PLUS
 * `businessDayCount` — `COUNT(DISTINCT business_day)` over that session's
 * payments (not scoped to this one business day) — so a session whose
 * payments span two business days is visibly NOT exclusive to either report
 * (design correction §3.3). `treasury.cash_sessions` carries no
 * `business_day` column and none is invented; Reporting must not attribute a
 * zero-payment or movement-only session to any day.
 */
export const DAILY_TRADING_SALES_QUERY = Symbol('DAILY_TRADING_SALES_QUERY');

export interface DailyTradingSalesQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly businessDay: Date;
}

export interface CurrentBusinessDayInput {
  readonly tenantId: string;
  readonly branchId: string;
}

/** One `sales.order_lines.tax_class_id` group, over the tax-breakdown population (§21). */
export interface DailyTaxClassAggregate {
  readonly taxClassId: string;
  /** Σ `order_lines.tax_amount`. */
  readonly taxAmount: bigint;
  /** Σ (`line_total` − `tax_amount`) — the class's tax-exclusive contribution. */
  readonly netAmount: bigint;
  /** Σ `order_lines.line_total` — tax-inclusive. `netAmount + taxAmount === grossAmount`. */
  readonly grossAmount: bigint;
  readonly lineCount: number;
}

/** Day-scoped tender totals for ONE contributing CashSession (§17/§25). */
export interface DailySessionTenderTotals {
  readonly cashSessionId: string;
  /** tender='cash' — Σ amount, for THIS business day only. */
  readonly cashSalesTotal: bigint;
  /** tender='cash' — Σ rounding_adjustment, for THIS business day only. */
  readonly cashRoundingAdjustments: bigint;
  /** tender='manual_external_card' — Σ amount, for THIS business day only. */
  readonly manualExternalCardTotal: bigint;
  /** Total Payment row count for the session, on THIS business day. */
  readonly paymentCount: number;
  /**
   * `COUNT(DISTINCT order_payments.business_day)` over ALL of this session's
   * payments (not scoped to the requested day) — §25. `> 1` means the
   * session's whole-session close facts (Treasury) must not be attributed to
   * this day alone.
   */
  readonly businessDayCount: number;
}

export interface DailyTradingSalesFacts {
  // ── Sales Summary (§12) — completed-orders population only ──────────────
  /** Σ completed `orders.grand_total` — tax-inclusive. */
  readonly grossSales: bigint;
  /** Σ completed `orders.discount_total` — structurally `0n` at this HEAD. */
  readonly discounts: bigint;
  /** Literal `0n` — no refund mechanism exists at this HEAD. */
  readonly refunds: bigint;
  /** Σ completed `orders.tax_total`. */
  readonly taxTotal: bigint;
  readonly completedOrderCount: number;
  /** Count of orders in draft/open/held/parked/partially_paid for this branch-day. */
  readonly openOrderCount: number;

  // ── Tender totals (§18) — ALL branch-day payments, any order state ──────
  readonly cash: {
    readonly amountTotal: bigint;
    readonly roundingAdjustmentTotal: bigint;
    readonly paymentCount: number;
  };
  readonly manualExternalCard: {
    readonly amountTotal: bigint;
    /** Always `0n` — CHECK-constrained non-cash rounding. */
    readonly roundingAdjustmentTotal: bigint;
    readonly paymentCount: number;
  };

  // ── Partially-paid reconciliation (§19) ──────────────────────────────────
  /** Σ `payment.amount` for branch-day payments whose Order is NOT completed. */
  readonly unsettledCapturedTotal: bigint;
  /**
   * Acceptance correction, 2026-08-31 — completed-overpayment reconciliation.
   *
   * P1F-2 settled the completion threshold as `paidTotal >= grandTotal`, not
   * equality, and places no upper bound on a single Payment's `amountMinor`
   * (`sales-payment.service.ts` validates only `amountMinor > 0`, tender-
   * agnostically). A completed order's `paidTotal` can therefore legitimately
   * exceed its `grandTotal`. `Σ max(paidTotal - grandTotal, 0)` over the
   * completed population is the captured tender this creates.
   *
   * This is reconciliation-only: no revenue, tax, tip, discount, refund,
   * cash-rounding, or variance classification is inferred — no authority
   * defines a business/accounting disposition for it at this HEAD. It exists
   * so that `tenderGrandTotal === grossSales + unsettledCapturedTotal +
   * completedExcessCapturedTotal` holds exactly, on every reachable state.
   */
  readonly completedExcessCapturedTotal: bigint;

  // ── Tax by class (§21) ───────────────────────────────────────────────────
  readonly taxByClass: readonly DailyTaxClassAggregate[];

  // ── Currency (§23) ────────────────────────────────────────────────────
  /** Distinct `orders.currency` over the completed (Sales) population. */
  readonly orderCurrencies: readonly string[];
  /** Distinct `order_payments.currency` over the tender population. */
  readonly paymentCurrencies: readonly string[];

  // ── Session attribution (§24/§25) ────────────────────────────────────────
  /** DISTINCT `order_payments.cash_session_id` over the tender population. */
  readonly contributingCashSessionIds: readonly string[];
  readonly sessionTenderTotals: readonly DailySessionTenderTotals[];
}

export interface DailyTradingSalesQuery {
  /**
   * The branch's current business day RIGHT NOW, via the SAME FR-FIN-024
   * derivation Order creation uses. Reporting uses this for the future-day
   * 400 (§16) and the `periodStatus` OPEN/UNSEALED/SETTLED split (§28).
   */
  currentBusinessDay(
    tx: Prisma.TransactionClient,
    input: CurrentBusinessDayInput,
  ): Promise<Date>;

  facts(
    tx: Prisma.TransactionClient,
    input: DailyTradingSalesQueryInput,
  ): Promise<DailyTradingSalesFacts>;
}
