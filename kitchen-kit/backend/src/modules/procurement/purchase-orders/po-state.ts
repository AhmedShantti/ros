import { ConflictException } from '@nestjs/common';

/**
 * Optimistic concurrency (SRS §24.6.4 convention, mirrors `Order.version` /
 * `sales/orders/order-state.ts`'s own `assertVersion`). Throws BEFORE any
 * write, so a stale caller causes no partial write and no audit event.
 */
export function assertPoVersion(current: number, expected: number): number {
  if (current !== expected) {
    throw new ConflictException(
      `Version mismatch: the purchase order is at version ${current}, but ` +
        `the request expected ${expected}. Reload it and retry.`,
    );
  }
  return current + 1;
}
