import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';
import { ORG_LOCATION_TARGET_RESOLVER } from '../../organisation/contract';

/**
 * PRIVATE implementations of Inventory's resource-derived targets.
 *
 * Both delegate the final location→scope step to Organisation's published
 * `ORG_LOCATION_TARGET_RESOLVER` rather than re-deciding it. A location is a
 * branch, a branch-owned warehouse, a standalone warehouse or a central kitchen,
 * and that mapping is Organisation's fact. Two copies of it would eventually
 * disagree, and the copy that disagreed in the permissive direction would be an
 * authorization hole.
 */
@Injectable()
export class CountSessionTargetResolver implements ScopeTargetResolver {
  constructor(
    @Inject(ORG_LOCATION_TARGET_RESOLVER)
    private readonly location: ScopeTargetResolver,
  ) {}

  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const sessionId = input.keys.sessionId;
    if (!sessionId) return null;
    const session = await tx.countSession.findUnique({
      where: { id: sessionId },
      select: { locationId: true },
    });
    if (!session) return null;
    return this.location.resolve(tx, {
      tenantId: input.tenantId,
      keys: { locationId: session.locationId },
    });
  }
}

@Injectable()
export class CountLineTargetResolver implements ScopeTargetResolver {
  constructor(
    @Inject(ORG_LOCATION_TARGET_RESOLVER)
    private readonly location: ScopeTargetResolver,
  ) {}

  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const lineId = input.keys.lineId;
    if (!lineId) return null;
    const line = await tx.countLine.findUnique({
      where: { id: lineId },
      select: { session: { select: { locationId: true } } },
    });
    if (!line) return null;
    return this.location.resolve(tx, {
      tenantId: input.tenantId,
      keys: { locationId: line.session.locationId },
    });
  }
}
