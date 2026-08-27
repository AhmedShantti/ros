import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import type { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import { divideRounded } from '../../../common/money/rounding';
import { Order, OrderPayment, Prisma } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { PINNED_PAYMENT_POLICY_QUERY } from '../../localisation/contract';
import type { PinnedPaymentPolicyQuery } from '../../localisation/contract';
import { CASH_SESSION_FACTS_QUERY } from '../../treasury/contract';
import type { CashSessionFactsQuery } from '../../treasury/contract';
import {
  PRODUCTION_CONSUMPTION_QUERY,
  RECIPE_COST_RECOMPUTER,
} from '../../production/contract';
import type {
  PlanConsumptionLineInput,
  ProductionConsumptionQuery,
  RecipeCostRecomputer,
} from '../../production/contract';
import { SALE_DEPLETION_COMMAND } from '../../inventory/contract';
import type { SaleDepletionCommand } from '../../inventory/contract';
import {
  ORDER_COMPLETED_EVENT_TYPE,
  ORDER_COMPLETED_EVENT_VERSION,
  OrderCompletedLine,
  OrderCompletedPaymentSummary,
} from '../contract';
import {
  InsufficientCashTenderedError,
  InvalidCashSessionError,
} from './payment.errors';
import {
  OrderVersionConflictError,
  assertMayCapturePayment,
  assertTransition,
  assertVersion,
} from './order-state';

export type PaymentTender = 'cash' | 'manual_external_card';

export interface CapturePaymentInput {
  readonly orderId: string;
  readonly businessDay: Date;
  readonly expectedVersion: number;
  readonly id?: string;
  readonly tender: PaymentTender;
  /** Minor units. */
  readonly amountMinor: bigint;
  readonly cashSessionId: string;
  /** Trusted PIN-session employee. NEVER from the request body. */
  readonly employeeId: string;
  /** Trusted terminal. NEVER from the request body. */
  readonly terminalId: string;
  /** CASH only. Minor units. */
  readonly tenderedAmountMinor?: bigint;
  /** MANUAL_EXTERNAL_CARD only. */
  readonly terminalReference?: string;
  readonly cardScheme?: string;
  readonly last4?: string;
  readonly authorizationCode?: string;
}

export interface CapturePaymentResult {
  readonly order: Order;
  readonly payment: OrderPayment;
}

/**
 * Sales application command — Payment capture AND, from P1F-2 on, Order
 * Completion. PRIVATE to Sales (never exported through `sales/contract`).
 *
 * Migrated to `UnitOfWork.execute` (the `SalesFireService` precedent): a
 * SETTLING payment (one that brings `paid_total` to `grand_total`) publishes
 * `order.completed` in the SAME transaction, which a plain
 * `PrismaService.withAuthContext` transaction cannot do.
 *
 * Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
 * correction.md (CONTROLLING) §L "F. ONE UNITOFWORK TRANSACTION" — the
 * numbered steps below are that section's, verbatim.
 *
 * ── SETTLEMENT MATH (P1F-1, unchanged) ──────────────────────────────────
 * `amount` — what this Payment contributes to `orders.paid_total` — is the
 * EXACT figure being settled, never the cash-rounded one, matching the
 * SRS's own `Order.complete()` reference pseudocode (§24.2.4): `paid`
 * (`Money.sum` of payment `amount`s) is compared directly against
 * `grandTotal`, with NO rounding term anywhere in that comparison.
 * `roundingAdjustment` is a SEPARATE, cash-drawer-reconciliation-only
 * figure (FR-FIN-004) — never added to `paid_total`, never absorbed into
 * revenue or tax (BR-FIN-004). `discount_total_of_comps` is omitted from
 * the settlement threshold because no comp/discount mechanism exists —
 * `discountTotal` stays 0 for every order, so `paid >= grandTotal -
 * compTotal` collapses, without guessing, to `paid >= grandTotal`.
 */
@Injectable()
export class SalesPaymentService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CASH_SESSION_FACTS_QUERY)
    private readonly cashSessionFacts: CashSessionFactsQuery,
    @Inject(PINNED_PAYMENT_POLICY_QUERY)
    private readonly paymentPolicy: PinnedPaymentPolicyQuery,
    @Inject(PRODUCTION_CONSUMPTION_QUERY)
    private readonly consumption: ProductionConsumptionQuery,
    @Inject(SALE_DEPLETION_COMMAND)
    private readonly saleDepletion: SaleDepletionCommand,
    @Inject(RECIPE_COST_RECOMPUTER)
    private readonly recipeCost: RecipeCostRecomputer,
  ) {}

  async capture(
    tenantId: string,
    actorUserId: string,
    input: CapturePaymentInput,
  ): Promise<CapturePaymentResult> {
    if (input.amountMinor <= 0n) {
      throw new BadRequestException('amountMinor must be greater than zero.');
    }
    const id = input.id ?? newId();

    return this.unitOfWork.execute(
      { userId: actorUserId, tenantId },
      async (ctx) => {
        const tx = ctx.tx;

        // ── 1. Permanent Payment identity (FR-OFF-015) — MUST BE FIRST. ────
        const existing = await tx.orderPayment.findUnique({ where: { id } });
        if (existing) {
          const identical =
            existing.tenantId === tenantId &&
            existing.orderId === input.orderId &&
            existing.businessDay.getTime() === input.businessDay.getTime() &&
            existing.tender === input.tender &&
            existing.amount === input.amountMinor &&
            existing.cashSessionId === input.cashSessionId &&
            existing.tenderedAmount === (input.tenderedAmountMinor ?? null) &&
            existing.paymentTerminalTxnRef ===
              (input.terminalReference ?? null);
          if (!identical) {
            throw new ConflictException(
              'That payment id already exists with different content. A ' +
                'client-generated identifier is permanent (FR-OFF-015).',
            );
          }
          const order = await tx.order.findUniqueOrThrow({
            where: {
              id_businessDay: {
                id: input.orderId,
                businessDay: input.businessDay,
              },
            },
          });
          return { order, payment: existing };
        }

        // ── 2. Load the Order. ──────────────────────────────────────────
        const order = await tx.order.findUnique({
          where: {
            id_businessDay: {
              id: input.orderId,
              businessDay: input.businessDay,
            },
          },
        });
        if (!order) throw new NotFoundException('Order not found.');

        // ── 3/4. Guards. ─────────────────────────────────────────────────
        assertMayCapturePayment(order.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        // ── 5. CashSession facts (P1D-G), Treasury's public contract only. ─
        const session = await this.cashSessionFacts.find(tx, {
          tenantId,
          cashSessionId: input.cashSessionId,
        });
        if (!session) {
          throw new NotFoundException('Cash session not found.');
        }
        if (session.status !== 'open') {
          throw new InvalidCashSessionError('That cash session is not open.');
        }
        if (session.branchId !== order.branchId) {
          throw new InvalidCashSessionError(
            'That cash session belongs to a different branch than this order.',
          );
        }
        if (session.employeeId !== input.employeeId) {
          throw new InvalidCashSessionError(
            'That cash session does not belong to the employee capturing this payment.',
          );
        }
        if (
          session.terminalId !== null &&
          session.terminalId !== input.terminalId
        ) {
          throw new InvalidCashSessionError(
            'That cash session is bound to a different terminal.',
          );
        }
        if (session.currency !== order.currency) {
          throw new InvalidCashSessionError(
            'That cash session is denominated in a different currency than this order.',
          );
        }

        // ── 6. The order's PINNED payment policy (FR-LOC-021). ─────────────
        const branch = await tx.branch.findUniqueOrThrow({
          where: { id: order.branchId },
          select: { countryCode: true },
        });
        const policy = this.paymentPolicy.requirePinnedPaymentPolicy({
          countryCode: branch.countryCode,
          packVersion: order.countryPackVersion,
        });

        // ── 7. Tender-specific computation. ─────────────────────────────
        let roundingAdjustment = 0n;
        let tenderedAmount: bigint | null = null;
        let changeGiven: bigint | null = null;
        let paymentTerminalTxnRef: string | null = null;
        let cardScheme: string | null = null;
        let cardLast4: string | null = null;
        let authorizationCode: string | null = null;

        if (input.tender === 'cash') {
          if (input.tenderedAmountMinor === undefined) {
            throw new BadRequestException(
              'tenderedAmountMinor is required for a cash payment.',
            );
          }
          let roundedCashDue = input.amountMinor;
          if (policy.cashRoundingEnabled && policy.cashRoundingStepMinorUnits) {
            const step = policy.cashRoundingStepMinorUnits;
            const steps = divideRounded(
              input.amountMinor,
              step,
              policy.roundingMode,
            );
            roundedCashDue = steps * step;
          }
          roundingAdjustment = roundedCashDue - input.amountMinor;
          if (input.tenderedAmountMinor < roundedCashDue) {
            throw new InsufficientCashTenderedError(
              `Tendered amount ${input.tenderedAmountMinor} is less than the ` +
                `${roundedCashDue} due after cash rounding.`,
            );
          }
          tenderedAmount = input.tenderedAmountMinor;
          changeGiven = input.tenderedAmountMinor - roundedCashDue;
        } else {
          if (!input.terminalReference) {
            throw new BadRequestException(
              'terminalReference is required for a manual/external card payment.',
            );
          }
          paymentTerminalTxnRef = input.terminalReference;
          cardScheme = input.cardScheme ?? null;
          cardLast4 = input.last4 ?? null;
          authorizationCode = input.authorizationCode ?? null;
        }

        // ── 8. Settlement decision. ─────────────────────────────────────
        const newPaidTotal = order.paidTotal + input.amountMinor;
        const isSettling = newPaidTotal >= order.grandTotal;

        // ── 9. Persist the Payment — conflict-safe (P1E-5A pattern). ──────
        const processedAt = new Date();
        const inserted = await tx.$queryRaw<OrderPayment[]>`
        INSERT INTO "sales"."order_payments" (
          "id", "tenant_id", "branch_id", "order_id", "business_day",
          "tender", "currency", "amount", "rounding_adjustment",
          "cash_session_id", "employee_id", "terminal_id",
          "tendered_amount", "change_given", "payment_terminal_txn_ref",
          "card_scheme", "card_last4", "authorization_code", "processed_at"
        ) VALUES (
          ${id}::uuid, ${tenantId}::uuid, ${order.branchId}::uuid,
          ${input.orderId}::uuid, ${input.businessDay}::date,
          ${input.tender}::"sales"."OrderPaymentTender", ${order.currency},
          ${input.amountMinor}, ${roundingAdjustment},
          ${input.cashSessionId}::uuid, ${input.employeeId}::uuid,
          ${input.terminalId}::uuid,
          ${tenderedAmount}, ${changeGiven}, ${paymentTerminalTxnRef},
          ${cardScheme}, ${cardLast4}, ${authorizationCode},
          ${processedAt}::timestamptz
        )
        ON CONFLICT ("id") DO NOTHING
        RETURNING
          "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
          "order_id" AS "orderId", "business_day" AS "businessDay",
          "tender", "currency", "amount",
          "rounding_adjustment" AS "roundingAdjustment",
          "cash_session_id" AS "cashSessionId",
          "employee_id" AS "employeeId", "terminal_id" AS "terminalId",
          "tendered_amount" AS "tenderedAmount",
          "change_given" AS "changeGiven",
          "payment_terminal_txn_ref" AS "paymentTerminalTxnRef",
          "card_scheme" AS "cardScheme", "card_last4" AS "cardLast4",
          "authorization_code" AS "authorizationCode",
          "processed_at" AS "processedAt", "created_at" AS "createdAt"
      `;
        if (inserted.length === 0) {
          const winner = await tx.orderPayment.findUnique({ where: { id } });
          if (!winner) {
            throw new Error(
              `Payment insert conflicted for id ${id} but no row is visible afterwards.`,
            );
          }
          throw new ConflictException(
            'That payment id already exists with different content. A ' +
              'client-generated identifier is permanent (FR-OFF-015).',
          );
        }
        const payment = inserted[0];

        if (!isSettling) {
          return this.completePartial(
            tx,
            tenantId,
            actorUserId,
            input,
            order,
            payment,
            nextVersion,
            roundingAdjustment,
            newPaidTotal,
          );
        }

        return this.completeSettling(
          ctx,
          tenantId,
          actorUserId,
          input,
          order,
          payment,
          nextVersion,
          roundingAdjustment,
        );
      },
    );
  }

  // -------------------------------------------------------------- PARTIAL

  private async completePartial(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorUserId: string,
    input: CapturePaymentInput,
    order: Order,
    payment: OrderPayment,
    nextVersion: number,
    roundingAdjustment: bigint,
    newPaidTotal: bigint,
  ): Promise<CapturePaymentResult> {
    const isFirstPartial = order.state === 'open';
    if (isFirstPartial) assertTransition('open', 'partially_paid');

    const updateResult = await tx.order.updateMany({
      where: {
        id: order.id,
        businessDay: order.businessDay,
        version: input.expectedVersion,
      },
      data: {
        paidTotal: { increment: input.amountMinor },
        roundingAdjustment: { increment: roundingAdjustment },
        state: 'partially_paid',
        version: nextVersion,
        updatedAt: new Date(),
      },
    });
    if (updateResult.count === 0) {
      throw new OrderVersionConflictError(
        `Version mismatch: the order changed concurrently and is no ` +
          `longer at version ${input.expectedVersion}. Reload the order and retry.`,
      );
    }

    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.PAYMENT_CAPTURED,
      entityType: AUDIT_ENTITY.ORDER_PAYMENT,
      actorType: 'user',
      actorId: actorUserId,
      entityId: payment.id,
      terminalId: input.terminalId,
      metadata: {
        orderId: order.id,
        tender: input.tender,
        amount: input.amountMinor.toString(),
        roundingAdjustment: roundingAdjustment.toString(),
        cashSessionId: input.cashSessionId,
        employeeId: input.employeeId,
        newPaidTotal: newPaidTotal.toString(),
        newState: 'partially_paid',
        firstPartial: isFirstPartial,
      },
    });

    const finalOrder = await tx.order.findUniqueOrThrow({
      where: {
        id_businessDay: { id: order.id, businessDay: order.businessDay },
      },
    });
    return { order: finalOrder, payment };
  }

  // ------------------------------------------------------------- SETTLING

  private async completeSettling(
    ctx: UnitOfWorkContext,
    tenantId: string,
    actorUserId: string,
    input: CapturePaymentInput,
    order: Order,
    payment: OrderPayment,
    nextVersion: number,
    roundingAdjustment: bigint,
  ): Promise<CapturePaymentResult> {
    const tx = ctx.tx;
    // Never persist an intermediate state — the source is exactly `open` or
    // `partially_paid` and the target is `completed`, both already legal.
    assertTransition(order.state, 'completed');

    // ── 10b. planConsumption — load non-voided lines + pinned snapshots. ──
    // Comped lines ARE included: BR-POS-001/FR-FIN money exclusion of a
    // comp is a BILLING fact, not a claim the kitchen never made the item —
    // physical depletion follows what was PRODUCED (FR-INV-014), not what
    // was billed. Only VOIDED lines (never fired) are excluded.
    const lines = await tx.orderLine.findMany({
      where: {
        orderId: order.id,
        businessDay: order.businessDay,
        state: { not: 'voided' },
      },
      include: {
        modifiers: true,
        recipeVersionPins: true,
        modifierEffectPins: true,
        componentConversions: true,
      },
    });

    const planLines: PlanConsumptionLineInput[] = lines.map((line) => {
      const modifierQuantityById = new Map(
        line.modifiers.map((m) => [m.id, m.quantity]),
      );
      return {
        orderLineId: line.id,
        recipeVersionId: line.recipeVersionId,
        pinnedVersionIds: line.recipeVersionPins.map((p) => p.recipeVersionId),
        quantity: line.quantity.toFixed(3),
        modifierEffects: line.modifierEffectPins.map((e) => ({
          operation: e.operation,
          componentType: e.componentType,
          stockItemId: e.stockItemId,
          subRecipeVersionId: e.subRecipeVersionId,
          quantity: e.quantity ? e.quantity.toFixed(6) : null,
          unitId: e.unitId,
          modifierSelectionQuantity:
            modifierQuantityById.get(e.orderLineModifierId) ?? 1,
        })),
        conversions: line.componentConversions.map((c) => ({
          stockItemId: c.stockItemId,
          fromUnitId: c.fromUnitId,
          baseUnitId: c.baseUnitId,
          factor: c.factor.toFixed(10),
        })),
      };
    });

    const planResult = await this.consumption.planConsumption(tx, {
      lines: planLines,
    });

    // ── 11b. depleteForCompletedSale — reserve-first dual-axis. ──────────
    const occurredAt = new Date();
    const depletionResult = await this.saleDepletion.depleteForCompletedSale(
      tx,
      {
        tenantId,
        actorId: actorUserId,
        branchId: order.branchId,
        orderId: order.id,
        businessDay: order.businessDay,
        occurredAt,
        lines: planResult.perLine.map((pl) => ({
          orderLineId: pl.orderLineId,
          components: pl.components,
        })),
      },
    );

    // ── 12b. recomputeForStockItems — DISTINCT FIFO items only, ONCE. ────
    if (depletionResult.distinctFifoStockItemIds.length) {
      await this.recipeCost.recomputeForStockItems(
        tx,
        depletionResult.distinctFifoStockItemIds,
      );
    }

    // ── 13b. write order_lines.posted_cogs_total from the allocations. ──
    for (const lineResult of depletionResult.perLine) {
      await tx.orderLine.update({
        where: {
          id_businessDay: {
            id: lineResult.orderLineId,
            businessDay: order.businessDay,
          },
        },
        data: { postedCogsTotal: lineResult.postedCogsTotal },
      });
    }
    const cogsTotal = depletionResult.perLine.reduce(
      (sum, l) => sum + l.postedCogsTotal,
      0n,
    );

    // ── 14b. Order CAS — LAST mutation. ─────────────────────────────────
    const updateResult = await tx.order.updateMany({
      where: {
        id: order.id,
        businessDay: order.businessDay,
        version: input.expectedVersion,
      },
      data: {
        paidTotal: { increment: input.amountMinor },
        roundingAdjustment: { increment: roundingAdjustment },
        state: 'completed',
        completedAt: occurredAt,
        // The EMPLOYEE (P1D-E) — the trusted PIN-session actor, not the
        // identity user acting the request.
        closedBy: input.employeeId,
        cogsTotal,
        version: nextVersion,
        updatedAt: occurredAt,
      },
    });
    if (updateResult.count === 0) {
      throw new OrderVersionConflictError(
        `Version mismatch: the order changed concurrently and is no ` +
          `longer at version ${input.expectedVersion}. Reload the order and retry.`,
      );
    }

    // ── 15/16. Audits — PAYMENT_CAPTURED (unchanged) + ORDER_COMPLETED. ──
    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.PAYMENT_CAPTURED,
      entityType: AUDIT_ENTITY.ORDER_PAYMENT,
      actorType: 'user',
      actorId: actorUserId,
      entityId: payment.id,
      terminalId: input.terminalId,
      metadata: {
        orderId: order.id,
        tender: input.tender,
        amount: input.amountMinor.toString(),
        roundingAdjustment: roundingAdjustment.toString(),
        cashSessionId: input.cashSessionId,
        employeeId: input.employeeId,
        newPaidTotal: (order.paidTotal + input.amountMinor).toString(),
        newState: 'completed',
        firstPartial: false,
      },
    });

    const allGaps = planResult.perLine.flatMap((pl) =>
      pl.gaps.map((g) => ({ orderLineId: pl.orderLineId, ...g })),
    );
    const movementIds = depletionResult.perLine.flatMap((pl) =>
      pl.effects.flatMap((e) => e.allocations.map((a) => a.movementId)),
    );
    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.ORDER_COMPLETED,
      entityType: AUDIT_ENTITY.ORDER,
      actorType: 'user',
      actorId: actorUserId,
      entityId: order.id,
      terminalId: input.terminalId,
      before: {
        state: order.state,
        version: order.version,
        paidTotal: order.paidTotal.toString(),
      },
      metadata: {
        gaps: allGaps,
        movementIds,
        postedCogsTotal: cogsTotal.toString(),
      },
    });

    // ── 17. Publish order.completed. ────────────────────────────────────
    const payments = await tx.orderPayment.findMany({
      where: { orderId: order.id, businessDay: order.businessDay },
      orderBy: { processedAt: 'asc' },
    });
    const paymentSummaries: OrderCompletedPaymentSummary[] = payments.map(
      (p) => ({
        id: p.id,
        tender: p.tender,
        amount: p.amount.toString(),
        roundingAdjustment: p.roundingAdjustment.toString(),
        tenderedAmount: p.tenderedAmount?.toString() ?? null,
        changeGiven: p.changeGiven?.toString() ?? null,
        cashSessionId: p.cashSessionId,
        employeeId: p.employeeId,
        terminalId: p.terminalId,
        processedAt: p.processedAt.toISOString(),
      }),
    );
    const completedLines: OrderCompletedLine[] = lines.map((line) => {
      const result = depletionResult.perLine.find(
        (pl) => pl.orderLineId === line.id,
      );
      const plan = planResult.perLine.find((pl) => pl.orderLineId === line.id);
      return {
        orderLineId: line.id,
        menuItemId: line.menuItemId,
        variantId: line.variantId,
        quantity: line.quantity.toFixed(3),
        postedCogsTotal: (result?.postedCogsTotal ?? 0n).toString(),
        components: plan?.components ?? [],
      };
    });

    ctx.publishEvent({
      eventType: ORDER_COMPLETED_EVENT_TYPE,
      eventVersion: ORDER_COMPLETED_EVENT_VERSION,
      occurredAt,
      branchId: order.branchId,
      actorId: actorUserId,
      actorType: 'user',
      idempotencyKey: `completion:${payment.id}`,
      payload: {
        orderId: order.id,
        branchId: order.branchId,
        businessDay: order.businessDay.toISOString().slice(0, 10),
        lines: completedLines,
        totals: {
          currency: order.currency,
          subtotal: order.subtotal.toString(),
          discountTotal: order.discountTotal.toString(),
          serviceChargeTotal: order.serviceChargeTotal.toString(),
          taxTotal: order.taxTotal.toString(),
          roundingAdjustment: (
            order.roundingAdjustment + roundingAdjustment
          ).toString(),
          grandTotal: order.grandTotal.toString(),
          paidTotal: (order.paidTotal + input.amountMinor).toString(),
          tipTotal: order.tipTotal.toString(),
          cogsTotal: cogsTotal.toString(),
        },
        payments: paymentSummaries,
        completedAt: occurredAt.toISOString(),
        customerId: null,
      },
    });

    // ── 19. Re-read. (18. dispatcher drain happens after `fn` resolves.) ──
    const finalOrder = await tx.order.findUniqueOrThrow({
      where: {
        id_businessDay: { id: order.id, businessDay: order.businessDay },
      },
    });
    return { order: finalOrder, payment };
  }
}
