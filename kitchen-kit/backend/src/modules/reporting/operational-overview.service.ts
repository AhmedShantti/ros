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
  BRANCH_LOCATIONS_QUERY,
  BRANCH_REPORTING_SCOPE_QUERY,
  type BranchCurrencyQuery,
  type BranchLocationsQuery,
  type BranchReportingScopeQuery,
} from '../organisation/contract';
import {
  DAILY_TRADING_SALES_QUERY,
  type DailyTradingSalesFacts,
  type DailyTradingSalesQuery,
} from '../sales/contract';
import {
  DAILY_CASH_RECONCILIATION_QUERY,
  type CashSessionWholeSessionFacts,
  type DailyCashReconciliationQuery,
} from '../treasury/contract';
import {
  SCOPE_REVIEW_QUERY,
  type ScopeReviewQuery,
} from '../identity/contract';
import {
  BRANCH_INVENTORY_SNAPSHOT_QUERY,
  type BranchInventorySnapshotFacts,
  type BranchInventorySnapshotQuery,
} from '../inventory/contract';
import {
  ATTENDANCE_SUMMARY_QUERY,
  type AttendanceSummaryFacts,
  type AttendanceSummaryQuery,
} from '../workforce/contract';
import {
  KDS_SUMMARY_QUERY,
  type KdsSummaryFacts,
  type KdsSummaryQuery,
} from '../kitchen/contract';

export interface OperationalOverviewInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly branchId: string;
  readonly businessDay: Date;
}

/**
 * Operational Analytics / Reporting Demo Pack (RPT-DEMO-1) — a SECOND
 * branch-scoped Reporting route, alongside `daily-trading` (RPT-R1/R2/R3),
 * gated by the SAME two permissions (`report.view.sales` AND
 * `report.view.financial` — no new `report.view.*` code is introduced; see
 * `reporting.permissions.ts`'s governance note) and the SAME
 * `@AuthorizationTarget(branchFromParam('branchId'))`.
 *
 * `sales`/`cash` reuse EXACTLY the same contract queries and gates
 * `DailyTradingReportService` uses (branch existence, unreviewed-migration
 * scope-review, operative-branch, future-day) — this is deliberately a
 * SIBLING orchestration, not a refactor of that service, so the existing
 * `daily-trading` route and its whole E2E suite are untouched (RPT-DEMO-1
 * non-negotiable: no unrelated regression).
 *
 * `inventory`/`workforce`/`kds` are NEW facts, each behind its own thin
 * `contract/` query published by this task (`BRANCH_INVENTORY_SNAPSHOT_QUERY`,
 * `ATTENDANCE_SUMMARY_QUERY`, `KDS_SUMMARY_QUERY`) — this service owns ZERO
 * Prisma models itself, exactly like `DailyTradingReportService`.
 *
 * ONE `withAuthContext` RepeatableRead transaction produces the ENTIRE
 * response, for the same TOCTOU reason `DailyTradingReportService` documents.
 *
 * Multi-branch/tenant: there is no separate tenant-consolidated route in
 * this slice (RPT-DEMO-1 §4 makes it conditional — "if safely
 * implementable"). Building a permission-aware bulk branch resolver was
 * judged out of scope for tonight; the P0 multi-branch proofs (A1-only,
 * A1+A2, tenant owner, Tenant-B isolation) are demonstrated by calling this
 * SAME per-branch route with different `branchId`s and different actors —
 * exactly how MTMB-1 already proved the daily-trading route. See the
 * implementation report's `FULL_SRS_REPORTING_REMAINING` for this deferral.
 */
@Injectable()
export class OperationalOverviewService {
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
    @Inject(BRANCH_LOCATIONS_QUERY)
    private readonly branchLocationsQuery: BranchLocationsQuery,
    @Inject(BRANCH_INVENTORY_SNAPSHOT_QUERY)
    private readonly inventorySnapshotQuery: BranchInventorySnapshotQuery,
    @Inject(ATTENDANCE_SUMMARY_QUERY)
    private readonly attendanceSummaryQuery: AttendanceSummaryQuery,
    @Inject(KDS_SUMMARY_QUERY)
    private readonly kdsSummaryQuery: KdsSummaryQuery,
  ) {}

  async build(
    input: OperationalOverviewInput,
  ): Promise<OperationalOverviewView> {
    return this.prisma.withAuthContext(
      { tenantId: input.tenantId, userId: input.userId },
      (tx) => this.buildInTransaction(tx, input),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async buildInTransaction(
    tx: Prisma.TransactionClient,
    input: OperationalOverviewInput,
  ): Promise<OperationalOverviewView> {
    const [dataAsOfRow] = await tx.$queryRaw<
      { dataAsOf: Date }[]
    >`SELECT transaction_timestamp() AS "dataAsOf"`;
    const dataAsOf = dataAsOfRow.dataAsOf;

    const branch = await this.branchCurrencyQuery.find(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
    });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }

    if (await this.scopeReview.hasUnreviewedInheritedAssignments(tx)) {
      throw new ForbiddenException(
        'This tenant still holds role assignments inherited from the ' +
          'pre-scoped-RBAC migration that have not been reviewed. Review or ' +
          're-scope them before using branch reporting — GET /auth/permissions ' +
          'reports scopeReviewRequired, and POST ' +
          '/auth/role-assignments/{assignmentId}/review records the outcome.',
      );
    }
    if (
      !(await this.branchScopeQuery.isOperativeBranch(tx, {
        tenantId: input.tenantId,
        branchId: input.branchId,
      }))
    ) {
      throw new ForbiddenException('This branch is not active.');
    }

    const branchCurrentBusinessDay = await this.salesQuery.currentBusinessDay(
      tx,
      { tenantId: input.tenantId, branchId: input.branchId },
    );
    if (input.businessDay.getTime() > branchCurrentBusinessDay.getTime()) {
      throw new BadRequestException('Future business days are not supported.');
    }

    // ── Sales + Cash — identical population/gate semantics to daily-trading ──
    const sales = await this.salesQuery.facts(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      businessDay: input.businessDay,
    });

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

    const sessions: readonly CashSessionWholeSessionFacts[] =
      sales.contributingCashSessionIds.length === 0
        ? []
        : await this.cashQuery.forSessions(tx, {
            tenantId: input.tenantId,
            branchId: input.branchId,
            cashSessionIds: sales.contributingCashSessionIds,
          });
    if (sessions.length !== sales.contributingCashSessionIds.length) {
      throw new ConflictException(
        'Cash reconciliation did not resolve every contributing cash session.',
      );
    }
    for (const session of sessions) {
      if (session.currency !== currency) {
        throw new ConflictException(
          'A contributing cash session’s currency disagrees with this report’s transaction currency.',
        );
      }
    }

    const unclosedContributingSessionCount = sessions.filter(
      (s) => s.status !== 'closed',
    ).length;
    const periodStatus = resolvePeriodStatus({
      businessDay: input.businessDay,
      branchCurrentBusinessDay,
      openOrderCount: sales.openOrderCount,
      unclosedContributingSessionCount,
    });

    // ── Inventory — a calendar-day window on `recordedAt` ──────────────────
    const windowFrom = input.businessDay;
    const windowTo = new Date(input.businessDay.getTime() + 86_400_000);
    const locationIds = await this.branchLocationsQuery.listLocationIds(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
    });
    const inventory = await this.inventorySnapshotQuery.forLocations(tx, {
      tenantId: input.tenantId,
      locationIds,
      wasteFrom: windowFrom,
      wasteTo: windowTo,
    });

    // ── Workforce — a calendar-day window on `clockInAt` ────────────────────
    const workforce = await this.attendanceSummaryQuery.forBranch(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      windowFrom,
      windowTo,
    });

    // ── KDS — the SAME business day as Sales/Cash ───────────────────────────
    const kds = await this.kdsSummaryQuery.forBranch(tx, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      businessDay: input.businessDay,
    });

    return assembleView({
      branchId: input.branchId,
      businessDay: input.businessDay,
      currency,
      currencySource,
      dataAsOf,
      periodStatus,
      branchCurrentBusinessDay,
      sales,
      sessions,
      inventory,
      workforce,
      kds,
      windowFrom,
      windowTo,
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
// the same convention `daily-trading-report.service.ts` uses.
// ---------------------------------------------------------------------------

export interface OperationalOverviewView {
  readonly branchId: string;
  readonly businessDay: string;
  readonly currency: string;
  readonly currencySource: 'TRANSACTION' | 'BRANCH_FALLBACK';
  readonly dataAsOf: string;
  readonly periodStatus: 'OPEN' | 'UNSEALED' | 'SETTLED';
  readonly branchCurrentBusinessDay: string;
  readonly sales: {
    readonly grossSales: string;
    readonly netSales: string;
    readonly discounts: string;
    readonly refunds: string;
    readonly taxTotal: string;
    readonly completedOrderCount: number;
    readonly openOrderCount: number;
    readonly averageOrderValue: string | null;
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
      readonly completedExcessCapturedTotal: string;
      readonly unsettledCapturedTotal: string;
    };
  };
  readonly cash: {
    readonly scope: 'WHOLE_SESSION';
    readonly sessions: ReadonlyArray<{
      readonly cashSessionId: string;
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
    }>;
    readonly contributingSessionCount: number;
    readonly closedSessionCount: number;
    readonly unclosedSessionCount: number;
  };
  readonly inventory: {
    readonly lowStockItemCount: number;
    readonly waste: {
      readonly windowFrom: string;
      readonly windowTo: string;
      readonly recordCount: number;
      readonly quantityTotal: string;
      readonly valueTotal: string;
    };
    readonly notes: readonly string[];
  };
  readonly workforce: {
    readonly windowFrom: string;
    readonly windowTo: string;
    readonly clockedInCount: number;
    readonly attendanceRecordCount: number;
    readonly lateArrivalCount: number;
    readonly earlyDepartureCount: number;
    readonly unscheduledCount: number;
    readonly outsideGeofenceCount: number;
    readonly missingClockOutCount: number;
    readonly notes: readonly string[];
  };
  readonly kds: {
    readonly ticketCount: number;
    readonly statusCounts: Readonly<Record<string, number>>;
    readonly measuredPrepDurationCount: number;
    readonly averagePrepDurationSeconds: number | null;
    readonly notes: readonly string[];
  };
  readonly scope: {
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
  sales: DailyTradingSalesFacts;
  sessions: readonly CashSessionWholeSessionFacts[];
  inventory: BranchInventorySnapshotFacts;
  workforce: AttendanceSummaryFacts;
  kds: KdsSummaryFacts;
  windowFrom: Date;
  windowTo: Date;
}): OperationalOverviewView {
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

  return {
    branchId: input.branchId,
    businessDay: dateStr(input.businessDay),
    currency: input.currency,
    currencySource: input.currencySource,
    dataAsOf: input.dataAsOf.toISOString(),
    periodStatus: input.periodStatus,
    branchCurrentBusinessDay: dateStr(input.branchCurrentBusinessDay),
    sales: {
      grossSales: money(sales.grossSales),
      netSales: money(netSales),
      discounts: money(sales.discounts),
      refunds: money(sales.refunds),
      taxTotal: money(sales.taxTotal),
      completedOrderCount: sales.completedOrderCount,
      openOrderCount: sales.openOrderCount,
      averageOrderValue,
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
        unsettledCapturedTotal: money(sales.unsettledCapturedTotal),
      },
    },
    cash: {
      scope: 'WHOLE_SESSION',
      sessions: input.sessions.map((session) => ({
        cashSessionId: session.cashSessionId,
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
      })),
      contributingSessionCount: input.sessions.length,
      closedSessionCount: input.sessions.filter((s) => s.status === 'closed')
        .length,
      unclosedSessionCount: input.sessions.filter((s) => s.status !== 'closed')
        .length,
    },
    inventory: {
      lowStockItemCount: input.inventory.lowStockItemCount,
      waste: {
        windowFrom: input.windowFrom.toISOString(),
        windowTo: input.windowTo.toISOString(),
        recordCount: input.inventory.wasteRecordCount,
        quantityTotal: input.inventory.wasteQuantityTotal,
        valueTotal: money(input.inventory.wasteValueTotal),
      },
      notes: [
        'Scoped to this branch’s own storage location(s) only (org.locations, locationType=branch) — a supplying warehouse/central kitchen is not included.',
        'waste is a CALENDAR-day window on waste_records.recordedAt, not the POS business day — inventory carries no business-day column.',
        'Movement summary and COGS/depletion are NOT IMPLEMENTED — no existing accepted query logic publishes them safely (RPT-DEMO-1 §2C).',
      ],
    },
    workforce: {
      windowFrom: input.windowFrom.toISOString(),
      windowTo: input.windowTo.toISOString(),
      clockedInCount: input.workforce.clockedInCount,
      attendanceRecordCount: input.workforce.attendanceRecordCount,
      lateArrivalCount: input.workforce.lateArrivalCount,
      earlyDepartureCount: input.workforce.earlyDepartureCount,
      unscheduledCount: input.workforce.unscheduledCount,
      outsideGeofenceCount: input.workforce.outsideGeofenceCount,
      missingClockOutCount: input.workforce.missingClockOutCount,
      notes: [
        'clockedInCount is a LIVE gauge (status=open right now), not scoped to windowFrom/windowTo.',
        'Every other count is a CALENDAR-day window on attendance_records.clock_in_at, not the POS business day — workforce carries no business-day column.',
        'The five flags are independent (FR-HRM-022) and do not sum to attendanceRecordCount.',
        'Overtime calculation and Country Pack labour rules are NOT IMPLEMENTED.',
      ],
    },
    kds: {
      ticketCount: input.kds.ticketCount,
      statusCounts: input.kds.statusCounts,
      measuredPrepDurationCount: input.kds.measuredPrepDurationCount,
      averagePrepDurationSeconds: input.kds.averagePrepDurationSeconds,
      notes: [
        'Scoped to the SAME business day as sales/cash (kitchen.tickets.business_day is a real column).',
        'averagePrepDurationSeconds is startedAt→bumpedAt only, over tickets with both persisted — servedAt is never populated by any write path in this codebase, so no fulfilment/serving-time metric is computed.',
      ],
    },
    scope: {
      notes: [
        'DEMO/OPERATIONAL implementation — query-time aggregation over the transactional primary (FR-RPT-001/002/003/005 remain NOT IMPLEMENTED), exactly like daily-trading.',
        'sales/cash reuse daily-trading’s exact population/formulas — see that route’s own scope.notes for the full disclosure (refund/discount/comp/tender semantics).',
        'No tenant-wide consolidated route in this slice — call this same per-branch route once per authorized branch.',
      ],
    },
  };
}
