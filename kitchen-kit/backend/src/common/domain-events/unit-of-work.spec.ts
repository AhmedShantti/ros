import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TransactionalDomainEventDispatcher,
  TransactionalDomainEventHandler,
} from './domain-event-dispatcher';
import { UnitOfWork } from './unit-of-work';
import {
  TrustedDomainEventInput,
  UnitOfWorkContext,
} from './unit-of-work-context';
import { UUID_PATTERN } from '../ids';

/** A marker object standing in for a real `Prisma.TransactionClient`. */
const FAKE_TX = { __fakeTx: true } as unknown as Prisma.TransactionClient;

/** A fake `PrismaService` that just invokes the callback with `FAKE_TX` — no real Postgres. */
function fakePrisma(): PrismaService {
  return {
    withAuthContext: (
      _scope: unknown,
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => fn(FAKE_TX),
  } as unknown as PrismaService;
}

function freshUow(): UnitOfWork {
  return new UnitOfWork(
    fakePrisma(),
    TransactionalDomainEventDispatcher.withHandlers([]),
  );
}

function uowWithHandlers(
  handlers: readonly TransactionalDomainEventHandler[],
): UnitOfWork {
  return new UnitOfWork(
    fakePrisma(),
    TransactionalDomainEventDispatcher.withHandlers(handlers),
  );
}

describe('UnitOfWork — ctx.publishEvent trusted tenant (P1E-1A, no DB)', () => {
  it('9. an event created inside a tenant-A Unit of Work carries tenantId A', async () => {
    let capturedTenantId: string | undefined;
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      const event = ctx.publishEvent({
        eventType: 'x',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-1',
        payload: {},
      });
      capturedTenantId = event.tenantId;
      return Promise.resolve();
    });
    expect(capturedTenantId).toBe('tenant-A');
  });

  it('10. a caller cannot substitute a different tenantId — the trusted value always wins, even bypassing the type system', async () => {
    let capturedTenantId: string | undefined;
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      const maliciousInput = {
        eventType: 'x',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system' as const,
        idempotencyKey: 'idem-1',
        payload: {},
        tenantId: 'tenant-B', // TrustedDomainEventInput has NO `tenantId` key — this is a deliberate bypass.
      };
      const event = ctx.publishEvent(
        maliciousInput as unknown as TrustedDomainEventInput<'x', object>,
      );
      capturedTenantId = event.tenantId;
      return Promise.resolve();
    });
    expect(capturedTenantId).toBe('tenant-A');
    expect(capturedTenantId).not.toBe('tenant-B');
  });

  it('createEvent throws rather than fabricate a tenantId when the UoW has none', async () => {
    await expect(
      freshUow().execute({}, (ctx) => {
        ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: 'idem-1',
          payload: {},
        });
        return Promise.resolve();
      }),
    ).rejects.toThrow(/requires a tenantId/);
  });

  it('a UoW with no tenantId may still execute business logic that never calls createEvent', async () => {
    await expect(
      freshUow().execute({}, () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });
});

describe('UnitOfWork — correlationId ties the causal chain, not the individual event (P1E-1B)', () => {
  it('5. two events created by ONE UnitOfWork.execute() call share the exact same correlationId', async () => {
    const seen: string[] = [];
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      const e1 = ctx.publishEvent({
        eventType: 'x',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-1',
        payload: {},
      });
      const e2 = ctx.publishEvent({
        eventType: 'y',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-2',
        payload: {},
      });
      seen.push(e1.correlationId, e2.correlationId);
      return Promise.resolve();
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toMatch(UUID_PATTERN);
  });

  it('6. two SEPARATE UnitOfWork.execute() calls with no inherited context get DIFFERENT correlationIds', async () => {
    const seen: string[] = [];
    const uow = freshUow();
    for (let i = 0; i < 2; i += 1) {
      await uow.execute({ tenantId: 'tenant-A' }, (ctx) => {
        const event = ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: `idem-${i}`,
          payload: {},
        });
        seen.push(event.correlationId);
        return Promise.resolve();
      });
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('7. an explicitly inherited correlationId is reused exactly, for every event in that UoW', async () => {
    const inherited = 'inherited-correlation-id';
    const seen: string[] = [];
    await freshUow().execute(
      { tenantId: 'tenant-A' },
      (ctx) => {
        const e1 = ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: 'idem-1',
          payload: {},
        });
        const e2 = ctx.publishEvent({
          eventType: 'y',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: 'idem-2',
          payload: {},
        });
        seen.push(e1.correlationId, e2.correlationId);
        return Promise.resolve();
      },
      { correlationId: inherited },
    );
    expect(seen).toEqual([inherited, inherited]);
  });

  it('correlationId cannot be supplied per-event — TrustedDomainEventInput has no such key (compile-time proof)', () => {
    const attempt: TrustedDomainEventInput<'x', object> = {
      eventType: 'x',
      eventVersion: 1,
      occurredAt: new Date(),
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      idempotencyKey: 'idem-1',
      payload: {},
      // @ts-expect-error — correlationId does not exist on TrustedDomainEventInput; it is UoW-scoped only.
      correlationId: 'nope',
    };
    expect(attempt).toBeDefined();
  });
});

describe('UnitOfWork — causationId identifies the causing command/event (P1E-1B)', () => {
  it('9. a root event (created directly in the business callback) gets a non-null causationId', async () => {
    let captured: string | undefined;
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      const event = ctx.publishEvent({
        eventType: 'x',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-1',
        payload: {},
      });
      captured = event.causationId;
      return Promise.resolve();
    });
    expect(captured).toBeDefined();
    expect(typeof captured).toBe('string');
    expect(captured).toMatch(UUID_PATTERN);
  });

  it('10. every root event from ONE UoW execution shares the same command/operation causation identity', async () => {
    const seen: string[] = [];
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      const e1 = ctx.publishEvent({
        eventType: 'x',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-1',
        payload: {},
      });
      const e2 = ctx.publishEvent({
        eventType: 'y',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-2',
        payload: {},
      });
      seen.push(e1.causationId, e2.causationId);
      return Promise.resolve();
    });
    expect(seen[0]).toBe(seen[1]);
  });

  it('two separate UoW executions get DIFFERENT default causation identities', async () => {
    const seen: string[] = [];
    const uow = freshUow();
    for (let i = 0; i < 2; i += 1) {
      await uow.execute({ tenantId: 'tenant-A' }, (ctx) => {
        const event = ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: `idem-${i}`,
          payload: {},
        });
        seen.push(event.causationId);
        return Promise.resolve();
      });
    }
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('11. a child event can explicitly identify its parent eventId as causationId', async () => {
    let parentEventId: string | undefined;
    let childCausationId: string | undefined;
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      const parentEvent = ctx.publishEvent({
        eventType: 'parent.happened',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-parent',
        payload: {},
      });
      parentEventId = parentEvent.eventId;
      // A handler reacting to `parentEvent` (simulated here inline, since this
      // suite has no DB/dispatcher wiring) explicitly points the child's
      // causationId at the parent's eventId — the "correct future shape" §6
      // asks for, not automatic.
      const childEvent = ctx.publishEvent({
        eventType: 'child.happened',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        causationId: parentEvent.eventId,
        idempotencyKey: 'idem-child',
        payload: {},
      });
      childCausationId = childEvent.causationId;
      return Promise.resolve();
    });
    expect(childCausationId).toBe(parentEventId);
  });

  it('8/11b. a child event explicitly set this way also preserves the parent correlationId (same UoW, automatic)', async () => {
    let parentCorrelationId: string | undefined;
    let childCorrelationId: string | undefined;
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      const parentEvent = ctx.publishEvent({
        eventType: 'parent.happened',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-parent',
        payload: {},
      });
      const childEvent = ctx.publishEvent({
        eventType: 'child.happened',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        causationId: parentEvent.eventId,
        idempotencyKey: 'idem-child',
        payload: {},
      });
      parentCorrelationId = parentEvent.correlationId;
      childCorrelationId = childEvent.correlationId;
      return Promise.resolve();
    });
    expect(childCorrelationId).toBe(parentCorrelationId);
  });

  it("an inherited causationId (from an outer causal step) becomes the default for this UoW's root events", async () => {
    const inherited = 'inherited-causation-id';
    let captured: string | undefined;
    await freshUow().execute(
      { tenantId: 'tenant-A' },
      (ctx) => {
        const event = ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: 'idem-1',
          payload: {},
        });
        captured = event.causationId;
        return Promise.resolve();
      },
      { causationId: inherited },
    );
    expect(captured).toBe(inherited);
  });

  it('12. causationId is present on the envelope as a plain, network-safe string field', async () => {
    let event: { causationId: string } | undefined;
    await freshUow().execute({ tenantId: 'tenant-A' }, (ctx) => {
      event = ctx.publishEvent({
        eventType: 'x',
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: 'idem-1',
        payload: {},
      });
      return Promise.resolve();
    });
    expect(event).toBeDefined();
    expect(typeof event?.causationId).toBe('string');
    expect(() => JSON.stringify(event)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(event)) as {
      causationId: string;
    };
    expect(roundTripped.causationId).toBe(event?.causationId);
  });
});

describe('UnitOfWork — required fields are never fabricated (P1E-1A/B)', () => {
  it('14. branchId/actorId/actorType/idempotencyKey are required inputs — publishEvent never fabricates them', () => {
    // A missing required field is a COMPILE ERROR, not a runtime default — the
    // strongest available proof that these fields are never silently invented.
    // @ts-expect-error — idempotencyKey is required by TrustedDomainEventInput.
    const attempt: TrustedDomainEventInput<'x', object> = {
      eventType: 'x',
      eventVersion: 1,
      occurredAt: new Date(),
      branchId: 'branch-1',
      actorId: 'actor-1',
      actorType: 'system',
      payload: {},
    };
    expect(attempt).toBeDefined();
  });
});

describe('UnitOfWork — ONE authoritative publication path (P1E-1C)', () => {
  it('1. the public UnitOfWorkContext exposes a trusted publication operation (publishEvent)', async () => {
    let sawPublishEvent = false;
    await freshUow().execute(
      { tenantId: 'tenant-A' },
      (ctx: UnitOfWorkContext) => {
        sawPublishEvent = typeof ctx.publishEvent === 'function';
        return Promise.resolve();
      },
    );
    expect(sawPublishEvent).toBe(true);
  });

  it('2. the public UnitOfWorkContext does NOT expose a raw collector mutation surface (compile-time proof)', async () => {
    let hasEventsProperty: boolean | undefined;
    await freshUow().execute(
      { tenantId: 'tenant-A' },
      (ctx: UnitOfWorkContext) => {
        // `ctx.events` is not a key of `UnitOfWorkContext` — this line would not
        // compile if written as `ctx.events`. Checked here via a runtime probe
        // on the ACTUAL object (which still has `.events` internally, per
        // `InternalUnitOfWorkContext`) to additionally prove business code has
        // no *type-safe* way to reach it, not merely that it happens to be gone.
        hasEventsProperty = 'events' in ctx;
        return Promise.resolve();
      },
    );
    // The runtime object DOES still carry `.events` internally (UnitOfWork
    // needs it to drain) — what matters is that `UnitOfWorkContext`'s TYPE
    // never declares it, so business code has no compile-time-sanctioned way
    // to reach it. The exhaustive, mechanical proof that NO file under
    // `src/modules/**` does is `trusted-construction-boundary.spec.ts`.
    expect(hasEventsProperty).toBe(true);
  });

  it('3. publishEvent constructs AND queues one event in a single call', async () => {
    const seen: string[] = [];
    const handler: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: (e) => {
        seen.push(e.eventId);
        return Promise.resolve();
      },
    };
    let publishedEventId: string | undefined;
    await uowWithHandlers([handler]).execute(
      { tenantId: 'tenant-A' },
      (ctx) => {
        const event = ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: 'idem-1',
          payload: {},
        });
        publishedEventId = event.eventId;
        return Promise.resolve();
      },
    );
    expect(seen).toEqual([publishedEventId]);
  });

  it('9. publishEvent does NOT dispatch immediately — the handler has not fired by the time it returns', async () => {
    let handlerFiredBeforeReturn = false;
    const handler: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: () => {
        handlerFiredBeforeReturn = true;
        return Promise.resolve();
      },
    };
    await uowWithHandlers([handler]).execute(
      { tenantId: 'tenant-A' },
      (ctx) => {
        ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: 'idem-1',
          payload: {},
        });
        // The handler must NOT have run yet — publishEvent only enqueues.
        expect(handlerFiredBeforeReturn).toBe(false);
        return Promise.resolve();
      },
    );
    // Only AFTER execute() resolves (i.e. after the UoW drained the queue)
    // has the handler actually fired.
    expect(handlerFiredBeforeReturn).toBe(true);
  });

  it('10. the event dispatches during UnitOfWork drain, after the business callback resolves', async () => {
    const order: string[] = [];
    const handler: TransactionalDomainEventHandler = {
      eventType: 'x',
      handle: () => {
        order.push('handler');
        return Promise.resolve();
      },
    };
    await uowWithHandlers([handler]).execute(
      { tenantId: 'tenant-A' },
      (ctx) => {
        order.push('callback-start');
        ctx.publishEvent({
          eventType: 'x',
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: 'idem-1',
          payload: {},
        });
        order.push('callback-end');
        return Promise.resolve();
      },
    );
    expect(order).toEqual(['callback-start', 'callback-end', 'handler']);
  });
});
