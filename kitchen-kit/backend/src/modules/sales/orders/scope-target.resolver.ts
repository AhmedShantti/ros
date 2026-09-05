import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/**
 * PRIVATE implementation of `SALES_ORDER_TARGET_RESOLVER`.
 *
 * The business day is part of the primary key of a partitioned table, so it is
 * taken from the path alongside the id — exactly as the handlers already do.
 * A malformed business day never reaches here: the guard checks the
 * `YYYY-MM-DD` shape first and defers to the route's own 400 otherwise.
 */
@Injectable()
export class OrderTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const { orderId, businessDay } = input.keys;
    if (!orderId || !businessDay) return null;
    const order = await tx.order.findFirst({
      where: { id: orderId, businessDay: new Date(`${businessDay}T00:00:00Z`) },
      select: { branchId: true },
    });
    return order ? { type: 'branch', branchId: order.branchId } : null;
  }
}
