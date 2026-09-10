import type { DomainEventEnvelope } from '../../../common/domain-events/domain-event.types';

/**
 * Procurement PUBLIC contract — the domain event this module publishes.
 *
 * SRS core event catalogue names `purchase_order.approved`. Published
 * exactly once through the SAME `UnitOfWork`/domain-event mechanism every
 * other producer uses (`cancel-order.service.ts` is the worked precedent —
 * see this module's own PO approval services), the FIRST time a
 * PurchaseOrder transitions into `approved` — whether that happens via
 * below-threshold auto-approval (mission brief §8/§14: "Auto-approved POs
 * also publish the same semantic event exactly once") or via a manual
 * Governance `ApprovalCommands.decide()` approval. It is NEVER published a
 * second time for the same PO: a replayed/idempotent decision (Governance's
 * `DecideApprovalResult.created === false`) short-circuits before this event
 * is ever constructed, and an amendment that keeps a PO within its
 * already-approved band never re-enters the "first becomes approved" path
 * at all. An amendment that crosses back into `pending_approval` and is
 * later re-approved publishes this event again — that is a genuinely NEW,
 * distinct approval decision (a different `approvalRequestId`/decision id),
 * not a duplicate of the earlier one.
 *
 * The envelope (`DomainEventEnvelope`) already supplies `tenantId`,
 * `actorId`, `actorType`, `correlationId`, `causationId`, `idempotencyKey` —
 * none of those is repeated in the payload. Money is a minor-unit string
 * (BR-CORE money rule), never a JS number.
 */
export const PURCHASE_ORDER_APPROVED_EVENT_TYPE = 'purchase_order.approved';
export const PURCHASE_ORDER_APPROVED_EVENT_VERSION = 1;

export interface PurchaseOrderApprovedPayload {
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly deliveryLocationType: 'branch' | 'warehouse' | 'central_kitchen';
  readonly deliveryLocationId: string;
  readonly currency: string;
  /** Minor units of `currency`. */
  readonly grandTotalMinor: string;
  readonly approvalBand: 'auto' | 'tier_1' | 'tier_2' | 'tier_3';
  /** `null` for an `auto` band — no human approver exists. */
  readonly approvedBy: string | null;
  readonly approvedAt: string;
}

export type PurchaseOrderApprovedEvent = DomainEventEnvelope<
  typeof PURCHASE_ORDER_APPROVED_EVENT_TYPE,
  PurchaseOrderApprovedPayload
>;
