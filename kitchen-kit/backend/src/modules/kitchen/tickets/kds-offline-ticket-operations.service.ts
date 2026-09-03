import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import {
  KdsOfflineTicketOperations,
  OfflineBumpLineInput,
  OfflineBumpLineResult,
} from '../contract/offline-ticket-operations';
import { BUMP_ELIGIBLE_STATUSES } from './ticket-projection';
import {
  TICKET_PROJECTION_SELECT,
  TicketProjectionService,
} from './ticket-projection.service';

/**
 * PRIVATE implementation of `kitchen/contract`'s
 * `KdsOfflineTicketOperations` — see that contract file for why this exists
 * as its own tx-scoped, Sync-agnostic seam (D4-1B ACCEPTANCE CORRECTION,
 * module-boundary direction).
 *
 * Deliberately does NOT call `KdsOperationsService.bumpLine`: that method
 * opens its own `UnitOfWork` transaction (`UnitOfWork.execute`), which would
 * nest a second transaction inside whatever transaction the CALLER of this
 * service already owns — forbidden for the offline/sync caller, and not
 * attempted here for any caller. This mirrors the exact same line-status CAS
 * `bumpLineTx` performs, directly against the supplied `tx`, and reuses
 * `TicketProjectionService.apply` UNCHANGED (it already takes an external
 * `tx` and never opens its own).
 */
@Injectable()
export class KdsOfflineTicketOperationsService implements KdsOfflineTicketOperations {
  constructor(
    private readonly projection: TicketProjectionService,
    private readonly audit: AuditService,
  ) {}

  async findTicketBranch(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketId: string,
  ): Promise<{ readonly branchId: string } | null> {
    const ticket = await tx.ticket.findFirst({
      where: { tenantId, id: ticketId },
      select: { branchId: true },
    });
    return ticket ? { branchId: ticket.branchId } : null;
  }

  async bumpLine(
    tx: Prisma.TransactionClient,
    input: OfflineBumpLineInput,
  ): Promise<OfflineBumpLineResult> {
    const ticket = await tx.ticket.findFirst({
      where: { tenantId: input.tenantId, id: input.ticketId },
      select: TICKET_PROJECTION_SELECT,
    });
    if (!ticket) {
      return { kind: 'ticket_not_found' };
    }

    const line = await tx.ticketLine.findFirst({
      where: {
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        id: input.lineId,
      },
    });
    if (!line) {
      return { kind: 'line_not_found' };
    }
    if (line.status === 'cancelled') {
      return { kind: 'line_cancelled' };
    }

    // A line already bumped-or-beyond is a NO-OP, exactly as the online
    // `bumpLineTx` treats it — a stale/duplicate bump attempt is safe rather
    // than an "un-bump".
    if (!BUMP_ELIGIBLE_STATUSES.has(line.status)) {
      return {
        kind: 'applied',
        ticketStatus: ticket.status,
        lineStatus: 'bumped',
      };
    }

    const now = input.occurredAt;
    const updated = await tx.ticketLine.updateMany({
      where: {
        tenantId: input.tenantId,
        id: input.lineId,
        status: { in: [...BUMP_ELIGIBLE_STATUSES] },
      },
      data: {
        status: 'bumped',
        readyAt: now,
        bumpedAt: now,
        bumpedBy: input.actorEmployeeId,
      },
    });
    if (updated.count !== 1) {
      // Lost a race to a concurrent settlement of the SAME line within this
      // transaction window. Not an error — the line is bumped either way.
      return {
        kind: 'applied',
        ticketStatus: ticket.status,
        lineStatus: 'bumped',
      };
    }

    const result = await this.projection.apply(
      tx,
      input.tenantId,
      input.ticketId,
      { bumpActorId: input.actorEmployeeId ?? undefined, now },
    );

    await this.audit.record(tx, {
      tenantId: input.tenantId,
      action: AUDIT_ACTION.TICKET_LINE_BUMPED,
      entityType: AUDIT_ENTITY.TICKET_LINE,
      actorType: input.actorEmployeeId ? 'user' : 'system',
      actorId: input.actorEmployeeId ?? input.terminalId,
      entityId: input.lineId,
      terminalId: input.terminalId,
      metadata: {
        ticketId: input.ticketId,
        correlationId: input.correlationId,
        viaSync: true,
      },
    });

    return {
      kind: 'applied',
      ticketStatus: result.ticket.status,
      lineStatus: 'bumped',
    };
  }
}
