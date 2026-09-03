import { Inject, Injectable } from '@nestjs/common';
import { UUID_PATTERN } from '../../../common/ids';
import {
  KDS_OFFLINE_TICKET_OPERATIONS,
  KDS_PERMISSIONS,
} from '../../kitchen/contract';
import type { KdsOfflineTicketOperations } from '../../kitchen/contract';
import {
  SYNC_AUTHORIZATION_PORT,
  SYNC_REASON,
  SyncOperationHandlerFor,
  SyncOperationRejectedError,
} from '../contract';
import type {
  SyncAuthorizationPort,
  SyncOperationContext,
  SyncOperationHandler,
  SyncOperationOutcome,
} from '../contract';

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
 * D4-1B ACCEPTANCE CORRECTION — MODULE BOUNDARY.
 *
 * This class is the ENTIRE Sync-side surface for `kds.ticket.bump_line`. It
 * is registered here, in `modules/sync` (not in `modules/kitchen` — compare
 * the first implementation's `kitchen/tickets/sync/ticket-bump-line.sync-
 * handler.ts`, now removed), because it is protocol/integration plumbing —
 * envelope parsing, authorization-request shaping, outcome mapping — not a
 * ticket/line business rule. It contains NO ticket/line domain logic: every
 * actual rule (legal-transition guard, CAS, no-op-on-already-bumped, audit
 * write) lives in `KdsOfflineTicketOperationsService`, reached ONLY through
 * `kitchen/contract`'s `KdsOfflineTicketOperations` — the published domain
 * seam, never a private `kitchen/tickets/...` path.
 *
 * Two-step authorization mirrors the online path's own rule (server state
 * wins over any offline capture-time assumption): resolve the ticket's
 * CURRENT branch first, authorize `kds.operate` against THAT branch, and
 * only then call the mutating operation — never trust the terminal's own
 * branch for a resource-scoped permission check.
 */
@Injectable()
@SyncOperationHandlerFor('kds.ticket.bump_line')
export class KdsTicketBumpLineSyncHandler implements SyncOperationHandler {
  readonly operationType = 'kds.ticket.bump_line';
  readonly supportedSchemaVersions = [1];

  constructor(
    @Inject(SYNC_AUTHORIZATION_PORT)
    private readonly authorization: SyncAuthorizationPort,
    @Inject(KDS_OFFLINE_TICKET_OPERATIONS)
    private readonly kitchen: KdsOfflineTicketOperations,
  ) {}

  async apply(
    context: SyncOperationContext,
  ): Promise<SyncOperationOutcome | void> {
    const { lineId } = parsePayload(context.payload);
    const ticketId = context.entityId;

    const facts = await this.kitchen.findTicketBranch(
      context.tx,
      context.tenantId,
      ticketId,
    );
    if (!facts) {
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
      targetBranchId: facts.branchId,
      actorCache: context.actorCache,
    });
    if (!allowed) {
      throw new SyncOperationRejectedError(
        SYNC_REASON.AUTHORIZATION_DENIED,
        'Not authorized to operate this kitchen ticket.',
      );
    }

    const result = await this.kitchen.bumpLine(context.tx, {
      tenantId: context.tenantId,
      ticketId,
      lineId,
      actorEmployeeId: context.actorEmployeeId,
      terminalId: context.terminalId,
      occurredAt: context.occurredAt,
      correlationId: context.opId,
    });

    switch (result.kind) {
      case 'ticket_not_found':
        throw new SyncOperationRejectedError(
          SYNC_REASON.RESOURCE_NOT_FOUND,
          `Ticket ${ticketId} was not found.`,
        );
      case 'line_not_found':
        throw new SyncOperationRejectedError(
          SYNC_REASON.RESOURCE_NOT_FOUND,
          `Ticket line ${lineId} was not found on ticket ${ticketId}.`,
        );
      case 'line_cancelled':
        throw new SyncOperationRejectedError(
          SYNC_REASON.ILLEGAL_TRANSITION,
          'A cancelled line cannot be bumped.',
        );
      case 'applied':
        return {
          status: 'accepted',
          detail: {
            ticketStatus: result.ticketStatus,
            lineStatus: result.lineStatus,
          },
        };
    }
  }
}
