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
 * No HTTP endpoint, no KDS UI — a plain injectable returning a plain DTO
 * (P1E-5 §21).
 */
const TICKET_CARD_SELECT = {
  id: true,
  stationId: true,
  orderNumberSnapshot: true,
  orderTypeSnapshot: true,
  serviceReferenceSnapshot: true,
  routedAt: true,
  status: true,
  lines: {
    select: {
      id: true,
      itemNameSnapshot: true,
      quantity: true,
      course: true,
      sequence: true,
      preparationNotes: true,
      status: true,
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
    return ticket === null ? null : toCardDto(ticket);
  }
}

function toCardDto(ticket: TicketCardRow): TicketCardDto {
  return {
    id: ticket.id,
    stationId: ticket.stationId,
    orderNumber: ticket.orderNumberSnapshot,
    orderType: ticket.orderTypeSnapshot,
    serviceReference: ticket.serviceReferenceSnapshot,
    routedAt: ticket.routedAt.toISOString(),
    status: ticket.status,
    lines: ticket.lines.map(toLineDto),
  };
}

function toLineDto(line: TicketCardRow['lines'][number]): TicketCardLineDto {
  return {
    id: line.id,
    itemNameSnapshot: line.itemNameSnapshot,
    quantity: line.quantity.toString(),
    course: line.course,
    sequence: line.sequence,
    preparationNotes: line.preparationNotes,
    status: line.status,
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
