import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import { SerializationRetryExhaustedError } from '../../../common/domain-events/serialization-retry';
import { Prisma, TicketLineStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import { KDS_BRANCH_CONFIG_QUERY } from '../../organisation/contract';
import type { KdsBranchConfigQuery } from '../../organisation/contract';
import {
  TICKET_BUMPED_EVENT_TYPE,
  TICKET_BUMPED_EVENT_VERSION,
  TICKET_RECALLED_EVENT_TYPE,
  TICKET_RECALLED_EVENT_VERSION,
} from '../contract';
import { TicketCardDto, TicketCardLineDto } from './ticket-reader.types';
import { TicketReaderService } from './ticket-reader.service';
import {
  BUMP_ELIGIBLE_STATUSES,
  projectTicketStatus,
} from './ticket-projection';
import {
  TICKET_PROJECTION_SELECT,
  TicketProjectionService,
} from './ticket-projection.service';
import type { TicketProjectionRow } from './ticket-projection.service';

const KDS_SERIALIZABLE_RETRY = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxAttempts: 3,
} as const;

export interface KdsActionScope {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly employeeId: string;
  readonly stationId: string;
}

export interface AcknowledgeViewedInput extends KdsActionScope {
  readonly ticketIds: readonly string[];
}

export interface TicketLineActionInput extends KdsActionScope {
  readonly ticketId: string;
  readonly lineId: string;
}

export interface TicketActionInput extends KdsActionScope {
  readonly ticketId: string;
}

/**
 * KDS operator lifecycle mutations — design gate §9–§16, §22–§23, corrected
 * by the acceptance correction §1–§4. The only code in this repository that
 * writes `kitchen.tickets.{first_viewed_at,started_at,ready_at,bumped_at,
 * bumped_by,recalled_at,recall_count,status,version}` and the equivalent
 * `kitchen.ticket_lines` columns.
 *
 * Station authorization (`ticket.stationId === scope.stationId`) is
 * re-verified INSIDE every transaction from the freshly loaded Ticket row —
 * `KdsStationGuard` establishes the caller's OWN operative station once per
 * request, but a route never trusts a client-supplied station for the
 * TICKET itself (design gate §6): a ticket at a foreign station is a 403,
 * never silently operated.
 */
@Injectable()
export class KdsOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly reader: TicketReaderService,
    private readonly projection: TicketProjectionService,
    @Inject(KDS_BRANCH_CONFIG_QUERY)
    private readonly kdsBranchConfig: KdsBranchConfigQuery,
  ) {}

  /**
   * `POST /kds/stations/{stationId}/tickets/view` — design gate §9,
   * acceptance correction §2, extended by the 2026-08-31 acceptance
   * correction Blocker D (amendment lines added after the ticket was first
   * viewed).
   *
   * `Ticket.firstViewedAt` is write-once FOREVER (unchanged) — it records
   * the ORIGINAL first-view instant. `TicketLine.firstViewedAt` is ALSO
   * write-once, but per-LINE, not per-TICKET: an amendment fire
   * (`OrderLineFiredHandler`) can add a brand-new `queued` line to a Ticket
   * that was already fully viewed, and FR-KDS-040 requires that new line to
   * get its own first-viewed timestamp once the operator actually
   * acknowledges it — a ticket-level `firstViewedAt IS NULL` gate would
   * make that line's timestamp permanently unreachable. Line stamping is
   * therefore scoped to every AUTHORIZED ticket (tenant- and station-safe),
   * never merely the subset whose TICKET-level stamp was newly set.
   */
  async acknowledgeViewed(
    input: AcknowledgeViewedInput,
  ): Promise<{ acknowledged: number }> {
    const { tenantId, actorUserId, employeeId, stationId, ticketIds } = input;
    if (ticketIds.length === 0) {
      return { acknowledged: 0 };
    }
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const now = new Date();
        // Tenant- and station-safe: a foreign-station ticket id in the
        // batch is simply excluded here and touched nowhere below.
        const authorizedTickets = await tx.ticket.findMany({
          where: { tenantId, id: { in: [...ticketIds] }, stationId },
          select: { id: true },
        });
        const authorizedIds = authorizedTickets.map((t) => t.id);
        if (authorizedIds.length === 0) {
          return { acknowledged: 0 };
        }

        // Ticket-level stamp — write-once, unchanged from before.
        const stampedTickets = await tx.ticket.updateManyAndReturn({
          where: { tenantId, id: { in: authorizedIds }, firstViewedAt: null },
          data: { firstViewedAt: now },
          select: { id: true },
        });
        const newlyStampedTicketIds = new Set(stampedTickets.map((t) => t.id));

        // Line-level stamp — scoped to every AUTHORIZED ticket (§ above),
        // not merely `newlyStampedTicketIds`, so an amendment line on an
        // ALREADY-viewed ticket is still reachable.
        const stampedLines = await tx.ticketLine.updateManyAndReturn({
          where: {
            tenantId,
            ticketId: { in: authorizedIds },
            firstViewedAt: null,
          },
          data: { firstViewedAt: now },
          select: { id: true, ticketId: true },
        });

        if (newlyStampedTicketIds.size === 0 && stampedLines.length === 0) {
          // A pure replay (zero changed rows) — derive this from the
          // RETURNING sets, never from the request body, and write no
          // audit entry (acceptance correction §2.3's structural rule,
          // extended here to also cover the "amendment already
          // acknowledged" replay case).
          return { acknowledged: 0 };
        }

        const newLineIdsByTicket = new Map<string, string[]>();
        for (const line of stampedLines) {
          const bucket = newLineIdsByTicket.get(line.ticketId) ?? [];
          bucket.push(line.id);
          newLineIdsByTicket.set(line.ticketId, bucket);
        }
        // Exactly one `TICKET_VIEWED` entry per ticket with ANY newly-
        // stamped fact — the ticket's own first view, OR at least one of
        // its lines (an amendment) newly viewed on an already-viewed
        // ticket. Never one entry per line (design gate §23's
        // one-operator-action convention).
        const affectedTicketIds = new Set<string>([
          ...newlyStampedTicketIds,
          ...newLineIdsByTicket.keys(),
        ]);
        for (const ticketId of affectedTicketIds) {
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.TICKET_VIEWED,
            entityType: AUDIT_ENTITY.TICKET,
            actorType: 'user',
            actorId: employeeId,
            entityId: ticketId,
            metadata: {
              stationId,
              ticketFirstViewed: newlyStampedTicketIds.has(ticketId),
              newlyViewedLineIds: newLineIdsByTicket.get(ticketId) ?? [],
              firstViewedAt: now.toISOString(),
            },
          });
        }
        return { acknowledged: affectedTicketIds.size };
      },
    );
  }

  /** `POST /kds/tickets/{ticketId}/lines/{lineId}/start` — design gate §10. */
  async startLine(
    input: TicketLineActionInput,
  ): Promise<{ ticket: TicketCardDto; line: TicketCardLineDto }> {
    const { tenantId, actorUserId, employeeId, stationId, ticketId, lineId } =
      input;
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        await this.loadTicketOwnedByStation(tx, tenantId, stationId, ticketId);
        const line = await tx.ticketLine.findFirst({
          where: { tenantId, ticketId, id: lineId },
        });
        if (!line) {
          throw new NotFoundException('Ticket line not found.');
        }
        if (line.status === 'cancelled') {
          throw new UnprocessableEntityException(
            'A cancelled line cannot be started.',
          );
        }
        if (line.status === 'queued') {
          const now = new Date();
          const updated = await tx.ticketLine.updateMany({
            where: { tenantId, id: lineId, status: 'queued' },
            data: { status: 'started', startedAt: now, startedBy: employeeId },
          });
          if (updated.count === 1) {
            await this.projection.apply(tx, tenantId, ticketId, {
              startInfo: { startedAt: now, startedBy: employeeId },
              now,
            });
            await this.audit.record(tx, {
              tenantId,
              action: AUDIT_ACTION.TICKET_LINE_STARTED,
              entityType: AUDIT_ENTITY.TICKET_LINE,
              actorType: 'user',
              actorId: employeeId,
              entityId: lineId,
              metadata: { ticketId, stationId },
            });
          }
          // `updated.count === 0` — lost a race to a concurrent start on the
          // exact same line; fall through and respond with its current
          // (already-started) state, exactly like any other replay.
        }
        return this.respondWithTicketAndLine(tx, ticketId, lineId);
      },
    );
  }

  /** `POST /kds/tickets/{ticketId}/lines/{lineId}/bump` — design gate §11. */
  async bumpLine(
    input: TicketLineActionInput,
  ): Promise<{ ticket: TicketCardDto; line: TicketCardLineDto }> {
    const { tenantId, actorUserId } = input;
    try {
      return await this.unitOfWork.execute(
        { userId: actorUserId, tenantId },
        (ctx) => this.bumpLineTx(ctx, input),
        {},
        KDS_SERIALIZABLE_RETRY,
      );
    } catch (err) {
      rethrowSerializationConflict(err);
    }
  }

  private async bumpLineTx(
    ctx: UnitOfWorkContext,
    input: TicketLineActionInput,
  ): Promise<{ ticket: TicketCardDto; line: TicketCardLineDto }> {
    const { tx } = ctx;
    const { tenantId, employeeId, stationId, ticketId, lineId } = input;
    await this.loadTicketOwnedByStation(tx, tenantId, stationId, ticketId);
    const line = await tx.ticketLine.findFirst({
      where: { tenantId, ticketId, id: lineId },
    });
    if (!line) {
      throw new NotFoundException('Ticket line not found.');
    }
    if (line.status === 'cancelled') {
      throw new UnprocessableEntityException(
        'A cancelled line cannot be bumped.',
      );
    }

    if (BUMP_ELIGIBLE_STATUSES.has(line.status)) {
      const now = new Date();
      const updated = await tx.ticketLine.updateMany({
        where: {
          tenantId,
          id: lineId,
          status: { in: [...BUMP_ELIGIBLE_STATUSES] },
        },
        data: {
          status: 'bumped',
          readyAt: now,
          bumpedAt: now,
          bumpedBy: employeeId,
        },
      });
      if (updated.count === 1) {
        const projection = await this.projection.apply(tx, tenantId, ticketId, {
          bumpActorId: employeeId,
          now,
        });
        // Acceptance correction §1.4/§20 — audit ordered LAST: the
        // readiness-critical predicate read (`publishTicketBumped`'s
        // cross-station SELECT) is computed and the event is queued BEFORE
        // `AuditService.record`, so correctness never depends on
        // `AuditService`'s own per-tenant advisory lock serializing
        // anything ahead of it.
        if (projection.transitionedToBumped) {
          await this.publishTicketBumped(
            ctx,
            tenantId,
            projection.ticket,
            employeeId,
            now,
          );
        }
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.TICKET_LINE_BUMPED,
          entityType: AUDIT_ENTITY.TICKET_LINE,
          actorType: 'user',
          actorId: employeeId,
          entityId: lineId,
          metadata: { ticketId, stationId },
        });
      }
    }

    return this.respondWithTicketAndLine(tx, ticketId, lineId);
  }

  /** `POST /kds/tickets/{ticketId}/bump-all` — design gate §11. */
  async bumpAll(
    input: TicketActionInput,
  ): Promise<{ ticket: TicketCardDto; bumpedLineIds: readonly string[] }> {
    const { tenantId, actorUserId } = input;
    try {
      return await this.unitOfWork.execute(
        { userId: actorUserId, tenantId },
        (ctx) => this.bumpAllTx(ctx, input),
        {},
        KDS_SERIALIZABLE_RETRY,
      );
    } catch (err) {
      rethrowSerializationConflict(err);
    }
  }

  private async bumpAllTx(
    ctx: UnitOfWorkContext,
    input: TicketActionInput,
  ): Promise<{ ticket: TicketCardDto; bumpedLineIds: readonly string[] }> {
    const { tx } = ctx;
    const { tenantId, employeeId, stationId, ticketId } = input;
    await this.loadTicketOwnedByStation(tx, tenantId, stationId, ticketId);

    const now = new Date();
    const bumped = await tx.ticketLine.updateManyAndReturn({
      where: {
        tenantId,
        ticketId,
        status: { in: [...BUMP_ELIGIBLE_STATUSES] },
      },
      data: {
        status: 'bumped',
        readyAt: now,
        bumpedAt: now,
        bumpedBy: employeeId,
      },
      select: { id: true },
    });
    const bumpedLineIds = bumped.map((l) => l.id);

    if (bumpedLineIds.length > 0) {
      const projection = await this.projection.apply(tx, tenantId, ticketId, {
        bumpActorId: employeeId,
        now,
      });
      // Acceptance correction §1.4/§20 — audit ordered LAST: see the
      // identical note in `bumpLineTx`.
      if (projection.transitionedToBumped) {
        await this.publishTicketBumped(
          ctx,
          tenantId,
          projection.ticket,
          employeeId,
          now,
        );
      }
      // ONE entry for the whole operator action (design gate §23) — never
      // one per affected line.
      await this.audit.record(tx, {
        tenantId,
        action: AUDIT_ACTION.TICKET_BUMPED,
        entityType: AUDIT_ENTITY.TICKET,
        actorType: 'user',
        actorId: employeeId,
        entityId: ticketId,
        metadata: { stationId, bumpedLineIds },
      });
    }

    const ticket = await this.reader.getCard(tx, ticketId);
    return { ticket: ticket as TicketCardDto, bumpedLineIds };
  }

  /** `POST /kds/tickets/{ticketId}/recall` — design gate §14, KDS-R12. */
  async recall(input: TicketActionInput): Promise<{ ticket: TicketCardDto }> {
    const { tenantId, actorUserId } = input;
    try {
      return await this.unitOfWork.execute(
        { userId: actorUserId, tenantId },
        (ctx) => this.recallTx(ctx, input),
        {},
        KDS_SERIALIZABLE_RETRY,
      );
    } catch (err) {
      rethrowSerializationConflict(err);
    }
  }

  private async recallTx(
    ctx: UnitOfWorkContext,
    input: TicketActionInput,
  ): Promise<{ ticket: TicketCardDto }> {
    const { tx } = ctx;
    const { tenantId, employeeId, stationId, ticketId } = input;
    const ticket = await this.loadTicketOwnedByStation(
      tx,
      tenantId,
      stationId,
      ticketId,
    );

    if (ticket.status !== 'bumped') {
      throw new UnprocessableEntityException(
        'Only a bumped ticket can be recalled.',
      );
    }

    const branchConfig = await this.kdsBranchConfig.find(tx, {
      tenantId,
      branchId: ticket.branchId,
    });
    const now = new Date();
    const bumpedAt = ticket.bumpedAt;
    const elapsedSeconds = bumpedAt
      ? (now.getTime() - bumpedAt.getTime()) / 1000
      : Number.POSITIVE_INFINITY;
    if (elapsedSeconds > branchConfig.recallWindowSeconds) {
      throw new UnprocessableEntityException(
        `The recall window (${branchConfig.recallWindowSeconds}s) for this ticket has expired.`,
      );
    }

    const lines = await tx.ticketLine.findMany({
      where: { tenantId, ticketId },
      select: { id: true, orderLineId: true, status: true, startedAt: true },
    });
    const revertedOrderLineIds: string[] = [];
    // The actual post-recall status of every line — used both to write the
    // rows below and to recompute the Ticket projection from the SAME
    // resulting facts, never re-derived ambiguously afterwards.
    const resultingLineFacts: {
      status: TicketLineStatus;
      startedAt: Date | null;
    }[] = [];
    for (const line of lines) {
      if (line.status !== 'bumped') {
        // cancelled / served (never regressed) / anything not bumped is
        // untouched by recall (design gate §14).
        resultingLineFacts.push({
          status: line.status,
          startedAt: line.startedAt,
        });
        continue;
      }
      const restoredStatus = line.startedAt ? 'started' : 'queued';
      await tx.ticketLine.update({
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

    const cas = await tx.ticket.updateMany({
      where: { id: ticketId, tenantId, version: ticket.version },
      data: {
        status: newTicketStatus,
        recalledAt: now,
        recallCount: { increment: 1 },
        version: { increment: 1 },
      },
    });
    if (cas.count === 0) {
      throw new ConflictException(
        'Ticket was concurrently modified; reload and retry the recall.',
      );
    }

    // Acceptance correction §1.4/§20 — audit ordered LAST: the event
    // (built from `revertedOrderLineIds`, already computed above from the
    // line-update loop) is queued before `AuditService.record`, the same
    // discipline as `bumpLineTx`/`bumpAllTx`, applied here even though
    // recall's payload needs no further cross-transaction predicate read.
    if (revertedOrderLineIds.length > 0) {
      ctx.publishEvent({
        eventType: TICKET_RECALLED_EVENT_TYPE,
        eventVersion: TICKET_RECALLED_EVENT_VERSION,
        occurredAt: now,
        branchId: ticket.branchId,
        actorId: employeeId,
        actorType: 'user',
        idempotencyKey: newId(),
        payload: {
          ticketId,
          orderId: ticket.orderId,
          businessDay: ticket.businessDay.toISOString().slice(0, 10),
          stationId,
          recalledAt: now.toISOString(),
          revertedOrderLineIds: [...new Set(revertedOrderLineIds)],
        },
      });
    }

    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.TICKET_RECALLED,
      entityType: AUDIT_ENTITY.TICKET,
      actorType: 'user',
      actorId: employeeId,
      entityId: ticketId,
      metadata: { stationId, revertedOrderLineIds },
    });

    const freshTicket = await this.reader.getCard(tx, ticketId);
    return { ticket: freshTicket as TicketCardDto };
  }

  // ---------------------------------------------------------------------

  private async loadTicketOwnedByStation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    stationId: string,
    ticketId: string,
  ): Promise<TicketProjectionRow> {
    const ticket = await tx.ticket.findFirst({
      where: { tenantId, id: ticketId },
      select: TICKET_PROJECTION_SELECT,
    });
    if (!ticket) {
      throw new NotFoundException('Ticket not found.');
    }
    if (ticket.stationId !== stationId) {
      throw new ForbiddenException(
        'This ticket does not belong to your station.',
      );
    }
    return ticket;
  }

  private async respondWithTicketAndLine(
    tx: Prisma.TransactionClient,
    ticketId: string,
    lineId: string,
  ): Promise<{ ticket: TicketCardDto; line: TicketCardLineDto }> {
    const ticket = await this.reader.getCard(tx, ticketId);
    if (!ticket) {
      throw new NotFoundException('Ticket not found.');
    }
    const line = ticket.lines.find((l) => l.id === lineId);
    if (!line) {
      throw new NotFoundException('Ticket line not found.');
    }
    return { ticket, line };
  }

  /**
   * Design gate §13/§18, corrected §1.6 — computed and published ONLY when
   * the Ticket aggregate transitions to `bumped`. Reads ONLY
   * `kitchen.ticket_lines` (§13: "Kitchen answers a Kitchen question using
   * only Kitchen-owned ticket_lines") — the readiness SELECT this function
   * issues is the one SSI-protected predicate read the acceptance
   * correction's SERIALIZABLE mechanism exists to make trustworthy.
   */
  private async publishTicketBumped(
    ctx: UnitOfWorkContext,
    tenantId: string,
    ticket: TicketProjectionRow,
    actorId: string,
    now: Date,
  ): Promise<void> {
    const lines = await ctx.tx.ticketLine.findMany({
      where: { tenantId, ticketId: ticket.id },
      select: { orderLineId: true },
    });
    const orderLineIds = [...new Set(lines.map((l) => l.orderLineId))];

    let readyOrderLineIds: string[] = [];
    if (orderLineIds.length > 0) {
      const readyRows = await ctx.tx.$queryRaw<{ orderLineId: string }[]>`
        SELECT "order_line_id" AS "orderLineId"
        FROM "kitchen"."ticket_lines"
        WHERE "tenant_id" = ${tenantId}::uuid
          AND "business_day" = ${ticket.businessDay}::date
          AND "order_line_id" = ANY(${orderLineIds}::uuid[])
        GROUP BY "order_line_id"
        HAVING bool_and("status" IN ('bumped', 'served', 'cancelled'))
           AND bool_or("status" IN ('bumped', 'served'))
      `;
      readyOrderLineIds = readyRows.map((r) => r.orderLineId);
    }

    ctx.publishEvent({
      eventType: TICKET_BUMPED_EVENT_TYPE,
      eventVersion: TICKET_BUMPED_EVENT_VERSION,
      occurredAt: now,
      branchId: ticket.branchId,
      actorId,
      actorType: 'user',
      idempotencyKey: newId(),
      payload: {
        ticketId: ticket.id,
        orderId: ticket.orderId,
        businessDay: ticket.businessDay.toISOString().slice(0, 10),
        stationId: ticket.stationId,
        bumpedAt: now.toISOString(),
        orderLineIds,
        readyOrderLineIds,
      },
    });
  }
}

/** §19 — exhausted serialization retries surface as 409, never 422. */
function rethrowSerializationConflict(err: unknown): never {
  if (err instanceof SerializationRetryExhaustedError) {
    throw new ConflictException(err.message);
  }
  throw err;
}
