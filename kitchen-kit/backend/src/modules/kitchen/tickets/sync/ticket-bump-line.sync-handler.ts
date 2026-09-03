import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../../governance/contract';
import { UUID_PATTERN } from '../../../../common/ids';
import {
  SYNC_AUTHORIZATION_PORT,
  SYNC_REASON,
  SyncOperationHandlerFor,
  SyncOperationRejectedError,
} from '../../../sync/contract';
import type {
  SyncAuthorizationPort,
  SyncOperationContext,
  SyncOperationHandler,
  SyncOperationOutcome,
} from '../../../sync/contract';
import { KDS_PERMISSIONS } from '../../kitchen.permissions';
import { BUMP_ELIGIBLE_STATUSES } from '../ticket-projection';
import {
  TICKET_PROJECTION_SELECT,
  TicketProjectionService,
} from '../ticket-projection.service';

interface BumpLinePayload {
  readonly lineId: string;
}

function parsePayload(payload: unknown): BumpLinePayload {
  if (payload === null || typeof payload !== 'object') {
    throw new SyncOperationRejectedError(
      SYNC_REASON.PAYLOAD_INVALID,
      'kds.ticket.bump_line requires a payload object.',
    );
  }
  const lineId = (payload as Record<string, unknown>).lineId;
  if (typeof lineId !== 'string' || !UUID_PATTERN.test(lineId)) {
    throw new SyncOperationRejectedError(
      SYNC_REASON.PAYLOAD_INVALID,
      'kds.ticket.bump_line payload requires a UUID `lineId`.',
    );
  }
  return { lineId };
}

/**
 * D4-1B production handler — `kds.ticket.bump_line`.
 *
 * `entityId` is the TICKET (the aggregate, matching every online KDS route);
 * `payload.lineId` names the line within it — the same split
 * `KdsOperationsService.bumpLine` uses online.
 *
 * ── WHY THIS IS NOT A THIN WRAPPER AROUND `KdsOperationsService.bumpLine` ───
 * `KdsOperationsService.bumpLine` calls `UnitOfWork.execute`, which ALWAYS
 * opens its own `withAuthContext` transaction. A sync handler receives the
 * KERNEL's OWN `Prisma.TransactionClient` (`SyncOperationContext.tx`) and MUST
 * NOT open a second one — see that contract's docblock on the atomicity
 * invariant. This handler therefore re-implements the SAME line-status CAS
 * `bumpLineTx` performs, directly against `context.tx`, and reuses
 * `TicketProjectionService.apply` UNCHANGED (it already takes an external
 * `tx` and never opens its own — verified before reuse).
 *
 * ── WHAT IS DELIBERATELY NOT DONE HERE (named, not silent) ──────────────────
 * The online path's `publishTicketBumped` cross-station readiness SELECT is
 * SERIALIZABLE-protected (KDS acceptance correction 2026-08-31) specifically
 * because it is subject to write skew under weaker isolation. The Sync
 * kernel's chunk transaction does NOT run at SERIALIZABLE (`NFR-PERF-032`
 * would be unreachable if every chunk paid that cost), so this handler does
 * NOT publish `TICKET_BUMPED_EVENT` — publishing it here would risk silently
 * reintroducing the exact anomaly class that correction fixed, under weaker
 * protection than the correction requires. The ticket/ticket-line state
 * mutation and its audit entry are the durable, correct effect; cross-station
 * "ready to serve" notification for a SYNC-applied bump is a named residual
 * gap (see the D4-1B report).
 *
 * Station-level narrowing (`KdsStationGuard`'s "terminal bound to EXACTLY ONE
 * kds-type station") is likewise not enforced here — Sync's terminal model
 * carries no station binding. Authorization is `kds.operate` at the TICKET's
 * own branch (server-loaded, never client-asserted), which is strictly
 * narrower than "any branch" but coarser than the online station gate. Named
 * in the D4-1B report, not hidden.
 */
@Injectable()
@SyncOperationHandlerFor('kds.ticket.bump_line')
export class TicketBumpLineSyncHandler implements SyncOperationHandler {
  readonly operationType = 'kds.ticket.bump_line';
  readonly supportedSchemaVersions = [1];

  constructor(
    @Inject(SYNC_AUTHORIZATION_PORT)
    private readonly authorization: SyncAuthorizationPort,
    private readonly projection: TicketProjectionService,
    private readonly audit: AuditService,
  ) {}

  async apply(
    context: SyncOperationContext,
  ): Promise<SyncOperationOutcome | void> {
    const { lineId } = parsePayload(context.payload);
    const ticketId = context.entityId;

    // Tenant-safe resource load BEFORE authorization, so the target scope
    // used for the permission check is the ticket's REAL branch — never the
    // terminal's own branch trusted blindly (P-D4-01 §11 revalidation rule:
    // the server's current authoritative state wins).
    const ticket = await context.tx.ticket.findFirst({
      where: { tenantId: context.tenantId, id: ticketId },
      select: TICKET_PROJECTION_SELECT,
    });
    if (!ticket) {
      throw new SyncOperationRejectedError(
        SYNC_REASON.RESOURCE_NOT_FOUND,
        `Ticket ${ticketId} was not found.`,
      );
    }

    const allowed = await this.authorization.isAllowed(context.tx, {
      tenantId: context.tenantId,
      terminalId: context.terminalId,
      branchId: context.branchId,
      actorEmployeeId: context.actorEmployeeId,
      permission: KDS_PERMISSIONS.OPERATE,
      targetBranchId: ticket.branchId,
    });
    if (!allowed) {
      throw new SyncOperationRejectedError(
        SYNC_REASON.AUTHORIZATION_DENIED,
        'Not authorized to operate this kitchen ticket.',
      );
    }

    const line = await context.tx.ticketLine.findFirst({
      where: { tenantId: context.tenantId, ticketId, id: lineId },
    });
    if (!line) {
      throw new SyncOperationRejectedError(
        SYNC_REASON.RESOURCE_NOT_FOUND,
        `Ticket line ${lineId} was not found on ticket ${ticketId}.`,
      );
    }
    if (line.status === 'cancelled') {
      throw new SyncOperationRejectedError(
        SYNC_REASON.ILLEGAL_TRANSITION,
        'A cancelled line cannot be bumped.',
      );
    }

    // A line already bumped-or-beyond is a NO-OP, exactly as the online
    // `bumpLineTx` treats it — this is what makes a stale/duplicate bump
    // attempt safe rather than an "un-bump", the legal-transition-guard half
    // of the ratified KDS conflict rule (D1-1 §6.1 row 15).
    if (!BUMP_ELIGIBLE_STATUSES.has(line.status)) {
      return {
        status: 'accepted',
        detail: { ticketStatus: ticket.status, lineStatus: line.status },
      };
    }

    const now = context.occurredAt;
    const updated = await context.tx.ticketLine.updateMany({
      where: {
        tenantId: context.tenantId,
        id: lineId,
        status: { in: [...BUMP_ELIGIBLE_STATUSES] },
      },
      data: {
        status: 'bumped',
        readyAt: now,
        bumpedAt: now,
        bumpedBy: context.actorEmployeeId,
      },
    });
    if (updated.count !== 1) {
      // Lost a race to a concurrent settlement of the SAME line within this
      // batch/tx window. Not an error — the line is bumped either way.
      return {
        status: 'accepted',
        detail: { ticketStatus: ticket.status, lineStatus: 'bumped' },
      };
    }

    const result = await this.projection.apply(
      context.tx,
      context.tenantId,
      ticketId,
      { bumpActorId: context.actorEmployeeId ?? undefined, now },
    );

    await this.audit.record(context.tx, {
      tenantId: context.tenantId,
      action: AUDIT_ACTION.TICKET_LINE_BUMPED,
      entityType: AUDIT_ENTITY.TICKET_LINE,
      actorType: context.actorEmployeeId ? 'user' : 'system',
      actorId: context.actorEmployeeId ?? context.terminalId,
      entityId: lineId,
      terminalId: context.terminalId,
      metadata: {
        ticketId,
        opId: context.opId,
        viaSync: true,
      },
    });

    return {
      status: 'accepted',
      detail: {
        ticketStatus: result.ticket.status,
        lineStatus: 'bumped',
      },
    };
  }
}
