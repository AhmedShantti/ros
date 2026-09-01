import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { projectTicketStatus } from './ticket-projection';

export const TICKET_PROJECTION_SELECT = {
  id: true,
  tenantId: true,
  branchId: true,
  orderId: true,
  businessDay: true,
  stationId: true,
  status: true,
  version: true,
  startedAt: true,
  startedBy: true,
  readyAt: true,
  bumpedAt: true,
  bumpedBy: true,
  recallCount: true,
} satisfies Prisma.TicketSelect;

export type TicketProjectionRow = Prisma.TicketGetPayload<{
  select: typeof TICKET_PROJECTION_SELECT;
}>;

const MAX_PROJECTION_CAS_ATTEMPTS = 5;

export interface ApplyTicketProjectionOptions {
  readonly startInfo?: { readonly startedAt: Date; readonly startedBy: string };
  readonly bumpActorId?: string;
  readonly now: Date;
}

export interface ApplyTicketProjectionResult {
  readonly ticket: TicketProjectionRow;
  readonly transitionedToBumped: boolean;
}

/**
 * Design gate §11/§16 ticket-aggregate projection CAS, bounded local retry —
 * a SEPARATE concern from the outer SERIALIZABLE whole-UoW retry
 * `KdsOperationsService.bumpLine`/`bumpAll`/`recall` use: this loop resolves
 * a same-ticket, same-transaction-attempt race (e.g. two concurrent `start`
 * calls on different lines of one ticket, which does not use SERIALIZABLE
 * at all) by re-reading and recomputing — never by locking.
 *
 * Extracted (acceptance correction 2026-08-31, Blocker C) into its own
 * service so it has exactly ONE caller-independent definition, shared by
 * `KdsOperationsService` (start/bump/bump-all) AND
 * `OrderLineFiredHandler` (amendment-line reactivation, §7 of that
 * correction): a genuinely NEW `TicketLine` inserted into an EXISTING
 * Ticket must recompute that Ticket's aggregate from its (now-widened) line
 * set exactly the same way a bump/start does — there is no second,
 * divergent implementation of "what status does this Ticket's line set
 * imply".
 */
@Injectable()
export class TicketProjectionService {
  async apply(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketId: string,
    opts: ApplyTicketProjectionOptions,
  ): Promise<ApplyTicketProjectionResult> {
    for (let attempt = 0; attempt < MAX_PROJECTION_CAS_ATTEMPTS; attempt += 1) {
      const ticket = await tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: TICKET_PROJECTION_SELECT,
      });
      const lines = await tx.ticketLine.findMany({
        where: { tenantId, ticketId },
        select: { status: true, startedAt: true },
      });
      const newStatus = projectTicketStatus(lines);

      const data: Prisma.TicketUpdateInput = {};
      // `startedAt`/`startedBy` are write-once FOREVER (FR-KDS-041's "by
      // employee" attribution names the FIRST line start on the ticket —
      // an amendment or a recall never resets who/when that was).
      if (opts.startInfo && ticket.startedAt === null) {
        data.startedAt = opts.startInfo.startedAt;
        data.startedBy = opts.startInfo.startedBy;
      }
      const transitioningIntoBumped =
        newStatus === 'bumped' && ticket.status !== 'bumped';
      // `readyAt`/`bumpedAt`/`bumpedBy` refresh on every genuine transition
      // INTO ready/bumped — not merely the first ever. Acceptance
      // correction (2026-08-31), Blockers B/C: design gate §14 already
      // specifies bumped_at is "preserved... UNTIL a later successful
      // re-bump" (recall, then re-bump) — a null-guard preserves it
      // FOREVER instead, which is also wrong for a genuine amendment
      // re-bump (§7: "a later successful bump of the amendment... must be
      // capable of publishing again for that NEW aggregate transition").
      // Comparing against the CURRENT status (not against null) is what
      // makes both cases correct: within one still-`ready`/`bumped` cycle,
      // additional lines reaching ready/bumped do not disturb the instant
      // the TICKET first reached that status; a genuine new cycle (recall
      // or amendment reactivated it back to queued/in_progress first) does.
      if (
        (newStatus === 'ready' || newStatus === 'bumped') &&
        newStatus !== ticket.status
      ) {
        data.readyAt = opts.now;
      }
      if (transitioningIntoBumped) {
        data.bumpedAt = opts.now;
        data.bumpedBy = opts.bumpActorId ?? null;
      }
      if (newStatus !== ticket.status) {
        data.status = newStatus;
      }

      if (Object.keys(data).length === 0) {
        return { ticket, transitionedToBumped: false };
      }

      const result = await tx.ticket.updateMany({
        where: { id: ticketId, tenantId, version: ticket.version },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count === 1) {
        return {
          ticket: {
            ...ticket,
            status: newStatus,
            startedAt: (data.startedAt as Date | undefined) ?? ticket.startedAt,
            startedBy:
              (data.startedBy as string | undefined) ?? ticket.startedBy,
            readyAt: (data.readyAt as Date | undefined) ?? ticket.readyAt,
            bumpedAt: (data.bumpedAt as Date | undefined) ?? ticket.bumpedAt,
            bumpedBy:
              (data.bumpedBy as string | null | undefined) ?? ticket.bumpedBy,
            version: ticket.version + 1,
          },
          transitionedToBumped: transitioningIntoBumped,
        };
      }
      // Lost the CAS race — another statement in THIS transaction attempt
      // (a concurrent line write within the same request context is not
      // possible; this guards the same-ticket-different-attempt window)
      // already advanced `version`. Re-read and recompute.
    }
    throw new ConflictException(
      'Ticket projection could not converge after repeated attempts.',
    );
  }
}
