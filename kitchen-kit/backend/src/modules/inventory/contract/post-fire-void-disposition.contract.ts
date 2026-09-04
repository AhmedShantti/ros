import { Prisma } from '../../../generated/prisma/client';

/**
 * Inventory PUBLIC contract — POS-FIN-1. The disposition command a post-fire
 * void needs (FR-POS-071): "wasted" and "given to staff" both record the
 * PHYSICAL consumption a produced item already caused, even though this
 * system's ordinary sale-depletion accounting (`SALE_DEPLETION_COMMAND`)
 * runs at Order COMPLETION, not at Fire — a post-fire-voided line is
 * excluded from that future depletion (`recomputeOrderTotals` drops
 * `voided` lines exactly as a pre-fire void already does), so without this
 * command the physical consumption would go permanently unrecorded.
 *
 * `tx`-FIRST (the `SALE_DEPLETION_COMMAND` precedent): called inside the
 * SAME transaction as the Sales void write, so the line's own state change,
 * the disposition record, and the inventory movement(s) commit or roll back
 * together.
 *
 * "returned_to_stock" has NO command here — it is not a variant of this
 * contract, it is the ABSENCE of a call to it. Nothing was ever physically
 * removed from the sale-depletion ledger (depletion has not run yet), so
 * there is nothing to reverse; see the design gate §7 item 4 and the
 * Sales-side service for the full reasoning.
 *
 * Both dispositions post the SAME `waste` movement type (no new
 * `MovementType` enum value is added — the design gate found no governance
 * ratification distinguishing "given to staff" from "wasted" at the
 * inventory-ledger level); they are told apart by `disposition` in the
 * result/audit metadata and by the caller-supplied `reasonCodeId`, which the
 * caller (Sales) is expected to pick from a reason-code taxonomy
 * differentiating the two, mirroring `WasteService.record`'s own posture
 * that FR-INV-059-style distinctions are "expressible through the
 * reason-code taxonomy, which is tenant-configurable."
 */
export const POST_FIRE_VOID_DISPOSITION_COMMAND = Symbol(
  'POST_FIRE_VOID_DISPOSITION_COMMAND',
);

export type PostFireVoidDispositionValue = 'wasted' | 'given_to_staff';

export interface DispositionComponentInput {
  readonly stockItemId: string;
  /** DECIMAL(18,6) exact string, in the stock item's BASE unit. Positive magnitude. */
  readonly quantityInBaseUnit: string;
}

export interface RecordPostFireVoidDispositionInput {
  readonly tenantId: string;
  readonly actorId: string;
  /** The branch LOCATION this line's stock is drawn down from. */
  readonly branchId: string;
  readonly orderLineId: string;
  readonly disposition: PostFireVoidDispositionValue;
  readonly reasonCodeId: string;
  readonly components: readonly DispositionComponentInput[];
}

export interface DispositionMovementResult {
  readonly stockItemId: string;
  readonly movementId: string;
  readonly unitCost: bigint;
  readonly totalCost: bigint;
}

export interface RecordPostFireVoidDispositionResult {
  readonly movements: readonly DispositionMovementResult[];
  readonly totalValue: bigint;
}

export interface PostFireVoidDispositionCommand {
  recordDisposition(
    tx: Prisma.TransactionClient,
    input: RecordPostFireVoidDispositionInput,
  ): Promise<RecordPostFireVoidDispositionResult>;
}
