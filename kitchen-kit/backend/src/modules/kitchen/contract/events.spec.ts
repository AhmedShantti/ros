import { createDomainEvent } from '../../../common/domain-events/internal/create-domain-event';
import {
  TICKET_BUMPED_EVENT_TYPE,
  TICKET_BUMPED_EVENT_VERSION,
  TICKET_RECALLED_EVENT_TYPE,
  TICKET_RECALLED_EVENT_VERSION,
  TicketBumpedEvent,
  TicketRecalledEvent,
} from './events';

const BUMPED_PAYLOAD = {
  ticketId: 'ticket-1',
  orderId: 'order-1',
  businessDay: '2026-08-21',
  stationId: 'station-1',
  bumpedAt: '2026-08-21T10:05:00.000Z',
  orderLineIds: ['line-1', 'line-2'],
  readyOrderLineIds: ['line-1'],
};

const RECALLED_PAYLOAD = {
  ticketId: 'ticket-1',
  orderId: 'order-1',
  businessDay: '2026-08-21',
  stationId: 'station-1',
  recalledAt: '2026-08-21T10:10:00.000Z',
  revertedOrderLineIds: ['line-1'],
};

describe('Kitchen contract — ticket.bumped', () => {
  it('preserves the exact SRS §5.5.4 event name', () => {
    expect(TICKET_BUMPED_EVENT_TYPE).toBe('ticket.bumped');
  });

  it('has a valid positive integer version', () => {
    expect(Number.isInteger(TICKET_BUMPED_EVENT_VERSION)).toBe(true);
    expect(TICKET_BUMPED_EVENT_VERSION).toBeGreaterThan(0);
  });

  it('builds a well-formed envelope carrying the v1 payload fields', () => {
    const event: TicketBumpedEvent = createDomainEvent({
      eventType: TICKET_BUMPED_EVENT_TYPE,
      eventVersion: TICKET_BUMPED_EVENT_VERSION,
      occurredAt: new Date('2026-08-21T10:05:00.000Z'),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'idem-1',
      payload: BUMPED_PAYLOAD,
    });
    expect(event.eventType).toBe('ticket.bumped');
    expect(event.payload.ticketId).toBe('ticket-1');
    expect(event.payload.businessDay).toBe('2026-08-21');
    expect(event.payload.stationId).toBe('station-1');
    expect(event.payload.orderLineIds).toEqual(['line-1', 'line-2']);
    expect(event.payload.readyOrderLineIds).toEqual(['line-1']);
  });

  it('causationId is a required, non-null field (P1E-1B)', () => {
    const event = createDomainEvent({
      eventType: TICKET_BUMPED_EVENT_TYPE,
      eventVersion: TICKET_BUMPED_EVENT_VERSION,
      occurredAt: new Date(),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'idem-1',
      payload: BUMPED_PAYLOAD,
    });
    expect(event.causationId).toBe('cause-1');
    expect(typeof event.causationId).toBe('string');
  });

  it('envelope timestamps are ISO-8601 strings (SRS §5.1 driver 7)', () => {
    const event = createDomainEvent({
      eventType: TICKET_BUMPED_EVENT_TYPE,
      eventVersion: TICKET_BUMPED_EVENT_VERSION,
      occurredAt: new Date('2026-08-21T10:05:00.000Z'),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'idem-1',
      payload: BUMPED_PAYLOAD,
    });
    expect(typeof event.occurredAt).toBe('string');
    expect(typeof event.recordedAt).toBe('string');
  });

  it('businessDay is a date-only YYYY-MM-DD string', () => {
    const event = createDomainEvent({
      eventType: TICKET_BUMPED_EVENT_TYPE,
      eventVersion: TICKET_BUMPED_EVENT_VERSION,
      occurredAt: new Date(),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'idem-1',
      payload: BUMPED_PAYLOAD,
    });
    expect(event.payload.businessDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('freezes the payload', () => {
    const event = createDomainEvent({
      eventType: TICKET_BUMPED_EVENT_TYPE,
      eventVersion: TICKET_BUMPED_EVENT_VERSION,
      occurredAt: new Date(),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'idem-1',
      payload: BUMPED_PAYLOAD,
    });
    expect(Object.isFrozen(event.payload)).toBe(true);
  });
});

describe('Kitchen contract — ticket.recalled (KDS-R12)', () => {
  it('is named exactly per the governance register ratification', () => {
    expect(TICKET_RECALLED_EVENT_TYPE).toBe('ticket.recalled');
  });

  it('has a valid positive integer version', () => {
    expect(Number.isInteger(TICKET_RECALLED_EVENT_VERSION)).toBe(true);
    expect(TICKET_RECALLED_EVENT_VERSION).toBeGreaterThan(0);
  });

  it('builds a well-formed envelope carrying the v1 payload fields', () => {
    const event: TicketRecalledEvent = createDomainEvent({
      eventType: TICKET_RECALLED_EVENT_TYPE,
      eventVersion: TICKET_RECALLED_EVENT_VERSION,
      occurredAt: new Date('2026-08-21T10:10:00.000Z'),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'idem-1',
      payload: RECALLED_PAYLOAD,
    });
    expect(event.eventType).toBe('ticket.recalled');
    expect(event.payload.ticketId).toBe('ticket-1');
    expect(event.payload.revertedOrderLineIds).toEqual(['line-1']);
  });

  it('freezes the payload', () => {
    const event = createDomainEvent({
      eventType: TICKET_RECALLED_EVENT_TYPE,
      eventVersion: TICKET_RECALLED_EVENT_VERSION,
      occurredAt: new Date(),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'idem-1',
      payload: RECALLED_PAYLOAD,
    });
    expect(Object.isFrozen(event.payload)).toBe(true);
  });
});
