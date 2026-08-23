import { createDomainEvent } from './internal/create-domain-event';
import { DomainEventCollector } from './domain-event-collector';

const event = (n: number) =>
  createDomainEvent({
    eventType: 'test.event' as const,
    eventVersion: 1,
    occurredAt: new Date(),
    tenantId: 't1',
    branchId: 'b1',
    actorId: 'a1',
    actorType: 'system' as const,
    correlationId: 'c1',
    causationId: 'cause-1',
    idempotencyKey: `k${n}`,
    payload: { n },
  });

describe('DomainEventCollector', () => {
  it('records typed events', () => {
    const collector = new DomainEventCollector();
    collector.record(event(1));
    expect(collector.size).toBe(1);
  });

  it('preserves insertion order on drain', () => {
    const collector = new DomainEventCollector();
    collector.record(event(1));
    collector.record(event(2));
    collector.record(event(3));
    const drained = collector.drain();
    // `drain()` intentionally erases the specific payload type — a collector
    // holds heterogeneous events — so order is asserted via `idempotencyKey`,
    // which each fixture event sets to `k${n}`.
    expect(drained.map((e) => e.idempotencyKey)).toEqual(['k1', 'k2', 'k3']);
  });

  it('drain empties the queue — a second drain returns nothing', () => {
    const collector = new DomainEventCollector();
    collector.record(event(1));
    collector.drain();
    expect(collector.drain()).toEqual([]);
    expect(collector.size).toBe(0);
  });

  it('two collector instances have independent queues', () => {
    const a = new DomainEventCollector();
    const b = new DomainEventCollector();
    a.record(event(1));
    expect(a.size).toBe(1);
    expect(b.size).toBe(0);
    // Draining one cannot drain the other.
    a.drain();
    expect(a.size).toBe(0);
    b.record(event(2));
    expect(b.size).toBe(1);
  });
});
