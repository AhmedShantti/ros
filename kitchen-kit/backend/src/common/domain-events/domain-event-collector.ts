import { DomainEventEnvelope } from './domain-event.types';

/**
 * Per-Unit-of-Work event queue (SRS §5.5.2 — "Events are collected on the
 * aggregate, and dispatched by the unit of work").
 *
 * Deliberately a plain class with no static/module-level state: `UnitOfWork`
 * (see `unit-of-work.ts`) instantiates one of these per `execute()` call, so
 * two concurrent requests — even for the same tenant — never share a queue.
 * There is nothing to isolate here; there is simply nothing shared.
 */
export class DomainEventCollector {
  private readonly queue: DomainEventEnvelope[] = [];

  /** Record an event. Does not dispatch — see `TransactionalDomainEventDispatcher`. */
  record<TType extends string, TPayload>(
    event: DomainEventEnvelope<TType, TPayload>,
  ): void {
    this.queue.push(event);
  }

  /**
   * Remove and return every event queued so far, in insertion order. The
   * dispatcher calls this repeatedly to drain events a handler itself records
   * (§7E nested emission) — each call only sees what was queued since the
   * previous drain.
   */
  drain(): DomainEventEnvelope[] {
    return this.queue.splice(0, this.queue.length);
  }

  get size(): number {
    return this.queue.length;
  }
}
