import { OrderStateError } from './order-state';

/**
 * Payment-specific domain rejections (P1F-1). All extend `OrderStateError`
 * so `SalesDomainExceptionFilter`'s existing `@Catch(OrderStateError, ...)`
 * maps them to 422 with zero filter changes — the same mechanism Fire's
 * own `fire.errors.ts` already relies on.
 */

/**
 * The named CashSession does not satisfy the P1D-G attribution facts this
 * capture requires (wrong branch, wrong employee, wrong terminal, wrong
 * currency, or not OPEN). A missing/cross-tenant id is a separate 404, not
 * this — see `SalesPaymentService.capture()`.
 */
export class InvalidCashSessionError extends OrderStateError {
  readonly code = 'INVALID_CASH_SESSION';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCashSessionError';
  }
}

/** FR-POS-063 — the customer did not tender enough cash to cover the rounded amount due. */
export class InsufficientCashTenderedError extends OrderStateError {
  readonly code = 'INSUFFICIENT_CASH_TENDERED';
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCashTenderedError';
  }
}

/*
 * NOTE — the same permanent client Payment id submitted with DIFFERENT
 * immutable financial facts (FR-OFF-015: a permanent identity is never
 * silently repointed) is NOT a member of this family: it is a 409, not a
 * 422 business-rule refusal, so `SalesPaymentService` throws NestJS's
 * `ConflictException` directly for it — the exact precedent
 * `CashSessionsService.open()`'s own "already exists with different
 * content" case already establishes.
 */
