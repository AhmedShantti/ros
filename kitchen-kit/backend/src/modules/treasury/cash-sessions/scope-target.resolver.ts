import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/**
 * PRIVATE implementation of `TREASURY_CASH_SESSION_TARGET_RESOLVER`.
 *
 * Runs inside the caller's RLS transaction: a session in another tenant is
 * invisible and yields `null`, so the route answers with its ordinary
 * tenant-safe 404 and the authorization layer never becomes an existence
 * oracle. A session in a SIBLING branch of the same tenant resolves normally
 * and is then refused by the lattice — which is the intended, visible
 * difference between "not yours" and "not there".
 */
@Injectable()
export class CashSessionTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const sessionId = input.keys.sessionId;
    if (!sessionId) return null;
    const session = await tx.cashSession.findUnique({
      where: { id: sessionId },
      select: { branchId: true },
    });
    return session ? { type: 'branch', branchId: session.branchId } : null;
  }
}
