import { OrderStateError } from './order-state';

/**
 * A receipt was requested for an order that has not reached `completed`.
 *
 * Extends `OrderStateError` so `SalesDomainExceptionFilter`'s existing
 * `@Catch(OrderStateError, ...)` maps it to 422 with zero filter changes —
 * the same mechanism `fire.errors.ts` and `payment.errors.ts` already rely
 * on. A GET carries no precondition to go stale, so this is never a 409:
 * the request is well formed and the domain refuses it (422), not a caller
 * racing a change (409) — see `sales-domain-exception.filter.ts`'s own
 * documented 409-vs-422 rule.
 */
export class ReceiptNotAvailableError extends OrderStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptNotAvailableError';
  }
}
