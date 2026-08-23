import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createDomainEvent } from './internal/create-domain-event';
import { DomainEventHandler } from './domain-event-handler.decorator';
import { DomainEventHandlerRegistry } from './domain-event-handler-registry.service';
import { UnitOfWorkContext } from './unit-of-work-context';

/** A minimal, fully-typed fixture — these tests exercise ROUTING, not envelope content. */
const FIXTURE_EVENT = createDomainEvent({
  eventType: 'registry.test.fixture',
  eventVersion: 1,
  occurredAt: new Date(),
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  actorId: 'actor-1',
  actorType: 'system' as const,
  correlationId: 'corr-1',
  causationId: 'cause-1',
  idempotencyKey: 'idem-1',
  payload: {},
});
const FIXTURE_CTX: UnitOfWorkContext = {
  tx: {} as UnitOfWorkContext['tx'],
  publishEvent: () => {
    throw new Error('not used by this fixture');
  },
};

/**
 * Pure Nest-DI proof of `DomainEventHandlerRegistry` — no database, no
 * `UnitOfWork`. Confirms the registry itself discovers, filters, and orders
 * decorated providers correctly; `test/domain-events-registration.e2e-spec.ts`
 * (P1E-1A) separately proves the WHOLE production path (registry + dispatcher
 * + Unit of Work + real PostgreSQL) end to end.
 */
describe('DomainEventHandlerRegistry', () => {
  @Injectable()
  @DomainEventHandler('registry.test.alpha')
  class HandlerZebra {
    async handle(): Promise<void> {
      /* no-op fixture */
    }
  }

  @Injectable()
  @DomainEventHandler('registry.test.alpha')
  class HandlerApple {
    async handle(): Promise<void> {
      /* no-op fixture */
    }
  }

  @Injectable()
  @DomainEventHandler('registry.test.beta')
  class HandlerBeta {
    async handle(): Promise<void> {
      /* no-op fixture */
    }
  }

  @Injectable()
  class UndecoratedProvider {}

  async function buildRegistry(
    providers: (new (...args: never[]) => object)[],
  ): Promise<DomainEventHandlerRegistry> {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [DomainEventHandlerRegistry, ...providers],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const registry = app.get(DomainEventHandlerRegistry);
    await app.close();
    return registry;
  }

  it('discovers a decorated provider for its event type', async () => {
    const registry = await buildRegistry([HandlerZebra, UndecoratedProvider]);
    expect(registry.handlersFor('registry.test.alpha')).toHaveLength(1);
  });

  it('ignores a provider carrying no @DomainEventHandler decorator', async () => {
    const registry = await buildRegistry([HandlerZebra, UndecoratedProvider]);
    expect(registry.all).toHaveLength(1);
  });

  it('unrelated event types return no handlers', async () => {
    const registry = await buildRegistry([HandlerBeta]);
    expect(registry.handlersFor('registry.test.alpha')).toEqual([]);
  });

  it('multiple decorated providers for the same event type all register', async () => {
    const registry = await buildRegistry([HandlerZebra, HandlerApple]);
    expect(registry.handlersFor('registry.test.alpha')).toHaveLength(2);
  });

  it('registration order is deterministic (sorted by provider class name), independent of declaration order', async () => {
    const callOrder: string[] = [];

    @Injectable()
    @DomainEventHandler('registry.test.order')
    class ZzzHandler {
      handle(): Promise<void> {
        callOrder.push('Zzz');
        return Promise.resolve();
      }
    }

    @Injectable()
    @DomainEventHandler('registry.test.order')
    class AaaHandler {
      handle(): Promise<void> {
        callOrder.push('Aaa');
        return Promise.resolve();
      }
    }

    // Declared Zzz-before-Aaa; the registry must still invoke Aaa first.
    const registry = await buildRegistry([ZzzHandler, AaaHandler]);
    for (const handler of registry.handlersFor('registry.test.order')) {
      await handler.handle(FIXTURE_EVENT, FIXTURE_CTX);
    }
    expect(callOrder).toEqual(['Aaa', 'Zzz']);
  });

  it('a handler fires only for its own event type, not another registered one', async () => {
    const seen: string[] = [];

    @Injectable()
    @DomainEventHandler('registry.test.alpha')
    class RecordingHandler {
      handle(): Promise<void> {
        seen.push('alpha-fired');
        return Promise.resolve();
      }
    }

    const registry = await buildRegistry([RecordingHandler, HandlerBeta]);
    for (const handler of registry.handlersFor('registry.test.alpha')) {
      await handler.handle(FIXTURE_EVENT, FIXTURE_CTX);
    }
    expect(seen).toEqual(['alpha-fired']);
  });

  it('throws at bootstrap if a decorated provider has no handle() method', async () => {
    @Injectable()
    @DomainEventHandler('registry.test.broken')
    class NotAHandler {
      // Deliberately missing `handle`.
    }

    await expect(
      buildRegistry([NotAHandler as unknown as new () => object]),
    ).rejects.toThrow(/has no handle\(event, ctx\) method/);
  });
});
