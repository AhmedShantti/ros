import { Prisma } from '../../../generated/prisma/client';

/**
 * Inventory PUBLIC contract — P1F-2. The one thing Sales needs from
 * Inventory at Order Completion: deplete stock for a completed sale on
 * BOTH the physical (fifo|fefo) and FIFO-cost (receipt-order) axes,
 * reserve-first (P1F2E-A §E), and return the valued allocations Sales posts
 * as COGS.
 *
 * Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
 * correction.md (CONTROLLING) §L "E. INVENTORY — DUAL AXIS".
 *
 * Inventory resolves the branch LOCATION itself, from `org.locations`
 * (`tenant_id`, `location_type='branch'`, `ref_id=branchId`) — the caller
 * supplies only the branch id, never a location id.
 */
export const SALE_DEPLETION_COMMAND = Symbol('SALE_DEPLETION_COMMAND');

export interface SaleDepletionComponentInput {
  readonly stockItemId: string;
  /** DECIMAL(18,6) exact string, in the stock item's base unit. */
  readonly quantityInBaseUnit: string;
  readonly unitId: string;
}

export interface SaleDepletionLineInput {
  readonly orderLineId: string;
  readonly components: readonly SaleDepletionComponentInput[];
}

export interface DepleteForCompletedSaleInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly branchId: string;
  readonly orderId: string;
  readonly businessDay: Date;
  readonly occurredAt: Date;
  readonly lines: readonly SaleDepletionLineInput[];
}

export interface SaleDepletionAllocationResult {
  readonly id: string;
  readonly sequence: number;
  readonly physicalBatchId: string | null;
  readonly costBasisBatchId: string | null;
  /** DECIMAL(18,6) exact string. */
  readonly quantityInBaseUnit: string;
  readonly unitId: string;
  readonly unitCost: bigint;
  /** Positive magnitude (repo convention). */
  readonly totalCost: bigint;
  readonly movementId: string;
  readonly movementOccurredAt: Date;
}

export interface SaleDepletionEffectResult {
  readonly effectId: string;
  readonly stockItemId: string;
  readonly locationId: string;
  readonly allocations: readonly SaleDepletionAllocationResult[];
}

export interface SaleDepletionLineResult {
  readonly orderLineId: string;
  /** Exact bigint SUM of this line's allocation total_cost values. */
  readonly postedCogsTotal: bigint;
  readonly effects: readonly SaleDepletionEffectResult[];
}

export interface DepleteForCompletedSaleResult {
  readonly perLine: readonly SaleDepletionLineResult[];
  /** The DISTINCT costing_method=fifo stock item ids touched — for the ONE recomputeForStockItems call. */
  readonly distinctFifoStockItemIds: readonly string[];
}

export interface SaleDepletionCommand {
  depleteForCompletedSale(
    tx: Prisma.TransactionClient,
    input: DepleteForCompletedSaleInput,
  ): Promise<DepleteForCompletedSaleResult>;
}
