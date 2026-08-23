import { createDomainEvent } from '../../../common/domain-events/internal/create-domain-event';
import {
  ORDER_LINE_FIRED_EVENT_TYPE,
  ORDER_LINE_FIRED_EVENT_VERSION,
  OrderLineFiredEvent,
  OrderLineFiredPayload,
} from './events';

function validPayload(
  overrides: Partial<OrderLineFiredPayload> = {},
): OrderLineFiredPayload {
  return {
    orderId: 'order-1',
    businessDay: '2026-08-21',
    orderLineId: 'line-1',
    fireBatchId: 'batch-1',
    firedAt: '2026-08-21T10:00:00.000Z',
    menuItemId: 'item-1',
    modifierIds: [],
    categoryIds: [],
    lineStationOverrides: [],
    orderNumber: 'A-0001',
    orderType: 'dine_in',
    serviceReference: 'Table 4',
    itemNameSnapshot: { en: 'Burger' },
    quantity: '1',
    course: null,
    sequence: 1,
    preparationNotes: null,
    modifiers: [],
    ...overrides,
  };
}

function build(payload: OrderLineFiredPayload): OrderLineFiredEvent {
  return createDomainEvent({
    eventType: ORDER_LINE_FIRED_EVENT_TYPE,
    eventVersion: ORDER_LINE_FIRED_EVENT_VERSION,
    occurredAt: new Date('2026-08-21T10:00:00.000Z'),
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    actorId: 'actor-1',
    actorType: 'user',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    idempotencyKey: 'idem-1',
    payload,
  });
}

describe('Sales contract — order.line.fired', () => {
  it('preserves the exact SRS §5.5.4 event name', () => {
    expect(ORDER_LINE_FIRED_EVENT_TYPE).toBe('order.line.fired');
  });

  it('has a valid positive integer version', () => {
    expect(Number.isInteger(ORDER_LINE_FIRED_EVENT_VERSION)).toBe(true);
    expect(ORDER_LINE_FIRED_EVENT_VERSION).toBeGreaterThan(0);
  });

  it('builds a well-formed envelope carrying the full v1 payload', () => {
    const event = build(validPayload());
    expect(event.eventType).toBe('order.line.fired');
    expect(event.payload.orderId).toBe('order-1');
    expect(event.payload.orderLineId).toBe('line-1');
    expect(event.payload.businessDay).toBe('2026-08-21');
    expect(event.payload.fireBatchId).toBe('batch-1');
    expect(event.payload.firedAt).toBe('2026-08-21T10:00:00.000Z');
  });

  it('carries routing selectors, not resolved station ids', () => {
    const event = build(
      validPayload({
        modifierIds: ['mod-1', 'mod-2'],
        categoryIds: ['cat-1'],
        lineStationOverrides: [{ overrideId: 'ov-1', stationId: 'st-1' }],
      }),
    );
    expect(event.payload.modifierIds).toEqual(['mod-1', 'mod-2']);
    expect(event.payload.categoryIds).toEqual(['cat-1']);
    expect(event.payload.lineStationOverrides).toEqual([
      { overrideId: 'ov-1', stationId: 'st-1' },
    ]);
  });

  it('carries the ticket header snapshot on every line event', () => {
    const event = build(
      validPayload({
        orderNumber: 'A-0042',
        orderType: 'delivery',
        serviceReference: null,
      }),
    );
    expect(event.payload.orderNumber).toBe('A-0042');
    expect(event.payload.orderType).toBe('delivery');
    expect(event.payload.serviceReference).toBeNull();
  });

  it('carries modifier snapshots keyed by orderLineModifierId, not modifierId alone', () => {
    const event = build(
      validPayload({
        modifiers: [
          {
            orderLineModifierId: 'olm-1',
            modifierId: 'mod-1',
            nameSnapshot: { en: 'No onion' },
            kind: 'removal',
            quantity: 1,
          },
        ],
      }),
    );
    expect(event.payload.modifiers).toHaveLength(1);
    expect(event.payload.modifiers[0].orderLineModifierId).toBe('olm-1');
    expect(event.payload.modifiers[0].kind).toBe('removal');
  });

  it('quantity is a decimal string, never a JS number', () => {
    const event = build(validPayload({ quantity: '2.500' }));
    expect(typeof event.payload.quantity).toBe('string');
    expect(event.payload.quantity).toBe('2.500');
  });

  it('causationId is a required, non-null field — a root event has a real cause, not an absent one (P1E-1B)', () => {
    const event = build(validPayload());
    expect(event.causationId).toBe('cause-1');
    expect(typeof event.causationId).toBe('string');
  });

  it('envelope timestamps are network-ready ISO-8601 strings, not Date instances (SRS §5.1 driver 7)', () => {
    const event = build(validPayload());
    expect(typeof event.occurredAt).toBe('string');
    expect(typeof event.recordedAt).toBe('string');
    expect(event.occurredAt).toBe('2026-08-21T10:00:00.000Z');
    expect(() => JSON.stringify(event)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(event)) as {
      occurredAt: string;
    };
    expect(roundTripped.occurredAt).toBe(event.occurredAt);
  });

  it('businessDay is a date-only YYYY-MM-DD string, not an instant', () => {
    const event = build(validPayload());
    expect(event.payload.businessDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('firedAt is an ISO-8601 string, not a Date instance', () => {
    const event = build(validPayload());
    expect(typeof event.payload.firedAt).toBe('string');
    expect(event.payload.firedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('freezes the payload — a handler cannot mutate what it received', () => {
    const event = build(validPayload());
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(() => {
      // @ts-expect-error — payload is readonly; this proves it at runtime too.
      event.payload.orderId = 'tampered';
    }).toThrow();
  });
});
