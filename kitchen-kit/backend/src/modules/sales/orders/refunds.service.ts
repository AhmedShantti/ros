/**
 * POS-FIN-1 — Refunds (FR-POS-072/073/074/075, CR-04, BR-POS-001).
 *
 * Append-only compensating record. The original `Order`/`OrderLine`/
 * `OrderPayment` rows are NEVER updated — CR-04/BR-POS-001's "corrections
 * are made by compensating entries" is satisfied structurally: this file
 * contains no `tx.orderPayment.update(...)`/`tx.orderLine.update(...)` call
 * anywhere, and `sales.order_payments`' own DB grants make an UPDATE
 * physically impossible even if one were attempted. The only Order-row
 * write is the `state` transition (`completed`/`partially_refunded` ->
 * `partially_refunded`/`refunded`) — an anticipated, already-modelled
 * transition (`order-state.ts`), never a rewrite of a posted financial
 * total (subtotal/taxTotal/discountTotal/grandTotal/paidTotal/cogsTotal are
 * untouched by every write below).
 *
 * ── HARD CONCURRENCY INVARIANT — CAP BASIS (acceptance-corrected 2026-09-04)
 * `sum(committed refunds) + requested refund <= order.grandTotal` — NOT
 * `paidTotal`. FR-POS-072's "original amount" was re-adjudicated against
 * the literal source rather than assumed: `grandTotal` and `paidTotal` are
 * identical for the overwhelming majority of orders (BR-POS-002 requires
 * `paidTotal >= grandTotal` to complete, and every ordinary payment path
 * settles exactly at `grandTotal`). They diverge ONLY in the one
 * P1F-2-permitted edge case where an accepted payment overshoots
 * (`paidTotal > grandTotal`) — and the existing, already-accepted
 * `daily-trading-sales.query.service.ts`/design-gate documentation for that
 * exact figure (`completedExcessCapturedTotal`) states explicitly that the
 * excess is "reconciliation-only... no revenue, tax, tip, discount,
 * refund, cash-rounding, or variance disposition is inferred" — i.e. no
 * accepted source authorizes treating that excess as refundable. Capping at
 * `paidTotal` would silently self-ratify a disposition the project's own
 * reporting layer explicitly declines to assign. `grandTotal` is therefore
 * the safe, literal, non-self-ratifying ceiling: it is always `<=
 * paidTotal` (never allows the order to be UNDER-refunded relative to what
 * was actually owed) and never touches the undefined excess. This is
 * recorded as a genuinely resolved reading, not an assumption — see the
 * POS-FIN-1 report's acceptance-correction section for the full case
 * analysis (A–E) this conclusion was tested against.
 *
 * Enforced under a `pg_advisory_xact_lock` scoped to the order, the
 * IDENTICAL `hashtext(lock key, orderId)` pattern
 * `cash-session-close.service.ts` and `sales-payment.service.ts` already
 * use — no unlocked read-current-total-then-insert race is possible.
 *
 * ── APPROVAL THRESHOLD REUSE ─────────────────────────────────────────────
 * FR-POS-073 requires "above a configurable threshold, manager approval"
 * but the SRS names no distinct refund-threshold dimension the way
 * FR-POS-047 does for discounts, and no governance decision ratifies one.
 * This reuses the SAME branch-scoped `DiscountApprovalPolicyVersion`'s
 * `maxAmountWithoutApprovalMinor` dimension (absent policy = the same
 * conservative "always requires approval" default) — a recorded, narrow
 * reuse of the one configured "amount without approval" concept that
 * exists, not a second invented table.
 *
 * ── FR-POS-074 ────────────────────────────────────────────────────────────
 * Default is the ORIGINAL payment's own tender — REQUIRED here
 * (`originalPaymentId`), removing all ambiguity a split-tender order would
 * otherwise create. A different tender requires `pos.refund.different_tender`,
 * checked in-transaction via `SCOPE_AUTHORIZATION` (a SECOND authorization
 * decision, atomic with the write — the same `assertCloseAuthority`
 * precedent `cash-session-close.service.ts` established). The "flagged in
 * the fraud detection report" clause is NOT IMPLEMENTED — no fraud-report
 * infrastructure exists anywhere in this repository (design gate §7 item 5,
 * per the task's own explicit instruction not to invent one).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { APPROVAL_COMMANDS } from '../../governance/contract';
import type { ApprovalCommands } from '../../governance/contract';
import { SCOPE_AUTHORIZATION } from '../../identity/contract';
import type {
  ScopeAuthorizationActor,
  ScopeAuthorizationPort,
  VerifiedTerminalPrincipal,
} from '../../identity/contract';
import { SALES_PERMISSIONS } from '../sales.permissions';
import {
  OrderVersionConflictError,
  assertMayRefund,
  assertVersion,
  resolveRefundTargetState,
} from './order-state';
import { obtainSynchronousApproval } from './approval-helper';

const REFUND_LOCK_KEY = 'ros_refund';

export interface ManagerApprovalInput {
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly approver: VerifiedTerminalPrincipal;
}

export interface IssueRefundInput {
  readonly id?: string;
  readonly expectedVersion: number;
  readonly originalPaymentId: string;
  readonly tender: 'cash' | 'manual_external_card';
  /** Minor units, exact integer string. */
  readonly amountMinor: string;
  readonly reasonCodeId: string;
  readonly employeeId: string;
  /** REQUIRED when `tender` is `cash`. */
  readonly cashSessionId?: string;
  readonly auth: ScopeAuthorizationActor;
  readonly manager?: ManagerApprovalInput;
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APPROVAL_COMMANDS) private readonly approvals: ApprovalCommands,
    @Inject(SCOPE_AUTHORIZATION)
    private readonly scopeAuthorization: ScopeAuthorizationPort,
  ) {}

  async issueRefund(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    input: IssueRefundInput,
  ) {
    if (!/^\d{1,18}$/.test(input.amountMinor)) {
      throw new BadRequestException(
        'amountMinor must be a whole number of minor units expressed as a string.',
      );
    }
    const amountMinor = BigInt(input.amountMinor);
    if (amountMinor <= 0n) {
      throw new UnprocessableEntityException(
        'A refund must be greater than zero.',
      );
    }
    if (input.tender === 'cash' && !input.cashSessionId) {
      throw new BadRequestException(
        'cashSessionId is required for a cash refund.',
      );
    }
    if (input.tender === 'manual_external_card' && input.cashSessionId) {
      throw new BadRequestException(
        'cashSessionId is not accepted for a manual_external_card refund.',
      );
    }
    const refundId = input.id ?? newId();

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        // ── Permanent-id replay, LOGICALLY FIRST (P1E-5A pattern) — before
        // the advisory lock, mirroring `SalesPaymentService.capture`. ──────
        const existing = await tx.refund.findUnique({
          where: { id: refundId },
        });
        if (existing) {
          const identical =
            existing.orderId === orderId &&
            existing.businessDay.getTime() === businessDay.getTime() &&
            existing.originalPaymentId === input.originalPaymentId &&
            existing.tender === input.tender &&
            existing.amountMinor === amountMinor &&
            existing.reasonCodeId === input.reasonCodeId;
          if (!identical) {
            throw new ConflictException(
              'That refund id already exists with different content. A ' +
                'client-generated identifier is permanent (FR-OFF-015).',
            );
          }
          const order = await tx.order.findUniqueOrThrow({
            where: { id_businessDay: { id: orderId, businessDay } },
          });
          return { refund: existing, order };
        }

        // ── Advisory lock — serializes every concurrent refund attempt
        // against THIS order (the hard concurrency invariant). ────────────
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          REFUND_LOCK_KEY,
          orderId,
        );

        const order = await tx.order.findUnique({
          where: { id_businessDay: { id: orderId, businessDay } },
          select: {
            id: true,
            businessDay: true,
            branchId: true,
            terminalId: true,
            state: true,
            version: true,
            currency: true,
            paidTotal: true,
            grandTotal: true,
          },
        });
        if (!order) throw new NotFoundException('Order not found.');

        assertMayRefund(order.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        const originalPayment = await tx.orderPayment.findUnique({
          where: { id: input.originalPaymentId },
          select: { id: true, orderId: true, tender: true },
        });
        if (!originalPayment || originalPayment.orderId !== order.id) {
          throw new NotFoundException(
            'Original payment not found on this order.',
          );
        }

        if (input.tender !== originalPayment.tender) {
          const hasDifferentTenderPermission =
            await this.scopeAuthorization.isAuthorized(
              input.auth,
              {
                codes: [SALES_PERMISSIONS.REFUND_DIFFERENT_TENDER],
                mode: 'all',
              },
              { type: 'branch', branchId: order.branchId },
              tx,
            );
          if (!hasDifferentTenderPermission) {
            throw new ForbiddenException(
              'Refunding to a tender other than the original requires ' +
                "'pos.refund.different_tender' (FR-POS-074).",
            );
          }
        }

        const reason = await tx.reasonCode.findUnique({
          where: { id: input.reasonCodeId },
          select: { id: true },
        });
        if (!reason) {
          throw new UnprocessableEntityException(
            'A refund requires a reason code that exists in this tenant (FR-POS-073).',
          );
        }

        // ── HARD CAP — inside the lock, fresh SUM, never a stale figure.
        // Cap basis is `grandTotal`, NOT `paidTotal` — see this file's own
        // docblock "CAP BASIS" section for the full re-adjudication. A
        // completed order's `paidTotal` can legitimately exceed
        // `grandTotal` (P1F-2's permitted over-tender case); that excess
        // has no accepted disposition anywhere in this repository, so it is
        // never treated as refundable here. ──────────────────────────────
        const committed = await tx.refund.aggregate({
          where: { tenantId, orderId: order.id, businessDay },
          _sum: { amountMinor: true },
        });
        const cumulativeBefore = committed._sum.amountMinor ?? 0n;
        const cumulativeAfter = cumulativeBefore + amountMinor;
        const refundableCap = order.grandTotal;
        if (cumulativeAfter > refundableCap) {
          throw new UnprocessableEntityException(
            `This refund would bring the aggregate refunded amount to ` +
              `${cumulativeAfter}, exceeding the original refundable ` +
              `amount of ${refundableCap} (FR-POS-072).`,
          );
        }

        const policy = await tx.discountApprovalPolicyVersion.findFirst({
          where: { tenantId, branchId: order.branchId },
          orderBy: { createdAt: 'desc' },
        });
        const approvalRequired =
          policy?.maxAmountWithoutApprovalMinor === undefined ||
          policy?.maxAmountWithoutApprovalMinor === null ||
          amountMinor > policy.maxAmountWithoutApprovalMinor;

        let approver: { userId: string; employeeId: string } | null = null;
        if (approvalRequired) {
          if (!input.manager) {
            throw new ForbiddenException(
              'This refund is above the configured threshold and requires ' +
                'manager approval (FR-POS-073). Supply a manager PIN and retry.',
            );
          }
          const employee = await tx.employee.findUnique({
            where: { id: input.employeeId },
            select: { userId: true },
          });
          await obtainSynchronousApproval(this.approvals, {
            tx,
            tenantId,
            requestedByUserId: actorUserId,
            requestType: 'refund.issue',
            entityType: AUDIT_ENTITY.REFUND,
            entityId: refundId,
            value: {
              orderId: order.id,
              amountMinor: amountMinor.toString(),
              tender: input.tender,
              originalPaymentId: input.originalPaymentId,
            },
            requiredPermission: SALES_PERMISSIONS.DISCOUNT_APPROVE,
            ...(employee?.userId
              ? { excludedApproverUserId: employee.userId }
              : {}),
            approvalRequestId: input.manager.approvalRequestId,
            approvalDecisionId: input.manager.approvalDecisionId,
            approver: input.manager.approver,
          });
          approver = {
            userId: input.manager.approver.userId,
            employeeId: input.manager.approver.employeeId,
          };
        }

        const refundBusinessDay = businessDay;
        const created = await tx.refund.create({
          data: {
            id: refundId,
            tenantId,
            branchId: order.branchId,
            orderId: order.id,
            businessDay,
            refundBusinessDay,
            originalPaymentId: input.originalPaymentId,
            tender: input.tender,
            amountMinor,
            cashSessionId: input.cashSessionId ?? null,
            reasonCodeId: reason.id,
            appliedByEmployeeId: input.employeeId,
            appliedByUserId: actorUserId,
            approvalRequired,
            ...(approver
              ? {
                  approvedByUserId: approver.userId,
                  approvedByEmployeeId: approver.employeeId,
                  approvalRequestId: input.manager!.approvalRequestId,
                }
              : {}),
          },
        });

        const targetState = resolveRefundTargetState(
          order.state,
          cumulativeAfter,
          refundableCap,
        );
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, businessDay, version: input.expectedVersion },
          data: {
            state: targetState,
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
        const updatedOrder = await tx.order.findUniqueOrThrow({
          where: { id_businessDay: { id: order.id, businessDay } },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.REFUND_ISSUED,
          entityType: AUDIT_ENTITY.REFUND,
          actorType: 'user',
          actorId: actorUserId,
          entityId: refundId,
          terminalId: order.terminalId,
          ...(approver
            ? {
                approverId: approver.userId,
                approvalId: input.manager!.approvalRequestId,
              }
            : {}),
          reasonCode: reason.id,
          before: {
            state: order.state,
            cumulativeRefunded: cumulativeBefore.toString(),
          },
          metadata: {
            orderId: order.id,
            originalPaymentId: input.originalPaymentId,
            tender: input.tender,
            differentTender: input.tender !== originalPayment.tender,
            amountMinor: amountMinor.toString(),
            cumulativeRefundedAfter: cumulativeAfter.toString(),
            refundableCap: refundableCap.toString(),
            grandTotal: order.grandTotal.toString(),
            paidTotal: order.paidTotal.toString(),
            appliedByEmployeeId: input.employeeId,
            approvalRequired,
            newState: targetState,
            orderVersion: nextVersion,
          },
        });

        return { refund: created, order: updatedOrder };
      },
    );
  }
}
