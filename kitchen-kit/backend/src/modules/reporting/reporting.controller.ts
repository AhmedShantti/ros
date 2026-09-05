import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  businessDaySchema,
  decimalStringSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import {
  CurrentTenantContext,
  JwtAuthGuard,
  PermissionGuard,
  RequirePermission,
  TenantContextGuard,
} from '../identity/contract';
import type { TenantContext } from '../identity/contract';
import { DailyTradingReportService } from './daily-trading-report.service';
import { OperationalOverviewService } from './operational-overview.service';
import {
  DailyTradingReportParamsDto,
  DailyTradingReportQueryDto,
  OperationalOverviewParamsDto,
  OperationalOverviewQueryDto,
} from './reporting.dto';
import { REPORTING_PERMISSIONS } from './reporting.permissions';
import { AuthorizationTarget, branchFromParam } from '../identity/contract';

// Shape verified against `daily-trading-report.service.ts`'s
// `DailyTradingReportView`/`assembleView` — not against the Prisma schema or
// the SRS.
const tenderFamilyTotalsSchema = {
  type: 'object',
  properties: {
    amountTotal: moneyStringSchema(),
    roundingAdjustmentTotal: moneyStringSchema(),
    paymentCount: { type: 'integer' },
  },
};

const dailyTradingReportSchema = {
  type: 'object',
  properties: {
    branchId: uuidSchema(),
    businessDay: businessDaySchema(),
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
    currencySource: {
      type: 'string',
      enum: ['TRANSACTION', 'BRANCH_FALLBACK'],
    },
    dataAsOf: isoDateTimeSchema(),
    periodStatus: { type: 'string', enum: ['OPEN', 'UNSEALED', 'SETTLED'] },
    branchCurrentBusinessDay: businessDaySchema(),
    openOrderCount: { type: 'integer' },
    unclosedContributingSessionCount: { type: 'integer' },
    salesSummary: {
      type: 'object',
      properties: {
        grossSales: moneyStringSchema(),
        discounts: moneyStringSchema(),
        refunds: moneyStringSchema(),
        taxTotal: moneyStringSchema(),
        netSales: moneyStringSchema(),
        completedOrderCount: { type: 'integer' },
        averageOrderValue: nullable(moneyStringSchema()),
        unsettledCapturedTotal: moneyStringSchema(),
      },
    },
    tenderTotals: {
      type: 'object',
      properties: {
        cash: tenderFamilyTotalsSchema,
        manualExternalCard: tenderFamilyTotalsSchema,
        tenderGrandTotal: moneyStringSchema(),
        cashDrawerContribution: moneyStringSchema(),
        paymentCount: { type: 'integer' },
        completedExcessCapturedTotal: moneyStringSchema(
          'Captured payment value above a completed order’s grand total. Reconciliation-only — no revenue/tax/tip/discount/refund/rounding/variance disposition is inferred.',
        ),
      },
    },
    taxSummary: {
      type: 'object',
      properties: {
        taxTotal: moneyStringSchema(),
        byClass: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taxClassId: uuidSchema(),
              taxClassCode: nullable({ type: 'string' }),
              countryPackCode: nullable({ type: 'string' }),
              taxAmount: moneyStringSchema(),
              netAmount: moneyStringSchema(),
              grossAmount: moneyStringSchema(),
              lineCount: { type: 'integer' },
            },
          },
        },
      },
    },
    cashReconciliation: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['WHOLE_SESSION'] },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              cashSessionId: uuidSchema(),
              employeeId: uuidSchema(),
              drawerId: uuidSchema(),
              openedAt: isoDateTimeSchema(),
              closedAt: nullable(isoDateTimeSchema()),
              status: { type: 'string', enum: ['open', 'closing', 'closed'] },
              currency: {
                type: 'string',
                description: 'ISO 4217 currency code.',
                example: 'AED',
              },
              openingFloat: moneyStringSchema(),
              expectedCash: nullable(moneyStringSchema()),
              countedCash: nullable(moneyStringSchema()),
              variance: nullable(moneyStringSchema()),
              payInTotal: moneyStringSchema(),
              payOutTotal: moneyStringSchema(),
              safeDropTotal: moneyStringSchema(),
              isFinalised: { type: 'boolean' },
              businessDayCount: { type: 'integer' },
              spansMultipleBusinessDays: { type: 'boolean' },
              tenderTotalsForThisBusinessDay: {
                type: 'object',
                properties: {
                  cashSalesTotal: moneyStringSchema(),
                  cashRoundingAdjustments: moneyStringSchema(),
                  manualExternalCardTotal: moneyStringSchema(),
                  paymentCount: { type: 'integer' },
                },
              },
            },
          },
        },
        contributingSessionCount: { type: 'integer' },
        closedSessionCount: { type: 'integer' },
        unclosedSessionCount: { type: 'integer' },
        spanningSessionCount: { type: 'integer' },
      },
    },
    scope: {
      type: 'object',
      properties: {
        salesPopulation: { type: 'string' },
        lineExclusions: { type: 'array', items: { type: 'string' } },
        tenderPopulation: { type: 'string' },
        cashReconciliationScope: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

/**
 * Operational Analytics / Reporting Demo Pack (RPT-DEMO-1) — sections:
 * sales, cash, inventory, workforce, kds. Same shape family as
 * `dailyTradingReportSchema` for sales/cash (bigint-as-decimal-string money,
 * nullable via `nullable()`), plus the three new sections. Verified against
 * `OperationalOverviewService`'s `OperationalOverviewView`, not against the
 * Prisma schema or the SRS.
 */
const operationalOverviewSchema = {
  type: 'object',
  properties: {
    branchId: uuidSchema(),
    businessDay: businessDaySchema(),
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
    currencySource: {
      type: 'string',
      enum: ['TRANSACTION', 'BRANCH_FALLBACK'],
    },
    dataAsOf: isoDateTimeSchema(),
    periodStatus: { type: 'string', enum: ['OPEN', 'UNSEALED', 'SETTLED'] },
    branchCurrentBusinessDay: businessDaySchema(),
    sales: {
      type: 'object',
      properties: {
        grossSales: moneyStringSchema(),
        netSales: moneyStringSchema(),
        discounts: moneyStringSchema(),
        refunds: moneyStringSchema(),
        taxTotal: moneyStringSchema(),
        completedOrderCount: { type: 'integer' },
        openOrderCount: { type: 'integer' },
        averageOrderValue: nullable(moneyStringSchema()),
        tenderTotals: {
          type: 'object',
          properties: {
            cash: tenderFamilyTotalsSchema,
            manualExternalCard: tenderFamilyTotalsSchema,
            tenderGrandTotal: moneyStringSchema(),
            cashDrawerContribution: moneyStringSchema(),
            paymentCount: { type: 'integer' },
            completedExcessCapturedTotal: moneyStringSchema(),
            unsettledCapturedTotal: moneyStringSchema(),
          },
        },
      },
    },
    cash: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['WHOLE_SESSION'] },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              cashSessionId: uuidSchema(),
              status: { type: 'string', enum: ['open', 'closing', 'closed'] },
              currency: { type: 'string', example: 'AED' },
              openingFloat: moneyStringSchema(),
              expectedCash: nullable(moneyStringSchema()),
              countedCash: nullable(moneyStringSchema()),
              variance: nullable(moneyStringSchema()),
              payInTotal: moneyStringSchema(),
              payOutTotal: moneyStringSchema(),
              safeDropTotal: moneyStringSchema(),
              isFinalised: { type: 'boolean' },
            },
          },
        },
        contributingSessionCount: { type: 'integer' },
        closedSessionCount: { type: 'integer' },
        unclosedSessionCount: { type: 'integer' },
      },
    },
    inventory: {
      type: 'object',
      properties: {
        lowStockItemCount: { type: 'integer' },
        waste: {
          type: 'object',
          properties: {
            windowFrom: isoDateTimeSchema(),
            windowTo: isoDateTimeSchema(),
            recordCount: { type: 'integer' },
            quantityTotal: decimalStringSchema(),
            valueTotal: moneyStringSchema(),
          },
        },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    workforce: {
      type: 'object',
      properties: {
        windowFrom: isoDateTimeSchema(),
        windowTo: isoDateTimeSchema(),
        clockedInCount: { type: 'integer' },
        attendanceRecordCount: { type: 'integer' },
        lateArrivalCount: { type: 'integer' },
        earlyDepartureCount: { type: 'integer' },
        unscheduledCount: { type: 'integer' },
        outsideGeofenceCount: { type: 'integer' },
        missingClockOutCount: { type: 'integer' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    kds: {
      type: 'object',
      properties: {
        ticketCount: { type: 'integer' },
        statusCounts: {
          type: 'object',
          additionalProperties: { type: 'integer' },
        },
        measuredPrepDurationCount: { type: 'integer' },
        averagePrepDurationSeconds: nullable({ type: 'number' }),
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    scope: {
      type: 'object',
      properties: { notes: { type: 'array', items: { type: 'string' } } },
    },
  },
};

/**
 * Minimum Operational Reporting — Internal-MVP branch daily-trading read
 * surface (RPT-R1/R2/R3, governance register "Minimum Operational Reporting
 * Ratification — 2026-08-31"). Reporting's FIRST route:
 *
 *   GET /reports/branches/{branchId}/daily-trading/{businessDay}
 *
 * A SECOND route, `GET /reports/branches/{branchId}/overview`
 * (RPT-DEMO-1, Operational Analytics / Reporting Demo Pack), reuses this
 * same guard chain and these same two permissions — see
 * `getOperationalOverview` below and `OperationalOverviewService`.
 *
 * Dashboard-only (no `@AllowPosSession` — a PIN/POS session is refused by
 * `JwtAuthGuard`'s existing default), read-only, ZERO query parameters, no
 * `Idempotency-Key`/`If-Match`/`ETag`, `Cache-Control: no-store`, and NO
 * business audit entry for this ordinary GET (FR-AUD-001 binds
 * state-changing operations; this route changes nothing).
 *
 * Guard chain: `JwtAuthGuard` (401) → `TenantContextGuard` (403, no active
 * tenant context) → `PermissionGuard` (403, BOTH `report.view.sales` AND
 * `report.view.financial` — AND semantics, the missing code never named).
 * There is deliberately NO branch-scoping guard here: the single-active-
 * branch fail-closed assertion executes INSIDE the report's own
 * RepeatableRead transaction (design correction §8) — see
 * `DailyTradingReportService`.
 *
 * FR-RPT-001/002/003/005 remain NOT IMPLEMENTED by this route — see the
 * response's own `scope.notes` and the implementation report for the full
 * requirement classification. This is query-time aggregation over the
 * transactional primary for exactly one tenant with exactly one active
 * branch (Internal-MVP scope, RPT-R2).
 */
@ApiTags('reporting')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@RequirePermission(
  REPORTING_PERMISSIONS.VIEW_SALES,
  REPORTING_PERMISSIONS.VIEW_FINANCIAL,
)
@Controller('reports')
export class ReportingController {
  constructor(
    private readonly reportService: DailyTradingReportService,
    private readonly overviewService: OperationalOverviewService,
  ) {}

  @Get('branches/:branchId/daily-trading/:businessDay')
  @AuthorizationTarget(branchFromParam('branchId'))
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Branch daily-trading report (dashboard-only; authorized against the branch it names).',
    description:
      'Financially-correct, read-only, query-time aggregation over the ' +
      'transactional primary — NOT a read replica, NOT a rollup, NOT a ' +
      'cache (FR-RPT-001/002/003/005 remain NOT IMPLEMENTED). Requires ' +
      'BOTH report.view.sales and report.view.financial (AND), held by a ' +
      'single role assignment whose scope COVERS this branch (FR-SEC-004). ' +
      'The Internal-MVP single-active-branch restriction is retired: a tenant ' +
      'may have any number of active branches. Refused (403) if the branch is ' +
      'not active, or if the tenant still holds unreviewed role assignments ' +
      'inherited from the scoped-RBAC migration. A future businessDay is 400, never ' +
      'an all-zeros OPEN report. Cash Reconciliation is WHOLE_SESSION scope ' +
      'and PARTIAL (zero-payment/movement-only sessions are not ' +
      'attributable to a business day and are not listed; no day-level ' +
      'variance/expected/counted/movement total is ever emitted). Tax is ' +
      'broken down by class only, never by rate. Money is a decimal ' +
      '(minor-unit) string on the wire, never a JSON number. ' +
      'tenderTotals.completedExcessCapturedTotal (acceptance correction, ' +
      '2026-08-31) is captured payment value above a completed order’s ' +
      'grand total — P1F-2 permits paidTotal > grandTotal on completion; ' +
      'this term is reconciliation-only, with no revenue/tax/tip/discount/ ' +
      'refund/rounding/variance disposition inferred, and it makes ' +
      'tenderGrandTotal === grossSales + unsettledCapturedTotal + ' +
      'completedExcessCapturedTotal hold exactly.',
  })
  @ApiOkResponse({
    description:
      'The daily-trading report: salesSummary, tenderTotals (incl. ' +
      'completedExcessCapturedTotal), taxSummary, cashReconciliation ' +
      '(WHOLE_SESSION scope), dataAsOf, periodStatus (OPEN/UNSEALED/SETTLED ' +
      '— no SEALED, no FUTURE), currency/currencySource, and a scope block ' +
      'disclosing exactly what this Internal-MVP slice does and does not ' +
      'cover.',
    schema: dailyTradingReportSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Malformed branchId/businessDay, any query parameter, or ' +
      "businessDay is after the branch's current business day " +
      '("Future business days are not supported.").',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({
    description:
      'A PIN/POS session; no active tenant context; report.view.sales and ' +
      'report.view.financial are not both held by one assignment covering ' +
      'this branch; the branch is not active; or the tenant still holds ' +
      'unreviewed migration-inherited role assignments (scopeReviewRequired).',
  })
  @ApiNotFoundResponse({
    description:
      'branchId is unknown or belongs to another tenant — byte-identical ' +
      'response for both, so a caller cannot learn a foreign branch exists.',
  })
  @ApiConflictResponse({
    description:
      'More than one transaction currency was observed for this business ' +
      "day, a contributing cash session's currency disagrees with the " +
      "report's currency, or an internal cash-reconciliation invariant " +
      'was violated. No partial financial total is ever returned on a 409.',
  })
  async getDailyTradingReport(
    @Param() params: DailyTradingReportParamsDto,
    @Query() _query: DailyTradingReportQueryDto,
    @CurrentTenantContext() context: TenantContext,
  ) {
    return this.reportService.build({
      tenantId: context.tenantId,
      userId: context.userId,
      branchId: params.branchId,
      businessDay: parseBusinessDay(params.businessDay),
    });
  }

  @Get('branches/:branchId/overview')
  @AuthorizationTarget(branchFromParam('branchId'))
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Branch operational overview — sales, cash, inventory, workforce, kds (dashboard-only; authorized against the branch it names).',
    description:
      'Operational Analytics / Reporting Demo Pack (RPT-DEMO-1). Read-only, ' +
      'query-time aggregation over the transactional primary — NOT a read ' +
      'replica, NOT a rollup, NOT a cache. Requires BOTH report.view.sales ' +
      'and report.view.financial (AND), held by a single role assignment ' +
      'whose scope COVERS this branch, exactly like daily-trading — no new ' +
      'permission code is introduced. sales/cash reuse daily-trading’s exact ' +
      'population/formulas and gates (branch existence, unreviewed-migration ' +
      'scope review, operative-branch, future-day 400). inventory/workforce ' +
      'use a CALENDAR-day window (not the POS business day — neither carries ' +
      'a business-day column); kds uses the SAME business day as sales/cash ' +
      '(kitchen.tickets does carry one). Every section’s `notes` discloses ' +
      'its own time model and any metric deliberately omitted for lack of ' +
      'real source data (e.g. KDS fulfilment/serving time — servedAt is ' +
      'never populated by any write path).',
  })
  @ApiOkResponse({
    description:
      'The operational overview: sales, cash (WHOLE_SESSION scope, ' +
      'unchanged from daily-trading), inventory (branch-scoped low-stock ' +
      'count + calendar-day waste), workforce (branch-scoped calendar-day ' +
      'attendance summary), kds (business-day ticket counts + real prep ' +
      'duration where measurable), and a scope block disclosing exactly ' +
      'what this Demo/Operational slice does and does not cover.',
    schema: operationalOverviewSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Malformed branchId/businessDay, any other query parameter, or ' +
      "businessDay is after the branch's current business day.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({
    description:
      'A PIN/POS session; no active tenant context; report.view.sales and ' +
      'report.view.financial are not both held by one assignment covering ' +
      'this branch; the branch is not active; or the tenant still holds ' +
      'unreviewed migration-inherited role assignments (scopeReviewRequired).',
  })
  @ApiNotFoundResponse({
    description:
      'branchId is unknown or belongs to another tenant — byte-identical ' +
      'response for both, so a caller cannot learn a foreign branch exists.',
  })
  @ApiConflictResponse({
    description:
      'More than one transaction currency was observed for this business ' +
      "day, a contributing cash session's currency disagrees with the " +
      'report’s currency, or an internal cash-reconciliation invariant was ' +
      'violated. No partial financial total is ever returned on a 409.',
  })
  async getOperationalOverview(
    @Param() params: OperationalOverviewParamsDto,
    @Query() query: OperationalOverviewQueryDto,
    @CurrentTenantContext() context: TenantContext,
  ) {
    return this.overviewService.build({
      tenantId: context.tenantId,
      userId: context.userId,
      branchId: params.branchId,
      businessDay: parseBusinessDay(query.businessDay),
    });
  }
}

/**
 * Parse a `YYYY-MM-DD` path value into the UTC midnight a DATE holds.
 * Deliberately mirrors `orders.controller.ts`'s own private `parseBusinessDay`
 * rather than importing it — the established repository convention for this
 * small, dependency-free validator (see e.g. `ticket-bumped.handler.ts`'s
 * identical private copy), not a second business-day ALGORITHM: this only
 * validates a calendar-date STRING shape, it never derives a business day
 * from a branch's timezone/cutover (that remains Sales' single
 * `resolveBusinessDay` implementation, reused via `DAILY_TRADING_SALES_QUERY`).
 */
function parseBusinessDay(value: string): Date {
  const [y, m, d] = value.split('-').map((p) => Number.parseInt(p, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new BadRequestException(`${value} is not a real calendar date.`);
  }
  return date;
}
