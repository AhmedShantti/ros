import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import {
  APPROVAL_COMMANDS,
  AUDIT_ACTION,
  AUDIT_ENTITY,
  ApprovalDecisionConflictError,
  ApprovalDecisionRejectedError,
  ApprovalNotPendingError,
  ApproverNotPermittedError,
  AuditService,
  type ApprovalCommands,
  type DecideApprovalResult,
} from '../../governance/contract';
import {
  TERMINAL_PIN_VERIFIER,
  type TerminalPinVerifier,
} from '../../identity/contract';
import {
  PURCHASE_ORDER_APPROVED_EVENT_TYPE,
  PURCHASE_ORDER_APPROVED_EVENT_VERSION,
  type PurchaseOrderApprovedPayload,
} from '../contract';
import type { DecidePurchaseOrderDto } from '../procurement.dto';
import { assertPoVersion } from './po-state';

/**
 * FR-PRC-018/019 §9 manual approval decision.
 *
 * ── WHY THIS IS A PIN-VERIFIED TERMINAL DECISION, NOT A DASHBOARD ONE ─────
 * The mission brief §9 requires reusing "the existing Governance approval
 * mechanism" and explicitly forbids "a parallel procurement approval
 * engine." Inspection of that mechanism (`governance/contract/
 * approval.contract.ts`) found `ApprovalCommands.decide()` requires a
 * `VerifiedTerminalPrincipal` — a value BRANDED so it can only be
 * constructed inside Identity (`module-boundaries.spec.ts` confines the
 * unfabricable cast to `src/modules/identity/`), obtainable ONLY via
 * `TERMINAL_PIN_VERIFIER.verifyTerminalPin()` (a registered POS/KDS/kiosk/
 * handheld terminal + employee PIN — `identity.terminals.terminal_type` has
 * no "back office"/dashboard variant). This is the SAME, and ONLY, manual
 * decision channel `discounts.service.ts`/`refunds.service.ts`/
 * `cancel-order.service.ts`/Treasury's `declareClose`/`finalizeClose`
 * already use — there is no dashboard-JWT-session decision channel
 * anywhere in this repository's Governance runtime today (confirmed against
 * the ratified Governance Decision Register: the "asynchronous" approval
 * half of FR-SEC-032 is explicitly recorded as deferred project-wide, the
 * exact same gap FR-PRC-020's mobile/email-link limb names). Building a new
 * "back-office JWT approver" identity-verification contract to work around
 * this would itself be "inventing a parallel decision channel" — the thing
 * the mission brief instructs against. This slice therefore reuses the
 * SAME synchronous PIN channel, applied to Purchase Order approval, and
 * records FR-PRC-020's remaining email/mobile-link limb as honestly
 * PARTIAL, exactly as the mission brief's §12 anticipates.
 *
 * `TERMINAL_PIN_VERIFIER.verifyTerminalPin()` MUST be called BEFORE the
 * business transaction opens (its own docblock — nested `withAuthContext`
 * is unsupported, and lockout counters must survive a caller rollback).
 */
@Injectable()
export class PurchaseOrderApprovalService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(APPROVAL_COMMANDS) private readonly approvals: ApprovalCommands,
    @Inject(TERMINAL_PIN_VERIFIER)
    private readonly pinVerifier: TerminalPinVerifier,
  ) {}

  async approve(tenantId: string, id: string, dto: DecidePurchaseOrderDto) {
    return this.decide(tenantId, id, dto, 'approved');
  }

  async reject(tenantId: string, id: string, dto: DecidePurchaseOrderDto) {
    return this.decide(tenantId, id, dto, 'rejected');
  }

  private async decide(
    tenantId: string,
    id: string,
    dto: DecidePurchaseOrderDto,
    decision: 'approved' | 'rejected',
  ) {
    const approver = await this.pinVerifier.verifyTerminalPin({
      tenantId,
      terminalId: dto.terminalId,
      employeeCode: dto.employeeCode,
      pin: dto.pin,
    });

    return this.unitOfWork.execute(
      { userId: approver.userId, tenantId },
      async (ctx) => {
        const tx = ctx.tx;
        const po = await tx.purchaseOrder.findUnique({
          where: { id },
          include: { lines: true },
        });
        if (!po) throw new NotFoundException('Purchase order not found.');

        // ── Idempotent-replay short-circuit, BEFORE the status guard below
        // ── mission brief §18: "approval retry does not duplicate
        // purchase_order.approved". A genuine HTTP retry of an EARLIER
        // successful decision arrives with `po.status` already moved past
        // `pending_approval` (that earlier call already committed it) — so
        // this MUST be checked first, or a legitimate replay would be
        // rejected by the status guard purely because it already succeeded.
        // Mirrors `cancel-order.service.ts`'s own "idempotency check
        // deliberately BEFORE every other assertion" pattern.
        const existingDecision = await tx.approvalDecision.findUnique({
          where: { id: dto.approvalDecisionId },
        });
        if (existingDecision) {
          return po;
        }

        if (po.status !== 'pending_approval' || !po.approvalRequestId) {
          throw new UnprocessableEntityException(
            `Purchase order ${id} is '${po.status}' — it has no pending ` +
              'manual approval request to decide.',
          );
        }
        const nextVersion = assertPoVersion(po.version, dto.expectedVersion);

        let decisionResult: DecideApprovalResult;
        try {
          decisionResult = await this.approvals.decide(tx, tenantId, {
            id: dto.approvalDecisionId,
            approvalRequestId: po.approvalRequestId,
            decision,
            comment: dto.comment,
            approver,
          });
        } catch (err) {
          if (
            err instanceof ApprovalDecisionRejectedError ||
            err instanceof ApproverNotPermittedError
          ) {
            throw new ForbiddenException(err.message);
          }
          if (
            err instanceof ApprovalDecisionConflictError ||
            err instanceof ApprovalNotPendingError
          ) {
            throw new ConflictException(err.message);
          }
          throw err;
        }

        // A concurrent racer inserted the SAME decision id between our
        // lookup above and `decide()`'s own insert — `decide()`'s permanent-
        // id protocol still recognizes it as a replay (`created: false`);
        // handled identically to the pre-check above.
        if (!decisionResult.created) {
          return tx.purchaseOrder.findUniqueOrThrow({
            where: { id },
            include: { lines: true },
          });
        }

        const decidedAt = decisionResult.decision.decidedAt;
        const finalDecision = decisionResult.decision.decision;

        if (finalDecision === 'approved') {
          const updateResult = await tx.purchaseOrder.updateMany({
            where: { id, version: dto.expectedVersion },
            data: {
              status: 'approved',
              version: nextVersion,
              approvedBand: po.approvalBand,
              approvedAt: decidedAt,
              approvedBy: approver.userId,
              updatedAt: decidedAt,
            },
          });
          if (updateResult.count === 0) {
            throw new ConflictException(
              'Version mismatch: the purchase order changed concurrently.',
            );
          }
        } else {
          const updateResult = await tx.purchaseOrder.updateMany({
            where: { id, version: dto.expectedVersion },
            data: {
              status: 'rejected',
              version: nextVersion,
              rejectedAt: decidedAt,
              rejectedBy: approver.userId,
              updatedAt: decidedAt,
            },
          });
          if (updateResult.count === 0) {
            throw new ConflictException(
              'Version mismatch: the purchase order changed concurrently.',
            );
          }
        }

        const updated = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id },
          include: { lines: true },
        });

        await this.audit.record(tx, {
          tenantId,
          action:
            finalDecision === 'approved'
              ? AUDIT_ACTION.PURCHASE_ORDER_APPROVED
              : AUDIT_ACTION.PURCHASE_ORDER_REJECTED,
          entityType: AUDIT_ENTITY.PURCHASE_ORDER,
          actorType: 'user',
          actorId: approver.userId,
          approverId: approver.userId,
          approvalId: po.approvalRequestId,
          entityId: id,
          before: { status: po.status, version: po.version },
          metadata: {
            band: po.approvalBand,
            decisionId: dto.approvalDecisionId,
            grandTotal: po.grandTotal.toString(),
          },
        });

        if (finalDecision === 'approved') {
          const payload: PurchaseOrderApprovedPayload = {
            purchaseOrderId: id,
            supplierId: po.supplierId,
            deliveryLocationType: po.deliveryLocationType,
            deliveryLocationId: po.deliveryLocationId,
            currency: po.currency,
            grandTotalMinor: po.grandTotal.toString(),
            approvalBand: po.approvalBand ?? 'tier_1',
            approvedBy: approver.userId,
            approvedAt: decidedAt.toISOString(),
          };
          ctx.publishEvent({
            eventType: PURCHASE_ORDER_APPROVED_EVENT_TYPE,
            eventVersion: PURCHASE_ORDER_APPROVED_EVENT_VERSION,
            occurredAt: decidedAt,
            branchId: po.lines[0].attributionBranchId,
            actorId: approver.userId,
            actorType: 'user',
            idempotencyKey: `purchase_order.approved:${id}:${dto.approvalDecisionId}`,
            payload,
          });
        }

        return updated;
      },
    );
  }
}
