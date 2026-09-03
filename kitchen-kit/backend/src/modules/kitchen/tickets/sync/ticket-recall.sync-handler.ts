import { Inject, Injectable } from '@nestjs/common';
import { TicketLineStatus } from '../../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../../governance/contract';
import { KDS_BRANCH_CONFIG_QUERY } from '../../../organisation/contract';
import type { KdsBranchConfigQuery } from '../../../organisation/contract';
import {
  ConflictRecordService,
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
import { projectTicketStatus } from '../ticket-projection';
import { TICKET_PROJECTION_SELECT } from '../ticket-projection.service';

/**
 * D4-1B production handler — `kds.ticket.recall`.
 *
 * `entityId` is the ticket. No payload fields are required — mirrors
 * `KdsOperationsService.recall`'s whole-ticket semantics.
 *
 * Reimplements `recallTx` directly against `context.tx` for the SAME reason
 * `TicketBumpLineSyncHandler` does not call `KdsOperationsService.bumpLine`
 * (see that handler's docblock): `KdsOperationsService.recall` opens its own
 * transaction via `UnitOfWork.execute`, which a sync handler must never do.
 *
 * ── THE RATIFIED "HIGHER-HLC RECALL IS HONOURED" RULE, AND ITS LIMIT HERE ───
 * D1-1 §6.1 row 15 additionally says "a higher-HLC recall is honoured". This
 * handler enforces the SAME domain-native guards the online path already
 * uses — only a `bumped` ticket may be recalled, and only within the branch's
 * configured recall window (`KDS_BRANCH_CONFIG_QUERY`) — which is a
 * necessary but not sufficient approximation of true per-field HLC LWW: the
 * server has no persisted per-ticket/per-line HLC watermark to compare
 * against (`kitchen.tickets`/`kitchen.ticket_lines` carry no `hlc` column;
 * D1-1 §4.2 records that no domain table has one yet). Adding one is a
 * genuine schema change and is NOT made here unilaterally — see the D4-1B
 * report's revalidation section for why this is a named residual gap rather
 * than a silent one.
 */
@Injectable()
@SyncOperationHandlerFor('kds.ticket.recall')
export class TicketRecallSyncHandler implements SyncOperationHandler {
  readonly operationType = 'kds.ticket.recall';
  readonly supportedSchemaVersions = [1];

  constructor(
    @Inject(SYNC_AUTHORIZATION_PORT)
    private readonly authorization: SyncAuthorizationPort,
    @Inject(KDS_BRANCH_CONFIG_QUERY)
    private readonly kdsBranchConfig: KdsBranchConfigQuery,
    private readonly audit: AuditService,
    private readonly conflictRecords: ConflictRecordService,
  ) {}

  async apply(
    context: SyncOperationContext,
  ): Promise<SyncOperationOutcome | void> {
    const ticketId = context.entityId;

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

    if (ticket.status !== 'bumped') {
      // A stale recall attempt against a ticket that has since moved on
      // (recalled by someone else already, or re-bumped) is exactly the
      // "legal-transition guard prevents a stale operation" case — a
      // definitive, no-effect outcome. `conflict`, not `rejected`: the
      // operation was legitimate when captured, the server's CURRENT state
      // just no longer permits it, and D1-1 §14 (revalidation) requires
      // showing that distinction rather than a bare rejection.
      //
      // FR-OFF-043: both versions are recorded. The `kds.ticket.recall`
      // envelope carries no client-side ticket snapshot (empty payload,
      // matching `KdsOperationsService.recall`'s own whole-ticket, no-body
      // shape) — `localState` therefore records the DOMAIN ASSUMPTION every
      // recall operation implicitly makes ("the ticket I am recalling is
      // bumped"), not a fabricated client value.
      const conflictId = await this.conflictRecords.record(context.tx, {
        tenantId: context.tenantId,
        branchId: ticket.branchId,
        entityType: AUDIT_ENTITY.TICKET,
        entityId: ticketId,
        conflictClass: 'semantic',
        opId: context.opId,
        resolution: 'auto',
        localState: { assumedStatus: 'bumped' },
        serverState: { status: ticket.status },
        terminalId: context.terminalId,
      });
      return {
        status: 'conflict',
        reasonCode: SYNC_REASON.ILLEGAL_TRANSITION,
        reasonDetail: `Ticket is '${ticket.status}', not 'bumped'; only a bumped ticket can be recalled.`,
        conflictId,
      };
    }

    const branchConfig = await this.kdsBranchConfig.find(context.tx, {
      tenantId: context.tenantId,
      branchId: ticket.branchId,
    });
    const now = context.occurredAt;
    const bumpedAt = ticket.bumpedAt;
    const elapsedSeconds = bumpedAt
      ? (now.getTime() - bumpedAt.getTime()) / 1000
      : Number.POSITIVE_INFINITY;
    if (elapsedSeconds > branchConfig.recallWindowSeconds) {
      const conflictId = await this.conflictRecords.record(context.tx, {
        tenantId: context.tenantId,
        branchId: ticket.branchId,
        entityType: AUDIT_ENTITY.TICKET,
        entityId: ticketId,
        conflictClass: 'semantic',
        opId: context.opId,
        resolution: 'auto',
        localState: { assumedWithinRecallWindow: true },
        serverState: {
          bumpedAt: bumpedAt?.toISOString() ?? null,
          elapsedSeconds,
          recallWindowSeconds: branchConfig.recallWindowSeconds,
        },
        terminalId: context.terminalId,
      });
      return {
        status: 'conflict',
        reasonCode: SYNC_REASON.ILLEGAL_TRANSITION,
        reasonDetail: `The recall window (${branchConfig.recallWindowSeconds}s) for this ticket has expired.`,
        conflictId,
      };
    }

    const lines = await context.tx.ticketLine.findMany({
      where: { tenantId: context.tenantId, ticketId },
      select: { id: true, orderLineId: true, status: true, startedAt: true },
    });
    const revertedOrderLineIds: string[] = [];
    const resultingLineFacts: {
      status: TicketLineStatus;
      startedAt: Date | null;
    }[] = [];
    for (const line of lines) {
      if (line.status !== 'bumped') {
        resultingLineFacts.push({
          status: line.status,
          startedAt: line.startedAt,
        });
        continue;
      }
      const restoredStatus = line.startedAt ? 'started' : 'queued';
      await context.tx.ticketLine.update({
        where: { id: line.id },
        data: { status: restoredStatus, recalledAt: now },
      });
      revertedOrderLineIds.push(line.orderLineId);
      resultingLineFacts.push({
        status: restoredStatus,
        startedAt: line.startedAt,
      });
    }

    const newTicketStatus = projectTicketStatus(resultingLineFacts);
    const cas = await context.tx.ticket.updateMany({
      where: {
        id: ticketId,
        tenantId: context.tenantId,
        version: ticket.version,
      },
      data: {
        status: newTicketStatus,
        recalledAt: now,
        recallCount: { increment: 1 },
        version: { increment: 1 },
      },
    });
    if (cas.count === 0) {
      // Lost a concurrent race for this exact ticket's version — a real,
      // resolvable conflict (category B, D4-1B §10): the ticket's state may
      // differ by the time this is retried, but nothing here proves the
      // recall can NEVER apply.
      const conflictId = await this.conflictRecords.record(context.tx, {
        tenantId: context.tenantId,
        branchId: ticket.branchId,
        entityType: AUDIT_ENTITY.TICKET,
        entityId: ticketId,
        conflictClass: 'single_writer',
        opId: context.opId,
        resolution: 'auto',
        localState: { assumedVersion: ticket.version },
        serverState: { currentVersionDiffersFrom: ticket.version },
        terminalId: context.terminalId,
      });
      return {
        status: 'conflict',
        reasonCode: SYNC_REASON.ILLEGAL_TRANSITION,
        reasonDetail: 'Ticket was concurrently modified; recall not applied.',
        conflictId,
      };
    }

    await this.audit.record(context.tx, {
      tenantId: context.tenantId,
      action: AUDIT_ACTION.TICKET_RECALLED,
      entityType: AUDIT_ENTITY.TICKET,
      actorType: context.actorEmployeeId ? 'user' : 'system',
      actorId: context.actorEmployeeId ?? context.terminalId,
      entityId: ticketId,
      terminalId: context.terminalId,
      metadata: {
        opId: context.opId,
        viaSync: true,
        revertedOrderLineIds,
      },
    });

    return {
      status: 'accepted',
      detail: { ticketStatus: newTicketStatus, revertedOrderLineIds },
    };
  }
}
