import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { divideRounded } from '../../../common/money/rounding';
import { Order, OrderPayment } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { PINNED_PAYMENT_POLICY_QUERY } from '../../localisation/contract';
import type { PinnedPaymentPolicyQuery } from '../../localisation/contract';
import { CASH_SESSION_FACTS_QUERY } from '../../treasury/contract';
import type { CashSessionFactsQuery } from '../../treasury/contract';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  FullPaymentRequiresCompletionError,
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
 * Sales application command — Payment capture (P1F-1).
 *
 * PRIVATE to Sales: not exported through `sales/contract`, same discipline
 * `SalesFireService` already established — the contract exposes only the
 * event TYPES another module consumes, never a Sales command.
 *
 * Owns: loading the Order, the BR-POS-002 payment-source-state guard,
 * resolving and validating the CashSession through Treasury's public
 * contract (P1D-G), resolving the order's PINNED country pack for cash
 * rounding (FR-POS-063/BR-FIN-004), the §14 full-payment safety gate,
 * writing the append-only Payment row, the atomic Order CAS, and audit —
 * all inside ONE `PrismaService.withAuthContext` transaction (SRS §5.5.1).
 * Unlike Fire, Payment publishes no domain event in this MVP (no
 * `order.completed`, nothing subscribes to a payment-captured notification
 * yet), so this uses the same plain transactional shape
 * `OrderLinesService`/`OrdersService` already use — not `UnitOfWork`.
 *
 * ── SETTLEMENT MATH, RESOLVED NOT GUESSED ───────────────────────────────
 * `amount` — what this Payment contributes to `orders.paid_total` — is the
 * EXACT figure being settled, never the cash-rounded one. This matches the
 * SRS's own `Order.complete()` reference pseudocode (§24.2.4): `paid`
 * (`Money.sum` of payment `amount`s) is compared directly against
 * `grandTotal`, with NO rounding term anywhere in that comparison.
 * `roundingAdjustment` is a SEPARATE, cash-drawer-reconciliation-only
 * figure (FR-FIN-004's "± Cash Rounding Adjustments" term) — it is never
 * added to `paid_total` and never absorbed into revenue or tax
 * (BR-FIN-004). `discount_total_of_comps` (BR-POS-002's own settlement
 * term) is omitted from the threshold below because no comp/discount
 * mechanism is implemented anywhere in this codebase yet — `discountTotal`
 * stays `0` for every order today, so the SRS's own formula
 * (`paid >= grandTotal - compTotal`) collapses, without guessing, to
 * `paid >= grandTotal`.
 */
@Injectable()
export class SalesPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CASH_SESSION_FACTS_QUERY)
    private readonly cashSessionFacts: CashSessionFactsQuery,
    @Inject(PINNED_PAYMENT_POLICY_QUERY)
    private readonly paymentPolicy: PinnedPaymentPolicyQuery,
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

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        // ── Permanent Payment identity (FR-OFF-015) — checked BEFORE any
        // other work, mirroring CashSessionsService.open()'s exact pattern:
        // same id + identical content -> replay; same id + different
        // content -> 409, never a silent rewrite.
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

        // ── Load + guard the Order ──────────────────────────────────────
        const order = await tx.order.findUnique({
          where: {
            id_businessDay: {
              id: input.orderId,
              businessDay: input.businessDay,
            },
          },
        });
        if (!order) throw new NotFoundException('Order not found.');

        assertMayCapturePayment(order.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        // ── Resolve + validate the CashSession (P1D-G), through Treasury's
        // public contract only — never a direct Treasury table query. ────
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

        // ── Resolve the order's PINNED payment policy (FR-LOC-021) — never
        // the pack in force today. Localisation's PUBLIC contract only —
        // see `localisation/contract/pinned-payment-policy.query.ts`. ────
        const branch = await tx.branch.findUniqueOrThrow({
          where: { id: order.branchId },
          select: { countryCode: true },
        });
        const policy = this.paymentPolicy.requirePinnedPaymentPolicy({
          countryCode: branch.countryCode,
          packVersion: order.countryPackVersion,
        });

        // ── Tender-specific computation ─────────────────────────────────
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
            // BR-FIN-002: the pinned pack's own rounding mode (surfaced by
            // the Localisation contract) is the sole mode value available —
            // there is no cash-specific mode field anywhere in the source,
            // so this is the correct value to apply, not a substitute for a
            // missing one.
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

        // ── §14 HARD ACCEPTANCE GATE — no full/over-settlement in this
        // slice; Completion does not exist. Checked BEFORE any write. ────
        const newPaidTotal = order.paidTotal + input.amountMinor;
        if (newPaidTotal >= order.grandTotal) {
          throw new FullPaymentRequiresCompletionError(
            `This payment (${input.amountMinor}) would bring the order to ` +
              `${newPaidTotal} of ${order.grandTotal} — full or over ` +
              'settlement requires the Completion orchestration, which ' +
              'does not exist yet (P1F-1 §14). Capture a smaller amount.',
          );
        }

        const isFirstPartial = order.state === 'open';
        if (isFirstPartial) assertTransition('open', 'partially_paid');

        // ── Persist the Payment — conflict-safe (P1E-5A pattern): a real
        // race on the SAME client-chosen id resolves without ever raising
        // a Postgres error, so `tx` is never poisoned. ───────────────────
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
          // Lost a genuine race on this exact client-chosen id between the
          // read above and this insert. No exception was raised, so `tx`
          // is still perfectly usable.
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

        // ── Atomic Order CAS — same shape as Fire's, updateMany with
        // version IN the WHERE clause. ───────────────────────────────────
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

        // ── Audit — same transaction ──────────────────────────────────
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
      },
    );
  }
}
