/**
 * DayClose — Migration 35, Internal-MVP operational business-day close
 * (FR-FIN-020/021/023/024).
 *
 * Authority (CONTROLLING, in order):
 *   docs/governance/GOVERNANCE_DECISION_REGISTER.md, "Day Close
 *   Ratification — 2026-08-31" (DC-R1, DC-R2, DC-R3) — BINDING.
 *   docs/reports/claude/2026-08-31_DAYCLOSE-final-design-gate.md
 *   docs/reports/claude/2026-08-31_DAYCLOSE-design-gate-acceptance-correction.md
 *   docs/reports/claude/2026-08-31_DAYCLOSE-pre-ratification-final-correction.md
 *   docs/reports/claude/2026-08-31_DAYCLOSE-activation-mechanic-final-correction.md
 *
 * ── ONE TRANSACTION, TWO COMMITTED OUTCOMES (activation-mechanic final
 *    correction §4) ─────────────────────────────────────────────────────
 * The first DayClose request for a branch ACTIVATES it (writes the
 * immutable epoch, commits, returns `outcome: 'ACTIVATED'`) — it NEVER
 * throws on this path (R-6(a)'s lesson: a durable decision must not be
 * discarded by a thrown 4xx, which would also release the idempotency
 * reservation and let a replay repeat the write). A later request, once
 * `activationBusinessDay < target < currentBusinessDay`, performs a real
 * close and returns `outcome: 'CLOSED'`.
 *
 * ── READ COMMITTED, NOT SERIALIZABLE (pre-ratification final correction
 *    §4.3) ──────────────────────────────────────────────────────────────
 * SERIALIZABLE would not abort the Order-create/DayClose cutover race and
 * would be unsafe combined with the shared advisory-lock wait. Coherence
 * for the target day is supplied by the SHARED
 * `ros_order_number(branchId, businessDay)` fence (§4.4) — the exact
 * primitive `allocateOrderNumber` already uses — never a second lock
 * namespace, never SERIALIZABLE.
 *
 * ── Z-NUMBER RETRY (final design gate §13, pre-ratification correction
 *    §4.4) ──────────────────────────────────────────────────────────────
 * `MAX(z_number)+1` inside the transaction; `UNIQUE(tenant,branch,
 * z_number)` is the structural backstop for a transient allocation
 * collision between two DIFFERENT past days closing concurrently at one
 * branch (different fence keys, so they do not serialise against each
 * other). Any `P2002` on the `day_closes`/`day_close_activations` insert —
 * whichever unique constraint fired — is handled by ONE LOCAL BOUNDED
 * RETRY of the ENTIRE command from a FRESH transaction (`post()` below):
 * the retry's own pre-check re-reads the table and either finds the day
 * genuinely already closed (terminal 409, no further retry needed) or
 * recomputes a fresh Z number / re-reads the now-committed activation row.
 * No advisory lock is added for numbering; `UnitOfWork` is not modified.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import type { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import { newId } from '../../../common/ids';
import { divideRounded } from '../../../common/money/rounding';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import {
  BRANCH_CURRENCY_QUERY,
  BRANCH_REPORTING_SCOPE_QUERY,
} from '../../organisation/contract';
import type {
  BranchCurrencyQuery,
  BranchReportingScopeQuery,
} from '../../organisation/contract';
import {
  DAILY_TRADING_SALES_QUERY,
  DAY_CLOSE_SALES_FACTS_QUERY,
} from '../../sales/contract';
import type {
  DailyTradingSalesQuery,
  DayCloseSalesFacts,
  DayCloseSalesFactsQuery,
} from '../../sales/contract';
import { DAY_CLOSED_EVENT_TYPE, DAY_CLOSED_EVENT_VERSION } from '../contract';
import type { DayClosedPayload } from '../contract';
import { TREASURY_PERMISSIONS } from '../treasury.permissions';
import {
  SCOPE_AUTHORIZATION,
  SCOPE_REVIEW_QUERY,
  type ScopeAuthorizationActor,
  type ScopeAuthorizationPort,
  type ScopeReviewQuery,
} from '../../identity/contract';

const FENCE_KEY = 'ros_order_number';
const MAX_ATTEMPTS = 5;

export interface DayCloseActor {
  readonly employeeId?: string;
  readonly terminalId?: string;
}

export interface PostDayCloseInput {
  readonly branchId: string;
  readonly businessDay: Date;
}

export type DayClosePostResult =
  | {
      readonly outcome: 'ACTIVATED';
      readonly branchId: string;
      readonly businessDay: string;
      readonly activationBusinessDay: string;
      readonly firstEligibleBusinessDay: string;
    }
  | {
      readonly outcome: 'CLOSED';
      readonly branchId: string;
      readonly businessDay: string;
      readonly activationBusinessDay: string;
      readonly firstEligibleBusinessDay: string;
      readonly dayClose: DayCloseView;
    };

export interface DayCloseView {
  readonly id: string;
  readonly branchId: string;
  readonly businessDay: string;
  readonly zNumber: string;
  readonly dataAsOf: string;
  readonly closedAt: string;
  readonly currency: string;
  readonly salesSummary: {
    readonly grossSales: string;
    readonly discounts: string;
    readonly refunds: string;
    readonly taxTotal: string;
    readonly netSales: string;
    readonly completedOrderCount: number;
    readonly averageOrderValue: string | null;
  };
  readonly tenderTotals: {
    readonly cash: {
      amountTotal: string;
      roundingAdjustmentTotal: string;
      paymentCount: number;
    };
    readonly manualExternalCard: { amountTotal: string; paymentCount: number };
    readonly unsettledCapturedTotal: string;
    readonly completedExcessCapturedTotal: string;
  };
  readonly taxByClass: readonly {
    readonly taxClassId: string;
    readonly taxAmount: string;
    readonly netAmount: string;
    readonly grossAmount: string;
    readonly lineCount: number;
  }[];
  readonly salesByOrderType: readonly {
    readonly orderType: string;
    readonly grossSales: string;
    readonly netSales: string;
    readonly orderCount: number;
  }[];
  readonly voidAndCompSummary: {
    readonly voidedLineCount: number;
    readonly voidedLineValue: string;
    readonly compLineCount: number;
    readonly compLineValue: string;
  };
  readonly cashReconciliation: {
    readonly scope: 'WHOLE_SESSION';
    readonly sessionCount: number;
    readonly varianceOwnerSessionCount: number;
    readonly varianceTotal: string;
    readonly sessions: readonly {
      readonly cashSessionId: string;
      readonly isVarianceOwner: boolean;
      readonly businessDayCount: number;
      readonly dayScoped: {
        readonly cashSalesTotal: string;
        readonly cashRoundingAdjustments: string;
        readonly manualExternalCardTotal: string;
        readonly paymentCount: number;
      };
      readonly wholeSession: {
        readonly openingFloat: string;
        readonly expectedCash: string;
        readonly countedCash: string;
        readonly variance: string;
      };
    }[];
  };
  readonly closedBy: {
    readonly userId: string;
    readonly employeeId: string | null;
  };
  readonly scope: {
    readonly notImplemented: readonly string[];
    readonly partial: readonly string[];
    readonly notes: readonly string[];
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

const SCOPE_BLOCK = {
  notImplemented: [
    'FR-FIN-022: tax by rate (only the component sum is persisted)',
    'FR-FIN-022: sales by category (no category snapshot on order_lines)',
    'FR-FIN-022: comp summary (structurally zero — no comp mechanism exists)',
    'FR-FIN-026: fiscal document finalisation (no fiscal document capability exists; CARRIED ITEM P1C-1 untouched)',
    'FR-FIN-026: inventory day-end snapshot',
    'FR-FIN-026: report pre-aggregation (excluded by RPT-R2)',
    'FR-FIN-026: accounting export generation (no transactional outbox exists — FR-PLT-041)',
    'FR-FIN-025: automatic close (no scheduler)',
  ],
  partial: [
    'FR-FIN-022: sales by tender — only cash and manual_external_card are implemented tender families',
  ],
  notes: [
    'This is the Internal-MVP operational DayClose aggregate (FR-FIN-020/021/023/024, complete). It is NOT a claim that FR-FIN-020…026 or the Z report are complete — see notImplemented/partial above.',
  ],
} as const;

@Injectable()
export class DayCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(SCOPE_REVIEW_QUERY)
    private readonly scopeReview: ScopeReviewQuery,
    @Inject(SCOPE_AUTHORIZATION)
    private readonly scopeAuthorization: ScopeAuthorizationPort,
    @Inject(BRANCH_REPORTING_SCOPE_QUERY)
    private readonly branchScope: BranchReportingScopeQuery,
    @Inject(BRANCH_CURRENCY_QUERY)
    private readonly branchCurrency: BranchCurrencyQuery,
    @Inject(DAILY_TRADING_SALES_QUERY)
    private readonly businessDayQuery: DailyTradingSalesQuery,
    @Inject(DAY_CLOSE_SALES_FACTS_QUERY)
    private readonly salesFacts: DayCloseSalesFactsQuery,
  ) {}

  // =============================================================== POST ===

  async post(
    tenantId: string,
    actorUserId: string,
    actor: DayCloseActor,
    auth: ScopeAuthorizationActor,
    input: PostDayCloseInput,
  ): Promise<DayClosePostResult> {
    const correlationId = newId();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.unitOfWork.execute(
          { userId: actorUserId, tenantId },
          (ctx) => this.attempt(tenantId, actorUserId, actor, auth, input, ctx),
          { correlationId },
        );
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) {
          continue;
        }
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'Could not complete the day close after several attempts — retry.',
          );
        }
        throw err;
      }
    }
  }

  private async attempt(
    tenantId: string,
    actorUserId: string,
    actor: DayCloseActor,
    auth: ScopeAuthorizationActor,
    input: PostDayCloseInput,
    ctx: UnitOfWorkContext,
  ): Promise<DayClosePostResult> {
    const tx = ctx.tx;
    const branchId = input.branchId;
    const targetBusinessDay = input.businessDay;

    // ── D-2 branch security (tenant-shape, NOT branch-aware RBAC) —────────
    // executes INSIDE this write transaction (§16 of the final design gate).
    const branch = await this.branchCurrency.find(tx, { tenantId, branchId });
    if (!branch) {
      throw new NotFoundException('Branch not found.');
    }
    // ── M-4+ GATE, then the operative-branch assertion — B1-3 §11 ─────────
    //
    // The Internal-MVP SINGLE-ACTIVE-BRANCH mask is RETIRED here, on the same
    // ratified conditions as Reporting's (clause 13 / ADR 0009 D-11): the scoped
    // foundation exists, this route now carries a BRANCH target, and a tenant
    // whose INHERITED grants are still unreviewed fails CLOSED — because those
    // migration-originated TENANT assignments cover every branch, so lifting the
    // mask for such a tenant would hand it authority nobody reviewed.
    if (await this.scopeReview.hasUnreviewedInheritedAssignments(tx)) {
      throw new ForbiddenException(
        'This tenant still holds role assignments inherited from the ' +
          'pre-scoped-RBAC migration that have not been reviewed. Review or ' +
          're-scope them before closing a business day — GET /auth/permissions ' +
          'reports scopeReviewRequired, and POST ' +
          '/auth/role-assignments/{assignmentId}/review records the outcome.',
      );
    }
    if (
      !(await this.branchScope.isOperativeBranch(tx, { tenantId, branchId }))
    ) {
      throw new ForbiddenException('This branch is not active.');
    }
    // Defence in depth, IN THIS TRANSACTION and AT THIS BRANCH. The route guard
    // already authorized `cash.day.close` against the same branch target; doing
    // it again inside the write transaction closes the window between the
    // guard's decision and the close itself, and — since B1-2 narrowed the flat
    // permission set to TENANT scope — it is the only form of this check that a
    // legitimately branch-scoped closer can satisfy.
    if (
      !(await this.scopeAuthorization.isAuthorized(
        auth,
        { codes: [TREASURY_PERMISSIONS.CASH_DAY_CLOSE], mode: 'all' },
        { type: 'branch', branchId },
        tx,
      ))
    ) {
      throw new ForbiddenException(
        `Closing the business day requires '${TREASURY_PERMISSIONS.CASH_DAY_CLOSE}'.`,
      );
    }

    // ── 1. acquire the SHARED (branch, targetBusinessDay) fence — the
    //    EXISTING `ros_order_number` advisory lock Order creation already
    //    takes. No second lock namespace. ────────────────────────────────
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      FENCE_KEY,
      `${branchId}:${targetBusinessDay.toISOString().slice(0, 10)}`,
    );

    // ── the branch's current business day, under the fence, live clock ────
    const branchCurrentBusinessDay =
      await this.businessDayQuery.currentBusinessDay(tx, {
        tenantId,
        branchId,
      });

    // ── 2. activation — read or create, on a path that COMMITS ───────────
    let activationBusinessDay: Date;
    const existingActivation = await tx.dayCloseActivation.findUnique({
      where: { tenantId_branchId: { tenantId, branchId } },
      select: { activationBusinessDay: true },
    });
    if (!existingActivation) {
      activationBusinessDay = branchCurrentBusinessDay;
      const activation = await tx.dayCloseActivation.create({
        data: {
          id: newId(),
          tenantId,
          branchId,
          activationBusinessDay,
          activatedBy: actorUserId,
          activatedByEmployeeId: actor.employeeId ?? null,
        },
      });
      await this.audit.record(tx, {
        tenantId,
        action: AUDIT_ACTION.DAY_CLOSE_ACTIVATED,
        entityType: AUDIT_ENTITY.DAY_CLOSE_ACTIVATION,
        actorType: 'user',
        actorId: actorUserId,
        entityId: activation.id,
        terminalId: actor.terminalId ?? null,
        metadata: {
          branchId,
          activationBusinessDay: dateStr(activationBusinessDay),
          firstEligibleBusinessDay: dateStr(addDays(activationBusinessDay, 1)),
        },
      });
      // §4.2 of the activation-mechanic correction: on the FIRST request,
      // eligibility is `A < target < A` — an EMPTY interval — so ACTIVATED
      // is always this request's outcome. COMMITS here; never throws.
      return {
        outcome: 'ACTIVATED',
        branchId,
        businessDay: dateStr(targetBusinessDay),
        activationBusinessDay: dateStr(activationBusinessDay),
        firstEligibleBusinessDay: dateStr(addDays(activationBusinessDay, 1)),
      };
    }
    activationBusinessDay = existingActivation.activationBusinessDay;
    const firstEligibleBusinessDay = addDays(activationBusinessDay, 1);

    // ── 3. closeable-day rule (design-gate acceptance correction §2.3) ────
    if (targetBusinessDay.getTime() > branchCurrentBusinessDay.getTime()) {
      throw new BadRequestException('Future business days are not supported.');
    }
    if (targetBusinessDay.getTime() === branchCurrentBusinessDay.getTime()) {
      throw new ConflictException(
        'The current business day cannot yet be closed.',
      );
    }
    if (targetBusinessDay.getTime() <= activationBusinessDay.getTime()) {
      throw new ConflictException(
        `That business day is outside the authoritative DayClose epoch for this branch. ` +
          `The first eligible business day is ${dateStr(firstEligibleBusinessDay)}.`,
      );
    }

    // ── 4. confirm no persisted DayClose exists for this branch-day ───────
    const existing = await tx.dayClose.findUnique({
      where: {
        tenantId_branchId_businessDay: {
          tenantId,
          branchId,
          businessDay: targetBusinessDay,
        },
      },
      select: { id: true, zNumber: true, closedAt: true },
    });
    if (existing) {
      throw new ConflictException(
        `That business day is already closed (Z${existing.zNumber.toString()}, ` +
          `${existing.closedAt.toISOString()}).`,
      );
    }

    // ── 5. Sales facts — includes the zero-open-target-day-orders read ────
    const sales = await this.salesFacts.facts(tx, {
      tenantId,
      branchId,
      businessDay: targetBusinessDay,
    });
    if (sales.openOrderIds.length > 0) {
      throw new ConflictException({
        message:
          'This business day cannot be closed while it has orders that are ' +
          'not yet completed or cancelled.',
        blockingOrderIds: sales.openOrderIds,
      });
    }

    // ── 6. confirm zero branch open/closing CashSessions — FR-FIN-021,
    //    IN FULL, unqualified by business day, over EVERY branch session. ──
    const blockingSessions = await tx.cashSession.findMany({
      where: { tenantId, branchId, status: { not: 'closed' } },
      select: { id: true, status: true },
    });
    if (blockingSessions.length > 0) {
      throw new ConflictException({
        message:
          'This business day cannot be closed while any cash session at ' +
          'this branch remains open.',
        blockingSessions,
      });
    }

    // ── 7. currency resolution — historical transaction currency, the
    //    accepted Reporting precedent verbatim. ───────────────────────────
    const observedCurrencies = new Set<string>([
      ...sales.orderCurrencies,
      ...sales.paymentCurrencies,
    ]);
    let currency: string;
    if (observedCurrencies.size > 1) {
      throw new ConflictException(
        'Multiple transaction currencies were observed for this business day.',
      );
    } else if (observedCurrencies.size === 1) {
      [currency] = observedCurrencies;
    } else {
      currency = branch.baseCurrency;
    }

    // ── linked-session set (DC-R2) — union of day-scoped tender
    //    contributors and this day's variance owners. Both sourced from
    //    tables/queries this transaction already read; both populations are
    //    guaranteed CLOSED by step 6. ────────────────────────────────────
    const ownerSessions = await tx.cashSession.findMany({
      where: { tenantId, branchId, closedBusinessDay: targetBusinessDay },
      select: { id: true },
    });
    const linkedIds = new Set<string>([
      ...sales.contributingCashSessionIds,
      ...ownerSessions.map((s) => s.id),
    ]);
    const linkedSessions =
      linkedIds.size === 0
        ? []
        : await tx.cashSession.findMany({
            where: { tenantId, id: { in: [...linkedIds] } },
            select: {
              id: true,
              currency: true,
              openingFloat: true,
              expectedCash: true,
              countedCash: true,
              variance: true,
              closedBusinessDay: true,
            },
          });
    const tenderBySession = new Map(
      sales.sessionTenderTotals.map((s) => [s.cashSessionId, s]),
    );
    for (const s of linkedSessions) {
      if (s.currency !== currency) {
        throw new ConflictException(
          "A contributing cash session's currency disagrees with this DayClose's transaction currency.",
        );
      }
    }

    let varianceTotal = 0n;
    let varianceOwnerSessionCount = 0;
    const sessionRows = linkedSessions.map((s) => {
      const isVarianceOwner =
        s.closedBusinessDay !== null &&
        s.closedBusinessDay.getTime() === targetBusinessDay.getTime();
      const wholeVariance = s.variance ?? 0n;
      if (isVarianceOwner) {
        varianceTotal += wholeVariance;
        varianceOwnerSessionCount += 1;
      }
      const dayScoped = tenderBySession.get(s.id);
      return {
        cashSessionId: s.id,
        isVarianceOwner,
        dayScopedCashSalesTotal: dayScoped?.cashSalesTotal ?? 0n,
        dayScopedCashRoundingAdjustments:
          dayScoped?.cashRoundingAdjustments ?? 0n,
        dayScopedManualExternalCardTotal:
          dayScoped?.manualExternalCardTotal ?? 0n,
        dayScopedPaymentCount: dayScoped?.paymentCount ?? 0,
        businessDayCount: dayScoped?.businessDayCount ?? 0,
        wholeSessionOpeningFloat: s.openingFloat,
        wholeSessionExpectedCash: s.expectedCash ?? 0n,
        wholeSessionCountedCash: s.countedCash ?? 0n,
        wholeSessionVariance: wholeVariance,
      };
    });

    // ── 8/9. z-number, snapshot values ─────────────────────────────────────
    const zAgg = await tx.dayClose.aggregate({
      where: { tenantId, branchId },
      _max: { zNumber: true },
    });
    const zNumber = (zAgg._max.zNumber ?? 0n) + 1n;

    const [{ dataAsOf }] = await tx.$queryRaw<{ dataAsOf: Date }[]>`
      SELECT transaction_timestamp() AS "dataAsOf"
    `;

    const netSales =
      sales.grossSales - sales.discounts - sales.refunds - sales.taxTotal;
    const averageOrderValue =
      sales.completedOrderCount === 0
        ? null
        : divideRounded(netSales, BigInt(sales.completedOrderCount));

    // ── 10. persist — insert-once immutable root + children ───────────────
    const dayCloseId = newId();
    // A `P2002` here (either `uq_day_closes_branch_business_day` — someone
    // else just closed this exact day — or `uq_day_closes_branch_z_number`
    // — a transient allocation collision) propagates out of this
    // transaction uncaught and is handled by `post()`'s bounded retry: the
    // retry's own step 4/8 above re-reads the table fresh and either
    // returns the terminal 409 or recomputes a fresh Z number.
    const created = await tx.dayClose.create({
      data: {
        id: dayCloseId,
        tenantId,
        branchId,
        businessDay: targetBusinessDay,
        zNumber,
        dataAsOf,
        closedBy: actorUserId,
        closedByEmployeeId: actor.employeeId ?? null,
        currency,
        grossSalesMinor: sales.grossSales,
        discountsMinor: sales.discounts,
        refundsMinor: sales.refunds,
        taxTotalMinor: sales.taxTotal,
        netSalesMinor: netSales,
        completedOrderCount: sales.completedOrderCount,
        averageOrderValueMinor: averageOrderValue,
        cashAmountTotalMinor: sales.cash.amountTotal,
        cashRoundingAdjustmentTotalMinor: sales.cash.roundingAdjustmentTotal,
        cashPaymentCount: sales.cash.paymentCount,
        cardAmountTotalMinor: sales.manualExternalCard.amountTotal,
        cardPaymentCount: sales.manualExternalCard.paymentCount,
        unsettledCapturedTotalMinor: sales.unsettledCapturedTotal,
        completedExcessCapturedTotalMinor: sales.completedExcessCapturedTotal,
        voidedLineCount: sales.voidSummary.voidedLineCount,
        voidedLineValueMinor: sales.voidSummary.voidedLineValueMinorUnits,
        sessionCount: sessionRows.length,
        varianceOwnerSessionCount,
        varianceTotalMinor: varianceTotal,
      },
    });

    if (sales.taxByClass.length > 0) {
      await tx.dayCloseTaxClassTotal.createMany({
        data: sales.taxByClass.map((t) => ({
          id: newId(),
          tenantId,
          dayCloseId,
          taxClassId: t.taxClassId,
          taxAmountMinor: t.taxAmount,
          netAmountMinor: t.netAmount,
          grossAmountMinor: t.grossAmount,
          lineCount: t.lineCount,
        })),
      });
    }
    if (sales.salesByOrderType.length > 0) {
      await tx.dayCloseOrderTypeTotal.createMany({
        data: sales.salesByOrderType.map((t) => ({
          id: newId(),
          tenantId,
          dayCloseId,
          orderType: t.orderType,
          grossSalesMinor: t.grossSales,
          netSalesMinor: t.netSales,
          orderCount: t.orderCount,
        })),
      });
    }
    if (sessionRows.length > 0) {
      await tx.dayCloseSession.createMany({
        data: sessionRows.map((s) => ({
          id: newId(),
          tenantId,
          dayCloseId,
          cashSessionId: s.cashSessionId,
          isVarianceOwner: s.isVarianceOwner,
          dayScopedCashSalesTotalMinor: s.dayScopedCashSalesTotal,
          dayScopedCashRoundingAdjustmentsMinor:
            s.dayScopedCashRoundingAdjustments,
          dayScopedManualExternalCardTotalMinor:
            s.dayScopedManualExternalCardTotal,
          dayScopedPaymentCount: s.dayScopedPaymentCount,
          businessDayCount: s.businessDayCount,
          wholeSessionOpeningFloatMinor: s.wholeSessionOpeningFloat,
          wholeSessionExpectedCashMinor: s.wholeSessionExpectedCash,
          wholeSessionCountedCashMinor: s.wholeSessionCountedCash,
          wholeSessionVarianceMinor: s.wholeSessionVariance,
        })),
      });
    }

    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.DAY_CLOSED,
      entityType: AUDIT_ENTITY.DAY_CLOSE,
      actorType: 'user',
      actorId: actorUserId,
      entityId: dayCloseId,
      terminalId: actor.terminalId ?? null,
      metadata: {
        branchId,
        businessDay: dateStr(targetBusinessDay),
        zNumber: zNumber.toString(),
        grossSalesMinorUnits: sales.grossSales.toString(),
        netSalesMinorUnits: netSales.toString(),
        completedOrderCount: sales.completedOrderCount,
        sessionCount: sessionRows.length,
        varianceTotalMinorUnits: varianceTotal.toString(),
      },
    });

    const payload: DayClosedPayload = {
      dayCloseId,
      businessDay: dateStr(targetBusinessDay),
      zNumber: zNumber.toString(),
      currency,
      dataAsOf: dataAsOf.toISOString(),
      grossSalesMinorUnits: sales.grossSales.toString(),
      discountsMinorUnits: sales.discounts.toString(),
      refundsMinorUnits: sales.refunds.toString(),
      taxTotalMinorUnits: sales.taxTotal.toString(),
      netSalesMinorUnits: netSales.toString(),
      completedOrderCount: sales.completedOrderCount,
      averageOrderValueMinorUnits: averageOrderValue?.toString() ?? null,
      tenderTotals: [
        {
          tender: 'cash',
          amountMinorUnits: sales.cash.amountTotal.toString(),
          paymentCount: sales.cash.paymentCount,
        },
        {
          tender: 'manual_external_card',
          amountMinorUnits: sales.manualExternalCard.amountTotal.toString(),
          paymentCount: sales.manualExternalCard.paymentCount,
        },
      ],
      sessionCount: sessionRows.length,
      varianceTotalMinorUnits: varianceTotal.toString(),
      closedByUserId: actorUserId,
      closedByEmployeeId: actor.employeeId ?? null,
    };
    ctx.publishEvent({
      eventType: DAY_CLOSED_EVENT_TYPE,
      eventVersion: DAY_CLOSED_EVENT_VERSION,
      occurredAt: dataAsOf,
      branchId,
      actorId: actorUserId,
      actorType: 'user',
      idempotencyKey: `day.closed:${dayCloseId}`,
      payload,
    });

    return {
      outcome: 'CLOSED',
      branchId,
      businessDay: dateStr(targetBusinessDay),
      activationBusinessDay: dateStr(activationBusinessDay),
      firstEligibleBusinessDay: dateStr(firstEligibleBusinessDay),
      dayClose: toDayCloseView(
        {
          id: dayCloseId,
          branchId,
          businessDay: targetBusinessDay,
          zNumber,
          dataAsOf,
          closedAt: created.closedAt,
          currency,
          closedByUserId: actorUserId,
        },
        sales,
        sessionRows,
        actor,
      ),
    };
  }

  // ================================================================ GET ===

  /**
   * Historical Z retrieval — DC-R3. Persisted records ONLY; a day with no
   * DayClose row returns 404, never a retroactively-manufactured Z
   * (pre-ratification final correction §2.4).
   */
  async getHistorical(
    tenantId: string,
    branchId: string,
    businessDay: Date,
  ): Promise<DayCloseView> {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const branch = await this.branchCurrency.find(tx, { tenantId, branchId });
      if (!branch) throw new NotFoundException('Branch not found.');

      const dayClose = await tx.dayClose.findUnique({
        where: {
          tenantId_branchId_businessDay: { tenantId, branchId, businessDay },
        },
        include: {
          taxClassTotals: true,
          orderTypeTotals: true,
          sessions: true,
        },
      });
      if (!dayClose)
        throw new NotFoundException(
          'No DayClose exists for that business day.',
        );

      return toDayCloseViewFromPersisted(dayClose);
    });
  }
}

// --------------------------------------------------------------- helpers ---

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function toDayCloseView(
  created: {
    id: string;
    branchId: string;
    businessDay: Date;
    zNumber: bigint;
    dataAsOf: Date;
    closedAt: Date;
    currency: string;
    closedByUserId: string;
  },
  sales: DayCloseSalesFacts,
  sessionRows: readonly {
    cashSessionId: string;
    isVarianceOwner: boolean;
    dayScopedCashSalesTotal: bigint;
    dayScopedCashRoundingAdjustments: bigint;
    dayScopedManualExternalCardTotal: bigint;
    dayScopedPaymentCount: number;
    businessDayCount: number;
    wholeSessionOpeningFloat: bigint;
    wholeSessionExpectedCash: bigint;
    wholeSessionCountedCash: bigint;
    wholeSessionVariance: bigint;
  }[],
  actor: DayCloseActor,
): DayCloseView {
  return {
    id: created.id,
    branchId: created.branchId,
    businessDay: dateStr(created.businessDay),
    zNumber: created.zNumber.toString(),
    dataAsOf: created.dataAsOf.toISOString(),
    closedAt: created.closedAt.toISOString(),
    currency: created.currency,
    salesSummary: {
      grossSales: sales.grossSales.toString(),
      discounts: sales.discounts.toString(),
      refunds: sales.refunds.toString(),
      taxTotal: sales.taxTotal.toString(),
      netSales: (
        sales.grossSales -
        sales.discounts -
        sales.refunds -
        sales.taxTotal
      ).toString(),
      completedOrderCount: sales.completedOrderCount,
      averageOrderValue:
        sales.completedOrderCount === 0
          ? null
          : divideRounded(
              sales.grossSales -
                sales.discounts -
                sales.refunds -
                sales.taxTotal,
              BigInt(sales.completedOrderCount),
            ).toString(),
    },
    tenderTotals: {
      cash: {
        amountTotal: sales.cash.amountTotal.toString(),
        roundingAdjustmentTotal: sales.cash.roundingAdjustmentTotal.toString(),
        paymentCount: sales.cash.paymentCount,
      },
      manualExternalCard: {
        amountTotal: sales.manualExternalCard.amountTotal.toString(),
        paymentCount: sales.manualExternalCard.paymentCount,
      },
      unsettledCapturedTotal: sales.unsettledCapturedTotal.toString(),
      completedExcessCapturedTotal:
        sales.completedExcessCapturedTotal.toString(),
    },
    taxByClass: sales.taxByClass.map((t) => ({
      taxClassId: t.taxClassId,
      taxAmount: t.taxAmount.toString(),
      netAmount: t.netAmount.toString(),
      grossAmount: t.grossAmount.toString(),
      lineCount: t.lineCount,
    })),
    salesByOrderType: sales.salesByOrderType.map((t) => ({
      orderType: t.orderType,
      grossSales: t.grossSales.toString(),
      netSales: t.netSales.toString(),
      orderCount: t.orderCount,
    })),
    voidAndCompSummary: {
      voidedLineCount: sales.voidSummary.voidedLineCount,
      voidedLineValue: sales.voidSummary.voidedLineValueMinorUnits.toString(),
      compLineCount: 0,
      compLineValue: '0',
    },
    cashReconciliation: {
      scope: 'WHOLE_SESSION',
      sessionCount: sessionRows.length,
      varianceOwnerSessionCount: sessionRows.filter((s) => s.isVarianceOwner)
        .length,
      varianceTotal: sessionRows
        .filter((s) => s.isVarianceOwner)
        .reduce((sum, s) => sum + s.wholeSessionVariance, 0n)
        .toString(),
      sessions: sessionRows.map((s) => ({
        cashSessionId: s.cashSessionId,
        isVarianceOwner: s.isVarianceOwner,
        businessDayCount: s.businessDayCount,
        dayScoped: {
          cashSalesTotal: s.dayScopedCashSalesTotal.toString(),
          cashRoundingAdjustments:
            s.dayScopedCashRoundingAdjustments.toString(),
          manualExternalCardTotal:
            s.dayScopedManualExternalCardTotal.toString(),
          paymentCount: s.dayScopedPaymentCount,
        },
        wholeSession: {
          openingFloat: s.wholeSessionOpeningFloat.toString(),
          expectedCash: s.wholeSessionExpectedCash.toString(),
          countedCash: s.wholeSessionCountedCash.toString(),
          variance: s.wholeSessionVariance.toString(),
        },
      })),
    },
    closedBy: {
      userId: created.closedByUserId,
      employeeId: actor.employeeId ?? null,
    },
    scope: SCOPE_BLOCK,
  };
}

type PersistedDayClose = Prisma.DayCloseGetPayload<{
  include: { taxClassTotals: true; orderTypeTotals: true; sessions: true };
}>;

function toDayCloseViewFromPersisted(d: PersistedDayClose): DayCloseView {
  return {
    id: d.id,
    branchId: d.branchId,
    businessDay: dateStr(d.businessDay),
    zNumber: d.zNumber.toString(),
    dataAsOf: d.dataAsOf.toISOString(),
    closedAt: d.closedAt.toISOString(),
    currency: d.currency,
    salesSummary: {
      grossSales: d.grossSalesMinor.toString(),
      discounts: d.discountsMinor.toString(),
      refunds: d.refundsMinor.toString(),
      taxTotal: d.taxTotalMinor.toString(),
      netSales: d.netSalesMinor.toString(),
      completedOrderCount: d.completedOrderCount,
      averageOrderValue: d.averageOrderValueMinor?.toString() ?? null,
    },
    tenderTotals: {
      cash: {
        amountTotal: d.cashAmountTotalMinor.toString(),
        roundingAdjustmentTotal: d.cashRoundingAdjustmentTotalMinor.toString(),
        paymentCount: d.cashPaymentCount,
      },
      manualExternalCard: {
        amountTotal: d.cardAmountTotalMinor.toString(),
        paymentCount: d.cardPaymentCount,
      },
      unsettledCapturedTotal: d.unsettledCapturedTotalMinor.toString(),
      completedExcessCapturedTotal:
        d.completedExcessCapturedTotalMinor.toString(),
    },
    taxByClass: d.taxClassTotals.map((t) => ({
      taxClassId: t.taxClassId,
      taxAmount: t.taxAmountMinor.toString(),
      netAmount: t.netAmountMinor.toString(),
      grossAmount: t.grossAmountMinor.toString(),
      lineCount: t.lineCount,
    })),
    salesByOrderType: d.orderTypeTotals.map((t) => ({
      orderType: t.orderType,
      grossSales: t.grossSalesMinor.toString(),
      netSales: t.netSalesMinor.toString(),
      orderCount: t.orderCount,
    })),
    voidAndCompSummary: {
      voidedLineCount: d.voidedLineCount,
      voidedLineValue: d.voidedLineValueMinor.toString(),
      compLineCount: d.compLineCount,
      compLineValue: d.compLineValueMinor.toString(),
    },
    cashReconciliation: {
      scope: 'WHOLE_SESSION',
      sessionCount: d.sessionCount,
      varianceOwnerSessionCount: d.varianceOwnerSessionCount,
      varianceTotal: d.varianceTotalMinor.toString(),
      sessions: d.sessions.map((s) => ({
        cashSessionId: s.cashSessionId,
        isVarianceOwner: s.isVarianceOwner,
        businessDayCount: s.businessDayCount,
        dayScoped: {
          cashSalesTotal: s.dayScopedCashSalesTotalMinor.toString(),
          cashRoundingAdjustments:
            s.dayScopedCashRoundingAdjustmentsMinor.toString(),
          manualExternalCardTotal:
            s.dayScopedManualExternalCardTotalMinor.toString(),
          paymentCount: s.dayScopedPaymentCount,
        },
        wholeSession: {
          openingFloat: s.wholeSessionOpeningFloatMinor.toString(),
          expectedCash: s.wholeSessionExpectedCashMinor.toString(),
          countedCash: s.wholeSessionCountedCashMinor.toString(),
          variance: s.wholeSessionVarianceMinor.toString(),
        },
      })),
    },
    closedBy: { userId: d.closedBy, employeeId: d.closedByEmployeeId },
    scope: SCOPE_BLOCK,
  };
}
