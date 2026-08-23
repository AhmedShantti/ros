import { Prisma } from '../../generated/prisma/client';
import { createDomainEvent } from './internal/create-domain-event';
import { DomainEventCollector } from './domain-event-collector';
import {
  DomainEventDispatchLimitExceededError,
  MAX_DRAIN_ITERATIONS,
  TransactionalDomainEventDispatcher,
  TransactionalDomainEventHandler,
} from './domain-event-dispatcher';
import { UnitOfWorkContext } from './unit-of-work-context';
import { InternalUnitOfWorkContext } from './internal/unit-of-work-internal-context';

/** A marker object standing in for a real `Prisma.TransactionClient` in unit tests. */
const FAKE_TX = { __fakeTx: true } as unknown as Prisma.TransactionClient;

const event = (type: string, n: number) =>
  createDomainEvent({
    eventType: type,
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

/** The `ctx.publishEvent(...)` input shape — for a HANDLER publishing a child event. */
const publishInput = (type: string, n: number) => ({
  eventType: type,
  eventVersion: 1,
  occurredAt: new Date(),
  branchId: 'b1',
  actorId: 'a1',
  actorType: 'system' as const,
  idempotencyKey: `k${n}`,
  payload: { n },
});

function makeCtx(): InternalUnitOfWorkContext {
  const events = new DomainEventCollector();
  return {
    tx: FAKE_TX,
    events,
    publishEvent: (input) => {
      const built = createDomainEvent({
        ...input,
        tenantId: 't1',
        correlationId: 'c1',
        causationId: input.causationId ?? 'cause-1',
      });
      events.record(built);
      return built;
    },
  };
}

describe('TransactionalDomainEventDispatcher', () => {
  it('dispatches to the handler registered for the matching event type only', async () => {
    const seen: string[] = [];
    const a: TransactionalDomainEventHandler = {
      eventType: 'a.happened',
      handle: (e) => {
        seen.push(`a:${e.eventType}`);
        return Promise.resolve();
      },
    };
    const b: TransactionalDomainEventHandler = {
      eventType: 'b.happened',
      handle: (e) => {
        seen.push(`b:${e.eventType}`);
        return Promise.resolve();
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([a, b]);
    const ctx = makeCtx();
    ctx.events.record(event('a.happened', 1));
    await dispatcher.drain(ctx);
    expect(seen).toEqual(['a:a.happened']);
  });

  it('passes the SAME tx/ctx the Unit of Work holds to the handler', async () => {
    let receivedCtx: UnitOfWorkContext | undefined;
    const handler: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: (_e, ctx) => {
        receivedCtx = ctx;
        return Promise.resolve();
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([
      handler,
    ]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 1));
    await dispatcher.drain(ctx);
    expect(receivedCtx).toBe(ctx);
    expect(receivedCtx?.tx).toBe(FAKE_TX);
  });

  it('awaits an async handler before drain() resolves', async () => {
    let resolved = false;
    const handler: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([
      handler,
    ]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 1));
    await dispatcher.drain(ctx);
    expect(resolved).toBe(true);
  });

  it('multiple handlers for one event run in deterministic registration order', async () => {
    const order: string[] = [];
    const first: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: () => {
        order.push('first');
        return Promise.resolve();
      },
    };
    const second: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: () => {
        order.push('second');
        return Promise.resolve();
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([
      first,
      second,
    ]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 1));
    await dispatcher.drain(ctx);
    expect(order).toEqual(['first', 'second']);
  });

  it('a handler error propagates out of drain() and is not swallowed', async () => {
    const handler: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: () => {
        throw new Error('handler blew up');
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([
      handler,
    ]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 1));
    await expect(dispatcher.drain(ctx)).rejects.toThrow('handler blew up');
  });

  it('a later handler for the same batch does not run once an earlier one throws', async () => {
    let laterRan = false;
    const failing: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: () => {
        throw new Error('boom');
      },
    };
    const later: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: () => {
        laterRan = true;
        return Promise.resolve();
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([
      failing,
      later,
    ]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 1));
    await expect(dispatcher.drain(ctx)).rejects.toThrow('boom');
    expect(laterRan).toBe(false);
  });

  it('a handler may enqueue a further event, which is drained in a later round', async () => {
    const seen: string[] = [];
    const handler: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: (e, ctx) => {
        seen.push(e.eventType);
        if (e.payload && (e.payload as { n: number }).n === 1) {
          ctx.publishEvent(publishInput('x', 2));
        }
        return Promise.resolve();
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([
      handler,
    ]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 1));
    await dispatcher.drain(ctx);
    expect(seen).toEqual(['x', 'x']);
  });

  it('rejects with DomainEventDispatchLimitExceededError on an unbounded self-emitting handler', async () => {
    const selfEmitting: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: (_e, ctx) => {
        ctx.publishEvent(publishInput('x', 0));
        return Promise.resolve();
      },
    };
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([
      selfEmitting,
    ]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 0));
    await expect(dispatcher.drain(ctx)).rejects.toThrow(
      DomainEventDispatchLimitExceededError,
    );
  });

  it('an event with no registered handler is drained silently (no unhandled-event error in this slice)', async () => {
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([]);
    const ctx = makeCtx();
    ctx.events.record(event('nobody.listens', 1));
    await expect(dispatcher.drain(ctx)).resolves.toBeUndefined();
  });

  it('an explicitly empty handler set drains without error', async () => {
    const dispatcher = TransactionalDomainEventDispatcher.withHandlers([]);
    const ctx = makeCtx();
    ctx.events.record(event('x', 1));
    await expect(dispatcher.drain(ctx)).resolves.toBeUndefined();
  });

  it('MAX_DRAIN_ITERATIONS is a positive, documented constant', () => {
    expect(MAX_DRAIN_ITERATIONS).toBeGreaterThan(0);
  });
});
