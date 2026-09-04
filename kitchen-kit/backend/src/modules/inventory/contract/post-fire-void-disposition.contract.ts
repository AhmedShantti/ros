import { Prisma } from '../../../generated/prisma/client';

/**
 * Inventory PUBLIC contract — POS-FIN-1 (acceptance-corrected 2026-09-04).
 * The disposition command a post-fire void needs (FR-POS-071): "each
 * post-fire disposition classification SHALL create the corresponding
 * inventory record" — literally, for ALL THREE classifications, not only
 * the two that post a stock movement. "wasted" and "given to staff" record
 * the PHYSICAL consumption a produced item already caused, even though this
 * system's ordinary sale-depletion accounting (`SALE_DEPLETION_COMMAND`)
 * runs at Order COMPLETION, not at Fire — a post-fire-voided line is
 * excluded from that future depletion (`recomputeOrderTotals` drops
 * `voided` lines exactly as a pre-fire void already does), so without a
 * movement the physical consumption would go permanently unrecorded.
 *
 * `tx`-FIRST (the `SALE_DEPLETION_COMMAND` precedent): called inside the
 * SAME transaction as the Sales void write, so the line's own state change,
 * the disposition record, and any inventory movement(s) commit or roll back
 * together.
 *
 * ── "returned_to_stock" IS STILL CALLED, BUT POSTS NO MOVEMENT ──────────
 * The acceptance correction's own instruction is explicit: no fake
 * positive/negative movement may be fabricated just to manufacture a
 * ledger row. Nothing was ever physically removed from the sale-depletion
 * ledger (depletion has not run yet), so there is nothing to reverse — but
 * the CLASSIFICATION EVENT itself is still durably, append-only recorded
 * (`inventory.post_fire_void_disposition_records`, `movementIds: []`,
 * `totalValue: 0n`), which is what makes "returned_to_stock" satisfy
 * FR-POS-071's literal "SHALL create the corresponding inventory record"
 * — a Sales-owned `sales.post_fire_void_records` row is NOT that record;
 * this Inventory-owned one is.
 *
 * `wasted`/`given_to_staff` post the SAME `waste` movement type (no new
 * `MovementType` enum value is added — the design gate found no governance
 * ratification distinguishing "given to staff" from "wasted" at the
 * inventory-ledger level); they are told apart by `disposition` on the
 * returned/persisted record and by the caller-supplied `reasonCodeId`,
 * which the caller (Sales) is expected to pick from a reason-code taxonomy
 * differentiating the two, mirroring `WasteService.record`'s own posture
 * that FR-INV-059-style distinctions are "expressible through the
 * reason-code taxonomy, which is tenant-configurable."
 */
export const POST_FIRE_VOID_DISPOSITION_COMMAND = Symbol(
  'POST_FIRE_VOID_DISPOSITION_COMMAND',
);

export type PostFireVoidDispositionValue =
  'returned_to_stock' | 'wasted' | 'given_to_staff';

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
  /**
   * The components considered — populated for ALL THREE dispositions, even
   * `returned_to_stock` (which posts no movement for them). An empty array
   * is legal (e.g. a line with no recipe) and still produces a record.
   */
  readonly components: readonly DispositionComponentInput[];
}

export interface DispositionMovementResult {
  readonly stockItemId: string;
  readonly movementId: string;
  readonly unitCost: bigint;
  readonly totalCost: bigint;
}

export interface RecordPostFireVoidDispositionResult {
  /** The new `inventory.post_fire_void_disposition_records` row's id. */
  readonly dispositionRecordId: string;
  /** Always `[]` for `returned_to_stock`. */
  readonly movements: readonly DispositionMovementResult[];
  /** Always `0n` for `returned_to_stock`. */
  readonly totalValue: bigint;
}

export interface PostFireVoidDispositionCommand {
  recordDisposition(
    tx: Prisma.TransactionClient,
    input: RecordPostFireVoidDispositionInput,
  ): Promise<RecordPostFireVoidDispositionResult>;
}
