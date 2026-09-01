import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  TicketCardDto,
  TicketCardLineDto,
  TicketCardModifierDto,
} from './ticket-reader.types';

/**
 * Proves the P1E-4 §F self-containment claim in code, not just in the
 * design: an explicit `select` naming only `kitchen.*` columns and
 * `kitchen.*` child relations (`lines`, `lines.modifiers`) — never `order`,
 * `station`, `orderLine`, `sourceModifier`, or `sourceOrderLineModifier`,
 * every one of which is a real relation on these models but would cross into
 * `sales.*`/`catalogue.*` if selected. This is a structural guarantee, not a
 * convention: there is nothing here for a future edit to "accidentally"
 * widen into a Sales/Catalogue read without visibly adding a new relation to
 * this `select`.
 *
 * Widened for the KDS operator lifecycle (design gate §11/§17): every
 * FR-KDS-040 lifecycle timestamp, `orderId`/`businessDay` (needed by the
 * `ticket.bumped`/`ticket.recalled` payloads), and `version` (the §11
 * projection CAS token).
 */
const TICKET_CARD_SELECT = {
  id: true,
  stationId: true,
  orderId: true,
  businessDay: true,
  orderNumberSnapshot: true,
  orderTypeSnapshot: true,
  serviceReferenceSnapshot: true,
  routedAt: true,
  targetReadyAt: true,
  status: true,
  firstViewedAt: true,
  startedAt: true,
  readyAt: true,
  bumpedAt: true,
  recalledAt: true,
  recallCount: true,
  version: true,
  lines: {
    select: {
      id: true,
      orderLineId: true,
      itemNameSnapshot: true,
      quantity: true,
      course: true,
      sequence: true,
      preparationNotes: true,
      status: true,
      firstViewedAt: true,
      startedAt: true,
      readyAt: true,
      bumpedAt: true,
      recalledAt: true,
      cancelledAt: true,
      modifiers: {
        select: {
          id: true,
          nameSnapshot: true,
          kind: true,
          quantity: true,
        },
        orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      },
    },
    orderBy: [{ sequence: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.TicketSelect;

type TicketCardRow = Prisma.TicketGetPayload<{
  select: typeof TICKET_CARD_SELECT;
}>;

/** FR-KDS-023 — FIFO only in this slice (design gate §17). */
export type StationQueueSort = 'fifo';

export interface ListStationQueueInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly stationId: string;
  readonly sort: StationQueueSort;
}

/** Tickets that have left the active operator queue (design gate §21 GET route). */
const INACTIVE_STATUSES = ['bumped', 'served'] as const;

@Injectable()
export class TicketReaderService {
  async getCard(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<TicketCardDto | null> {
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: TICKET_CARD_SELECT,
    });
    return ticket === null ? null : toCardDto(ticket, new Date());
  }

  /**
   * `GET /kds/stations/{stationId}/queue` — read-only (design gate §10: "GET
   * MUST NOT mutate `first_viewed_at`").
   *
   * Acceptance correction (2026-08-31), §12 — CORRECTED, and the design
   * commentary's index claim was itself imprecise; both are recorded here so
   * a future reader does not have to re-derive them from `EXPLAIN` again.
   *
   * 1. An earlier version of this query omitted `branchId` from the `WHERE`
   *    clause, reasoning that "`branchId` is implied by `stationId`" (true
   *    at the DATA level — D-09's composite FK makes a station's branch
   *    unambiguous — but not sufficient at the QUERY-PLANNING level: a
   *    composite b-tree index's later columns cannot tighten the scanned
   *    range unless every column before them is ALSO bound). Supplying it
   *    is free — the caller already resolves the terminal-bound station's
   *    branch (`KdsStationGuard`/`StationDisplayBindingQuery`) — so this is
   *    corrected to filter on it.
   * 2. `EXPLAIN (ANALYZE, BUFFERS)` against real data (KDS acceptance-
   *    correction report §12 has the captured plans) shows PostgreSQL
   *    actually satisfies this query from
   *    `@@index([tenantId, branchId, stationId, targetReadyAt])` — NOT the
   *    `@@index([tenantId, branchId, stationId, status, routedAt])` index a
   *    prior version of this comment named — because both indexes share the
   *    identical 3-column leading prefix `(tenantId, branchId, stationId)`,
   *    which is the only part either index can contribute here: `status NOT
   *    IN (...)` is never sargable as an Index Cond in a b-tree (only a
   *    Filter, regardless of which index is chosen), and neither index's
   *    remaining column matches the `ORDER BY (routedAt, id)` once `status`
   *    is a negated condition, so an explicit `Sort` node is unavoidable
   *    either way. Supplying `branchId` still measurably tightens the Index
   *    Cond and roughly halved buffer reads/execution time in the captured
   *    plans, so the fix is correct and worth keeping even though it is not
   *    the specific index the original design commentary named. Fixing
   *    which named index this "should" use would require a NEW index
   *    (e.g. one covering `status` as a non-leading, non-range column via a
   *    partial index) — out of scope (no migration authorized this slice).
   */
  async listStationQueue(
    tx: Prisma.TransactionClient,
    input: ListStationQueueInput,
  ): Promise<readonly TicketCardDto[]> {
    const tickets = await tx.ticket.findMany({
      where: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        stationId: input.stationId,
        status: { notIn: [...INACTIVE_STATUSES] },
      },
      select: TICKET_CARD_SELECT,
      orderBy: [{ routedAt: 'asc' }, { id: 'asc' }],
    });
    const now = new Date();
    return tickets.map((t) => toCardDto(t, now));
  }
}

function toCardDto(ticket: TicketCardRow, now: Date): TicketCardDto {
  return {
    id: ticket.id,
    stationId: ticket.stationId,
    orderId: ticket.orderId,
    businessDay: ticket.businessDay.toISOString().slice(0, 10),
    orderNumber: ticket.orderNumberSnapshot,
    orderType: ticket.orderTypeSnapshot,
    serviceReference: ticket.serviceReferenceSnapshot,
    routedAt: ticket.routedAt.toISOString(),
    elapsedSeconds: Math.max(
      0,
      Math.floor((now.getTime() - ticket.routedAt.getTime()) / 1000),
    ),
    targetReadyAt: ticket.targetReadyAt?.toISOString() ?? null,
    status: ticket.status,
    firstViewedAt: ticket.firstViewedAt?.toISOString() ?? null,
    startedAt: ticket.startedAt?.toISOString() ?? null,
    readyAt: ticket.readyAt?.toISOString() ?? null,
    bumpedAt: ticket.bumpedAt?.toISOString() ?? null,
    recalledAt: ticket.recalledAt?.toISOString() ?? null,
    recallCount: ticket.recallCount,
    lines: ticket.lines.map(toLineDto),
  };
}

function toLineDto(line: TicketCardRow['lines'][number]): TicketCardLineDto {
  return {
    id: line.id,
    orderLineId: line.orderLineId,
    itemNameSnapshot: line.itemNameSnapshot,
    quantity: line.quantity.toString(),
    course: line.course,
    sequence: line.sequence,
    preparationNotes: line.preparationNotes,
    status: line.status,
    firstViewedAt: line.firstViewedAt?.toISOString() ?? null,
    startedAt: line.startedAt?.toISOString() ?? null,
    readyAt: line.readyAt?.toISOString() ?? null,
    bumpedAt: line.bumpedAt?.toISOString() ?? null,
    recalledAt: line.recalledAt?.toISOString() ?? null,
    cancelledAt: line.cancelledAt?.toISOString() ?? null,
    modifiers: line.modifiers.map(toModifierDto),
  };
}

function toModifierDto(
  modifier: TicketCardRow['lines'][number]['modifiers'][number],
): TicketCardModifierDto {
  return {
    id: modifier.id,
    nameSnapshot: modifier.nameSnapshot,
    kind: modifier.kind,
    quantity: modifier.quantity,
  };
}
