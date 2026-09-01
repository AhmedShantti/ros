import { Prisma } from '../../../generated/prisma/client';

/**
 * Treasury PUBLIC contract — the shared Order-create/DayClose cutover fence
 * (pre-ratification final correction §4.4, "Option B"). Consumed by Sales'
 * `OrdersService.create` INSIDE its own transaction, immediately AFTER
 * acquiring the existing `ros_order_number(branchId, businessDay)` advisory
 * lock and BEFORE its `Order` `INSERT`. DayClose acquires the SAME fence
 * before its own final close checks. Neither side invents a second lock
 * namespace — see `sales/orders/orders.service.ts:allocateOrderNumber`.
 *
 * `isClosed` is `tx`-FIRST — it MUST run inside the CALLER's own
 * transaction (never a second one; no HTTP dependency; no circular service
 * call), so the read is coherent with whatever else that transaction does.
 * Sales -> Treasury public-contract consumption is already precedented with
 * zero `KNOWN_DEVIATIONS` (`sales-payment.service.ts`'s
 * `CASH_SESSION_FACTS_QUERY` use), on a module edge already `forwardRef`-
 * resolved in both directions (`sales.module.ts` / `treasury.module.ts`).
 */
export const DAY_CLOSE_STATE_QUERY = Symbol('DAY_CLOSE_STATE_QUERY');

export interface DayCloseStateQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly businessDay: Date;
}

export interface DayCloseStateQuery {
  isClosed(
    tx: Prisma.TransactionClient,
    input: DayCloseStateQueryInput,
  ): Promise<boolean>;
}
