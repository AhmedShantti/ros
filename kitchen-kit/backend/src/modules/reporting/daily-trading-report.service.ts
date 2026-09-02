import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RoundingMode, divideRounded } from '../../common/money/rounding';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BRANCH_CURRENCY_QUERY,
  BRANCH_REPORTING_SCOPE_QUERY,
  type BranchCurrencyQuery,
  type BranchReportingScopeQuery,
} from '../organisation/contract';
import {
  DAILY_TRADING_SALES_QUERY,
  type DailyTradingSalesFacts,
  type DailyTradingSalesQuery,
} from '../sales/contract';
import {
  TAX_CLASS_LABELS_QUERY,
  type TaxClassLabelsQuery,
} from '../localisation/contract';
import {
  DAILY_CASH_RECONCILIATION_QUERY,
  type CashSessionWholeSessionFacts,
  type DailyCashReconciliationQuery,
} from '../treasury/contract';
import {
  SCOPE_REVIEW_QUERY,
  type ScopeReviewQuery,
} from '../identity/contract';

export interface DailyTradingReportInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly branchId: string;
  readonly businessDay: Date;
}

/**
 * Orchestrates the Minimum Operational Reporting daily-trading response
 * (RPT-R1/R2/R3; design gate + acceptance correction
 * `docs/reports/claude/2026-08-31_MINIMUM-reporting-*`).
 *
 * ONE `withAuthContext` RepeatableRead transaction produces the ENTIRE
 * response — `dataAsOf`, branch existence, the single-active-branch
 * fail-closed assertion, the future-day check, every financial fact, and
 * `periodStatus` all share one MVCC snapshot (design correction §8,
 * Correction F). There is NO separate `ReportingBranchGuard` and no second
 * transaction: a branch activated or deactivated concurrently is either
 * entirely inside or entirely outside this one snapshot.
 *
 * This service owns ZERO Prisma models. Every fact it reads comes from one
 * of five public contracts (`sales`, `treasury`, `organisation` x2,
 * `localisation`) injected by token — never a private cross-module path,
 * never a bare cross-module table query.
 */
@Injectable()
export class DailyTradingReportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DAILY_TRADING_SALES_QUERY)
    private readonly salesQuery: DailyTradingSalesQuery,
    @Inject(DAILY_CASH_RECONCILIATION_QUERY)
    private readonly cashQuery: DailyCashReconciliationQuery,
    @Inject(BRANCH_CURRENCY_QUERY)
    private readonly branchCurrencyQuery: BranchCurrencyQuery,
    @Inject(SCOPE_REVIEW_QUERY)
    private readonly scopeReview: ScopeReviewQuery,
    @Inject(BRANCH_REPORTING_SCOPE_QUERY)
    private readonly branchScopeQuery: BranchReportingScopeQuery,
    @Inject(TAX_CLASS_LABELS_QUERY)
    private readonly taxLabelsQuery: TaxClassLabelsQuery,
  ) {}

  async build(input: DailyTradingReportInput): Promise<DailyTradingReportView> {
    return this.prisma.withAuthContext(
      { tenantId: input.tenantId, userId: input.userId },
      (tx) => this.buildInTransaction(tx, input),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async buildInTransaction(
    tx: Prisma.TransactionClient,
    input: DailyTradingReportInput,
  ): Promise<DailyTradingReportView> {
    // ── 1. dataAsOf — FR-RPT-004, §29 ────────────────────────────────────────
    // `transaction_timestamp()`, not `now()` (an alias for the same value) or
    // `statement_timestamp()` (which would advance within the transaction and
    // make different response sections disagree on "as of"). Fixed at the
    // FIRST statement of this RepeatableRead transaction — see the design
    // acceptance correction §9 for the measured evidence.
    const [dataAsOfRow] = await tx.$queryRaw<
      { dataAsOf: Date }[]
    >`SELECT transaction_timestamp() AS "dataAsOf"`;
    const dataAsOf = dataAsOfRow.dataAsOf;

    // ── 2. branch existence — tenant-safe 404, byte-identical for unknown/foreign ──
    const branch = await this.branchCurrencyQuery.find(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
    });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }

    // ── 3. M-4+ GATE, then the operative-branch assertion — B1-3 §11 ────────
    //
    // The Internal-MVP SINGLE-ACTIVE-BRANCH mask is RETIRED here. It existed
    // because branch authorization did not: with no way to say "this actor may
    // report on THIS branch", the only safe posture was to refuse any tenant
    // that had more than one. B1-2 built the scoped model and B1-3 put a BRANCH
    // target on this very route, so the caller is now authorized against the
    // branch it named — which is the thing the mask was standing in for.
    //
    // The ratified retirement conditions (clause 13 / ADR 0009 D-11) are met in
    // order, and the middle one is enforced HERE rather than assumed:
    //   A. the B1-2 scoped foundation exists;
    //   B. B1-3 enforcement covers this surface — `@AuthorizationTarget(
    //      branchFromParam('branchId'))` on the route, decided by the same
    //      primitive every other converted operation uses;
    //   C. the tenant's INHERITED grants have been reviewed — asserted below.
    //
    // Limb C is why this is not simply a deletion. A tenant still holding
    // migration-originated TENANT assignments that nobody has reviewed would
    // GAIN reach the moment the mask came off: those grants cover every branch
    // by construction. So an unreviewed tenant fails CLOSED, with a message that
    // names the exact remedy rather than "not supported in this release".
    if (await this.scopeReview.hasUnreviewedInheritedAssignments(tx)) {
      throw new ForbiddenException(
        'This tenant still holds role assignments inherited from the ' +
          'pre-scoped-RBAC migration that have not been reviewed. Review or ' +
          're-scope them before using branch reporting — GET /auth/permissions ' +
          'reports scopeReviewRequired, and POST ' +
          '/auth/role-assignments/{assignmentId}/review records the outcome.',
      );
    }
    // The half of the old mask that was never a release limit: a report is only
    // meaningful for an OPERATIVE branch. Asked per branch, so the tenant's
    // branch COUNT is no longer an input (FR-BRN-001).
    if (
      !(await this.branchScopeQuery.isOperativeBranch(tx, {
        tenantId: input.tenantId,
        branchId: input.branchId,
      }))
    ) {
      throw new ForbiddenException('This branch is not active.');
    }

    // ── 4. current business day + future-day 400 — §16 ───────────────────────
    const branchCurrentBusinessDay = await this.salesQuery.currentBusinessDay(
      tx,
      { tenantId: input.tenantId, branchId: input.branchId },
    );
    if (input.businessDay.getTime() > branchCurrentBusinessDay.getTime()) {
      throw new BadRequestException('Future business days are not supported.');
    }

    // ── 5. Sales facts — §11/§12/§17/§18/§19/§21 ──────────────────────────────
    const sales = await this.salesQuery.facts(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      businessDay: input.businessDay,
    });

    // ── 6. historical currency resolution — §23 ──────────────────────────────
    const observedCurrencies = new Set<string>([
      ...sales.orderCurrencies,
      ...sales.paymentCurrencies,
    ]);
    let currency: string;
    let currencySource: 'TRANSACTION' | 'BRANCH_FALLBACK';
    if (observedCurrencies.size > 1) {
      throw new ConflictException(
        'Multiple transaction currencies were observed for this business day.',
      );
    } else if (observedCurrencies.size === 1) {
      [currency] = observedCurrencies;
      currencySource = 'TRANSACTION';
    } else {
      currency = branch.baseCurrency;
      currencySource = 'BRANCH_FALLBACK';
    }

    // ── 7. Treasury facts — WHOLE_SESSION, §26/§27 ───────────────────────────
    const sessions: readonly CashSessionWholeSessionFacts[] =
      sales.contributingCashSessionIds.length === 0
        ? []
        : await this.cashQuery.forSessions(tx, {
            tenantId: input.tenantId,
            branchId: input.branchId,
            cashSessionIds: sales.contributingCashSessionIds,
          });
    // Fail-closed invariant: every contributing session id came from Sales'
    // own tenant/branch-scoped payment query inside THIS same snapshot, so
    // every one of them MUST resolve in Treasury. Anything else is an
    // internal invariant breach — surfaced honestly, never a partial total.
    if (sessions.length !== sales.contributingCashSessionIds.length) {
      throw new ConflictException(
        'Cash reconciliation did not resolve every contributing cash session.',
      );
    }
    const contributingIdSet = new Set(sales.contributingCashSessionIds);
    for (const session of sessions) {
      if (!contributingIdSet.has(session.cashSessionId)) {
        throw new ConflictException(
          'Cash reconciliation returned a session outside the requested set.',
        );
      }
      if (session.currency !== currency) {
        throw new ConflictException(
          'A contributing cash session’s currency disagrees with this report’s transaction currency.',
        );
      }
    }

    // ── 8. tax-class labels — §22 ─────────────────────────────────────────
    const taxClassIds = sales.taxByClass.map((t) => t.taxClassId);
    const labels = await this.taxLabelsQuery.findByIds(tx, {
      tenantId: input.tenantId,
      taxClassIds,
    });

    // ── 9. periodStatus — §28 ─────────────────────────────────────────────
    const unclosedContributingSessionCount = sessions.filter(
      (s) => s.status !== 'closed',
    ).length;
    const periodStatus = resolvePeriodStatus({
      businessDay: input.businessDay,
      branchCurrentBusinessDay,
      openOrderCount: sales.openOrderCount,
      unclosedContributingSessionCount,
    });

    return assembleView({
      branchId: input.branchId,
      businessDay: input.businessDay,
      currency,
      currencySource,
      dataAsOf,
      periodStatus,
      branchCurrentBusinessDay,
      unclosedContributingSessionCount,
      sales,
      sessions,
      labels,
    });
  }
}

function resolvePeriodStatus(input: {
  businessDay: Date;
  branchCurrentBusinessDay: Date;
  openOrderCount: number;
  unclosedContributingSessionCount: number;
}): 'OPEN' | 'UNSEALED' | 'SETTLED' {
  if (
    input.businessDay.getTime() === input.branchCurrentBusinessDay.getTime()
  ) {
    return 'OPEN';
  }
  if (input.openOrderCount > 0 || input.unclosedContributingSessionCount > 0) {
    return 'UNSEALED';
  }
  return 'SETTLED';
}

// ---------------------------------------------------------------------------
// Response view — bigint internally, decimal (minor-unit) strings externally,
// exactly the `.toString()` convention `sales.views.ts` already uses.
// ---------------------------------------------------------------------------

export interface DailyTradingReportView {
  readonly branchId: string;
  readonly businessDay: string;
  readonly currency: string;
  readonly currencySource: 'TRANSACTION' | 'BRANCH_FALLBACK';
  readonly dataAsOf: string;
  readonly periodStatus: 'OPEN' | 'UNSEALED' | 'SETTLED';
  readonly branchCurrentBusinessDay: string;
  readonly openOrderCount: number;
  readonly unclosedContributingSessionCount: number;
  readonly salesSummary: {
    readonly grossSales: string;
    readonly discounts: string;
    readonly refunds: string;
    readonly taxTotal: string;
    readonly netSales: string;
    readonly completedOrderCount: number;
    readonly averageOrderValue: string | null;
    readonly unsettledCapturedTotal: string;
  };
  readonly tenderTotals: {
    readonly cash: {
      readonly amountTotal: string;
      readonly roundingAdjustmentTotal: string;
      readonly paymentCount: number;
    };
    readonly manualExternalCard: {
      readonly amountTotal: string;
      readonly roundingAdjustmentTotal: string;
      readonly paymentCount: number;
    };
    readonly tenderGrandTotal: string;
    readonly cashDrawerContribution: string;
    readonly paymentCount: number;
    /**
     * Acceptance correction, 2026-08-31 — captured payment value above a
     * completed order's grand total (P1F-2 permits `paidTotal > grandTotal`;
     * `Σ max(paidTotal - grandTotal, 0)` over the completed population).
     * Reconciliation-only: no revenue, tax, tip, discount, refund, cash-
     * rounding, or variance disposition is inferred. Present so
     * `tenderGrandTotal === grossSales + unsettledCapturedTotal +
     * completedExcessCapturedTotal` holds exactly.
     */
    readonly completedExcessCapturedTotal: string;
  };
  readonly taxSummary: {
    readonly taxTotal: string;
    readonly byClass: ReadonlyArray<{
      readonly taxClassId: string;
      readonly taxClassCode: string | null;
      readonly countryPackCode: string | null;
      readonly taxAmount: string;
      readonly netAmount: string;
      readonly grossAmount: string;
      readonly lineCount: number;
    }>;
  };
  readonly cashReconciliation: {
    readonly scope: 'WHOLE_SESSION';
    readonly sessions: ReadonlyArray<{
      readonly cashSessionId: string;
      readonly employeeId: string;
      readonly drawerId: string;
      readonly openedAt: string;
      readonly closedAt: string | null;
      readonly status: 'open' | 'closing' | 'closed';
      readonly currency: string;
      readonly openingFloat: string;
      readonly expectedCash: string | null;
      readonly countedCash: string | null;
      readonly variance: string | null;
      readonly payInTotal: string;
      readonly payOutTotal: string;
      readonly safeDropTotal: string;
      readonly isFinalised: boolean;
      readonly businessDayCount: number;
      readonly spansMultipleBusinessDays: boolean;
      readonly tenderTotalsForThisBusinessDay: {
        readonly cashSalesTotal: string;
        readonly cashRoundingAdjustments: string;
        readonly manualExternalCardTotal: string;
        readonly paymentCount: number;
      };
    }>;
    readonly contributingSessionCount: number;
    readonly closedSessionCount: number;
    readonly unclosedSessionCount: number;
    readonly spanningSessionCount: number;
  };
  readonly scope: {
    readonly salesPopulation: string;
    readonly lineExclusions: readonly string[];
    readonly tenderPopulation: string;
    readonly cashReconciliationScope: string;
    readonly notes: readonly string[];
  };
}

function assembleView(input: {
  branchId: string;
  businessDay: Date;
  currency: string;
  currencySource: 'TRANSACTION' | 'BRANCH_FALLBACK';
  dataAsOf: Date;
  periodStatus: 'OPEN' | 'UNSEALED' | 'SETTLED';
  branchCurrentBusinessDay: Date;
  unclosedContributingSessionCount: number;
  sales: DailyTradingSalesFacts;
  sessions: readonly CashSessionWholeSessionFacts[];
  labels: ReadonlyMap<string, { code: string; countryPackCode: string }>;
}): DailyTradingReportView {
  const { sales } = input;
  const money = (v: bigint) => v.toString();
  const nullableMoney = (v: bigint | null) =>
    v === null ? null : v.toString();
  const dateStr = (d: Date) => d.toISOString().slice(0, 10);

  const netSales =
    sales.grossSales - sales.discounts - sales.refunds - sales.taxTotal;
  const averageOrderValue =
    sales.completedOrderCount === 0
      ? null
      : divideRounded(
          netSales,
          BigInt(sales.completedOrderCount),
          RoundingMode.HALF_UP,
        ).toString();

  const tenderGrandTotal =
    sales.cash.amountTotal + sales.manualExternalCard.amountTotal;
  const cashDrawerContribution =
    sales.cash.amountTotal + sales.cash.roundingAdjustmentTotal;
  const tenderPaymentCount =
    sales.cash.paymentCount + sales.manualExternalCard.paymentCount;

  const sessionTenderById = new Map(
    sales.sessionTenderTotals.map((t) => [t.cashSessionId, t] as const),
  );

  const sessionViews = input.sessions.map((session) => {
    const tender = sessionTenderById.get(session.cashSessionId);
    const businessDayCount = tender?.businessDayCount ?? 0;
    return {
      cashSessionId: session.cashSessionId,
      employeeId: session.employeeId,
      drawerId: session.drawerId,
      openedAt: session.openedAt.toISOString(),
      closedAt: session.closedAt ? session.closedAt.toISOString() : null,
      status: session.status,
      currency: session.currency,
      openingFloat: money(session.openingFloat),
      expectedCash: nullableMoney(session.expectedCash),
      countedCash: nullableMoney(session.countedCash),
      variance: nullableMoney(session.variance),
      payInTotal: money(session.payInTotal),
      payOutTotal: money(session.payOutTotal),
      safeDropTotal: money(session.safeDropTotal),
      isFinalised: session.status === 'closed',
      businessDayCount,
      spansMultipleBusinessDays: businessDayCount > 1,
      tenderTotalsForThisBusinessDay: {
        cashSalesTotal: money(tender?.cashSalesTotal ?? 0n),
        cashRoundingAdjustments: money(tender?.cashRoundingAdjustments ?? 0n),
        manualExternalCardTotal: money(tender?.manualExternalCardTotal ?? 0n),
        paymentCount: tender?.paymentCount ?? 0,
      },
    };
  });

  return {
    branchId: input.branchId,
    businessDay: dateStr(input.businessDay),
    currency: input.currency,
    currencySource: input.currencySource,
    dataAsOf: input.dataAsOf.toISOString(),
    periodStatus: input.periodStatus,
    branchCurrentBusinessDay: dateStr(input.branchCurrentBusinessDay),
    openOrderCount: sales.openOrderCount,
    unclosedContributingSessionCount: input.unclosedContributingSessionCount,
    salesSummary: {
      grossSales: money(sales.grossSales),
      discounts: money(sales.discounts),
      refunds: money(sales.refunds),
      taxTotal: money(sales.taxTotal),
      netSales: money(netSales),
      completedOrderCount: sales.completedOrderCount,
      averageOrderValue,
      unsettledCapturedTotal: money(sales.unsettledCapturedTotal),
    },
    tenderTotals: {
      cash: {
        amountTotal: money(sales.cash.amountTotal),
        roundingAdjustmentTotal: money(sales.cash.roundingAdjustmentTotal),
        paymentCount: sales.cash.paymentCount,
      },
      manualExternalCard: {
        amountTotal: money(sales.manualExternalCard.amountTotal),
        roundingAdjustmentTotal: money(
          sales.manualExternalCard.roundingAdjustmentTotal,
        ),
        paymentCount: sales.manualExternalCard.paymentCount,
      },
      tenderGrandTotal: money(tenderGrandTotal),
      cashDrawerContribution: money(cashDrawerContribution),
      paymentCount: tenderPaymentCount,
      completedExcessCapturedTotal: money(sales.completedExcessCapturedTotal),
    },
    taxSummary: {
      taxTotal: money(sales.taxTotal),
      byClass: sales.taxByClass.map((t) => {
        const label = input.labels.get(t.taxClassId);
        return {
          taxClassId: t.taxClassId,
          taxClassCode: label?.code ?? null,
          countryPackCode: label?.countryPackCode ?? null,
          taxAmount: money(t.taxAmount),
          netAmount: money(t.netAmount),
          grossAmount: money(t.grossAmount),
          lineCount: t.lineCount,
        };
      }),
    },
    cashReconciliation: {
      scope: 'WHOLE_SESSION',
      sessions: sessionViews,
      contributingSessionCount: sessionViews.length,
      closedSessionCount: sessionViews.filter((s) => s.status === 'closed')
        .length,
      unclosedSessionCount: sessionViews.filter((s) => s.status !== 'closed')
        .length,
      spanningSessionCount: sessionViews.filter(
        (s) => s.spansMultipleBusinessDays,
      ).length,
    },
    scope: {
      salesPopulation: "orders.state = 'completed'",
      lineExclusions: ['voided', 'comped'],
      tenderPopulation:
        'All order_payments for this branch-day, any order state.',
      cashReconciliationScope: 'WHOLE_SESSION',
      notes: [
        'FR-RPT-001/002/003/005 NOT IMPLEMENTED — query-time aggregation over the transactional primary (Internal MVP).',
        'Tax by rate NOT IMPLEMENTED — the FR-FIN-032 component breakdown is not persisted.',
        'Discounts and refunds are structurally zero — no mechanism exists at this release.',
        'Cash reconciliation covers only sessions that captured a payment on this business day; zero-payment and movement-only sessions are not attributable to a business day and are not listed.',
        'Session close facts (expected/counted/variance) and movement totals are WHOLE-SESSION figures, not business-day figures; check businessDayCount before attributing them to this day.',
        'currency is the currency the day’s transactions were actually recorded in, not the branch’s present-day configured currency.',
        'tenderTotals.completedExcessCapturedTotal is captured payment value above a completed order’s grand total (P1F-2 permits paidTotal > grandTotal); it is reconciliation-only — no revenue, tax, tip, discount, refund, cash-rounding, or variance disposition is inferred. tenderGrandTotal === grossSales + unsettledCapturedTotal + completedExcessCapturedTotal.',
      ],
    },
  };
}
