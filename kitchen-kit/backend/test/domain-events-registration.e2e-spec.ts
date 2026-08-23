import { Injectable, Module } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DomainEventHandler } from './../src/common/domain-events/domain-event-handler.decorator';
import { UnitOfWork } from './../src/common/domain-events/unit-of-work';
import { UnitOfWorkContext } from './../src/common/domain-events/unit-of-work-context';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';

/**
 * P1E-1A CORRECTION A — production-style Nest registration proof.
 *
 * P1E-1's own e2e suite (`domain-events.e2e-spec.ts`) proves the transactional
 * MECHANISM by constructing `TransactionalDomainEventDispatcher.withHandlers([...])`
 * directly — which never exercises the actual Nest DI/discovery path a real
 * bounded-context module would use. This suite proves THAT path: a
 * `@DomainEventHandler`-decorated PRIVATE provider, declared in its own
 * test-only module, discovered by `DomainEventHandlerRegistry`, and invoked by
 * a `UnitOfWork` resolved from the real Nest container — `app.get(UnitOfWork)`,
 * never `new UnitOfWork(...)`.
 *
 * `TestRegistrationModule` below is imported ALONGSIDE `AppModule` in the
 * `TestingModule`, never INTO it — `AppModule` itself is never touched by this
 * suite, matching "do NOT register a fake production Kitchen business
 * handler" and "AppModule importing a private Kitchen handler class" being
 * exactly what this mechanism must NOT require. The publisher-side code in
 * these tests (the `uow.execute` business callback) never imports any handler
 * class either — it only knows the event TYPE string, exactly as a real Sales
 * publisher would only know `ORDER_LINE_FIRED_EVENT_TYPE` from
 * `modules/sales/contract`.
 */

const REGISTRATION_COMMIT_EVENT = 'registration.commit.proof';
const REGISTRATION_MULTI_EVENT = 'registration.multi.proof';
const REGISTRATION_FAILURE_EVENT = 'registration.failure.proof';

@Injectable()
class TestRegistrationRecorder {
  readonly calls: Array<{ handler: string; correlationId: string }> = [];
  record(handler: string, correlationId: string): void {
    this.calls.push({ handler, correlationId });
  }
}

/**
 * The PRIVATE handler for the "commit" scenario. Writes a subscriber row via
 * `ctx.tx` — the same transaction client the publisher used, resolved purely
 * through discovery, never imported by anything that publishes the event.
 */
@Injectable()
@DomainEventHandler(REGISTRATION_COMMIT_EVENT)
class CommitProofHandler {
  constructor(private readonly recorder: TestRegistrationRecorder) {}

  async handle(
    event: { correlationId: string; payload: unknown },
    ctx: UnitOfWorkContext,
  ): Promise<void> {
    this.recorder.record('CommitProofHandler', event.correlationId);
    const { userId, tenantId, membershipId } = event.payload as {
      userId: string;
      tenantId: string;
      membershipId: string;
    };
    await ctx.tx.membership.create({
      data: { id: membershipId, userId, tenantId },
    });
  }
}

/** One of TWO handlers registered for the SAME event type — proves item 4 (multiple handlers coexist). */
@Injectable()
@DomainEventHandler(REGISTRATION_MULTI_EVENT)
class MultiProofHandlerAlpha {
  constructor(private readonly recorder: TestRegistrationRecorder) {}
  handle(event: { correlationId: string }): Promise<void> {
    this.recorder.record('MultiProofHandlerAlpha', event.correlationId);
    return Promise.resolve();
  }
}

@Injectable()
@DomainEventHandler(REGISTRATION_MULTI_EVENT)
class MultiProofHandlerBeta {
  constructor(private readonly recorder: TestRegistrationRecorder) {}
  handle(event: { correlationId: string }): Promise<void> {
    this.recorder.record('MultiProofHandlerBeta', event.correlationId);
    return Promise.resolve();
  }
}

/** Writes its own row, THEN throws — real-DB rollback proof through the DI-resolved path. */
@Injectable()
@DomainEventHandler(REGISTRATION_FAILURE_EVENT)
class FailingProofHandler {
  constructor(private readonly recorder: TestRegistrationRecorder) {}

  async handle(
    event: { correlationId: string; payload: unknown },
    ctx: UnitOfWorkContext,
  ): Promise<void> {
    this.recorder.record('FailingProofHandler', event.correlationId);
    const { userId, tenantId, membershipId } = event.payload as {
      userId: string;
      tenantId: string;
      membershipId: string;
    };
    await ctx.tx.membership.create({
      data: { id: membershipId, userId, tenantId },
    });
    throw new Error('registration proof: subscriber failed');
  }
}

/**
 * Test-only bounded context. Never imported by `AppModule`, never imported by
 * any publisher — its providers are found purely by `DomainEventHandlerRegistry`
 * scanning the whole Nest container, which is the property this suite proves.
 */
@Module({
  providers: [
    TestRegistrationRecorder,
    CommitProofHandler,
    MultiProofHandlerAlpha,
    MultiProofHandlerBeta,
    FailingProofHandler,
  ],
})
class TestRegistrationModule {}

describe('domain-event Nest-container handler registration — real PostgreSQL proof (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let uow: UnitOfWork;
  let recorder: TestRegistrationRecorder;

  const tenantA = newId();
  const tenantIds: string[] = [tenantA];
  const userIds: string[] = [];
  const membershipIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, TestRegistrationModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    // Resolved through the REAL Nest container — never `new UnitOfWork(...)`.
    uow = app.get(UnitOfWork);
    recorder = app.get(TestRegistrationRecorder);

    await admin.tenant.create({
      data: {
        id: tenantA,
        slug: `domain-events-registration-${Date.now()}`,
        legalName: 'Domain Events Registration Proof',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      },
    });
  });

  afterAll(async () => {
    await admin.membership
      .deleteMany({ where: { id: { in: membershipIds } } })
      .catch(() => undefined);
    await admin.user
      .deleteMany({ where: { id: { in: userIds } } })
      .catch(() => undefined);
    await admin.tenant
      .deleteMany({ where: { id: { in: tenantIds } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  async function freshUser(): Promise<string> {
    const userId = newId();
    userIds.push(userId);
    await admin.user.create({
      data: {
        id: userId,
        email: `domain-events-registration.${userId}@example.com`,
        displayName: 'Domain Events Registration Fixture',
      },
    });
    return userId;
  }

  function newMembershipId(): string {
    const id = newId();
    membershipIds.push(id);
    return id;
  }

  it('1/2/3. a private handler registered via a test-only Nest module is invoked by the DI-resolved UnitOfWork — the publisher constructs no dispatcher and imports no handler', async () => {
    const publisherUser = await freshUser();
    const subscriberUser = await freshUser();
    const publisherId = newMembershipId();
    const subscriberId = newMembershipId();
    const tag = newId(); // a per-test tag for a unique idempotencyKey only — NOT the event's correlationId

    let recordedCorrelationId: string | undefined;

    // The "publisher" below knows only the event TYPE STRING — exactly what a
    // real Sales producer would import from `modules/sales/contract`. It never
    // references `CommitProofHandler`. It also never supplies a
    // correlationId — `ctx.publishEvent` derives it from the enclosing
    // `UnitOfWork.execute()` call (P1E-1B); there is no field for it to set.
    await uow.execute({ tenantId: tenantA }, async (ctx) => {
      await ctx.tx.membership.create({
        data: { id: publisherId, userId: publisherUser, tenantId: tenantA },
      });
      const event = ctx.publishEvent({
        eventType: REGISTRATION_COMMIT_EVENT,
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: `idem-${tag}`,
        payload: {
          userId: subscriberUser,
          tenantId: tenantA,
          membershipId: subscriberId,
        },
      });
      recordedCorrelationId = event.correlationId;
    });

    expect(
      recorder.calls.some(
        (c) =>
          c.handler === 'CommitProofHandler' &&
          c.correlationId === recordedCorrelationId,
      ),
    ).toBe(true);

    const [pub, sub] = await Promise.all([
      admin.membership.findUnique({ where: { id: publisherId } }),
      admin.membership.findUnique({ where: { id: subscriberId } }),
    ]);
    expect(pub).not.toBeNull();
    expect(sub).not.toBeNull();
  });

  it('4/5/6. multiple handlers for the same event type coexist and fire in a deterministic order; a differently-typed handler never fires for it', async () => {
    const tag = newId();
    let recordedCorrelationId: string | undefined;

    await uow.execute({ tenantId: tenantA }, (ctx) => {
      const event = ctx.publishEvent({
        eventType: REGISTRATION_MULTI_EVENT,
        eventVersion: 1,
        occurredAt: new Date(),
        branchId: 'branch-1',
        actorId: 'actor-1',
        actorType: 'system',
        idempotencyKey: `idem-${tag}`,
        payload: {},
      });
      recordedCorrelationId = event.correlationId;
      return Promise.resolve();
    });

    const forThisCall = recorder.calls.filter(
      (c) => c.correlationId === recordedCorrelationId,
    );
    // Both registered handlers fired exactly once each...
    expect(forThisCall.map((c) => c.handler).sort()).toEqual([
      'MultiProofHandlerAlpha',
      'MultiProofHandlerBeta',
    ]);
    // ...in a deterministic order (alphabetical by provider class name — see
    // `DomainEventHandlerRegistry`'s own docblock for why).
    expect(forThisCall.map((c) => c.handler)).toEqual([
      'MultiProofHandlerAlpha',
      'MultiProofHandlerBeta',
    ]);
    // A handler registered for a DIFFERENT event type never appears.
    expect(forThisCall.some((c) => c.handler === 'CommitProofHandler')).toBe(
      false,
    );
    expect(forThisCall.some((c) => c.handler === 'FailingProofHandler')).toBe(
      false,
    );
  });

  it('7/8. handler failure through the DI-resolved path propagates and rolls back BOTH the publisher and subscriber writes in real PostgreSQL', async () => {
    const publisherUser = await freshUser();
    const subscriberUser = await freshUser();
    const publisherId = newMembershipId();
    const subscriberId = newMembershipId();
    const tag = newId();
    let recordedCorrelationId: string | undefined;

    await expect(
      uow.execute({ tenantId: tenantA }, async (ctx) => {
        await ctx.tx.membership.create({
          data: { id: publisherId, userId: publisherUser, tenantId: tenantA },
        });
        const event = ctx.publishEvent({
          eventType: REGISTRATION_FAILURE_EVENT,
          eventVersion: 1,
          occurredAt: new Date(),
          branchId: 'branch-1',
          actorId: 'actor-1',
          actorType: 'system',
          idempotencyKey: `idem-${tag}`,
          payload: {
            userId: subscriberUser,
            tenantId: tenantA,
            membershipId: subscriberId,
          },
        });
        recordedCorrelationId = event.correlationId;
      }),
    ).rejects.toThrow('registration proof: subscriber failed');

    expect(
      recorder.calls.some(
        (c) =>
          c.handler === 'FailingProofHandler' &&
          c.correlationId === recordedCorrelationId,
      ),
    ).toBe(true);

    const [pub, sub] = await Promise.all([
      admin.membership.findUnique({ where: { id: publisherId } }),
      admin.membership.findUnique({ where: { id: subscriberId } }),
    ]);
    expect(pub).toBeNull();
    expect(sub).toBeNull();
  });
});
