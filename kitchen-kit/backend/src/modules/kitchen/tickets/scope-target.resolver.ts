import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/** PRIVATE implementation of `KDS_TICKET_TARGET_RESOLVER`. */
@Injectable()
export class TicketTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const ticketId = input.keys.ticketId;
    if (!ticketId) return null;
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: { branchId: true },
    });
    return ticket ? { type: 'branch', branchId: ticket.branchId } : null;
  }
}
