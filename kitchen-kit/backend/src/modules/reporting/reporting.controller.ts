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
import {
  DailyTradingReportParamsDto,
  DailyTradingReportQueryDto,
} from './reporting.dto';
import { REPORTING_PERMISSIONS } from './reporting.permissions';

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
 * Minimum Operational Reporting — Internal-MVP branch daily-trading read
 * surface (RPT-R1/R2/R3, governance register "Minimum Operational Reporting
 * Ratification — 2026-08-31"). Reporting's FIRST and ONLY route:
 *
 *   GET /reports/branches/{branchId}/daily-trading/{businessDay}
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
  constructor(private readonly reportService: DailyTradingReportService) {}

  @Get('branches/:branchId/daily-trading/:businessDay')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Branch daily-trading report (Internal-MVP: dashboard-only, one tenant, exactly one active branch).',
    description:
      'Financially-correct, read-only, query-time aggregation over the ' +
      'transactional primary — NOT a read replica, NOT a rollup, NOT a ' +
      'cache (FR-RPT-001/002/003/005 remain NOT IMPLEMENTED). Requires ' +
      'BOTH report.view.sales and report.view.financial (AND). Refused ' +
      "(403) unless the caller's tenant has EXACTLY ONE active branch and " +
      'the supplied branchId equals it. A future businessDay is 400, never ' +
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
      'A PIN/POS session; no active tenant context; missing either ' +
      'report.view.sales or report.view.financial; the tenant has zero or ' +
      'more than one active branch; or branchId is visible in the tenant ' +
      'but is not that single active branch.',
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
