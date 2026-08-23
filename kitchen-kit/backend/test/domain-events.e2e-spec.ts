import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  TransactionalDomainEventDispatcher,
  TransactionalDomainEventHandler,
} from './../src/common/domain-events/domain-event-dispatcher';
import { UnitOfWork } from './../src/common/domain-events/unit-of-work';
import { UnitOfWorkContext } from './../src/common/domain-events/unit-of-work-context';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * REAL-DATABASE proof for P1E-1's transaction-aware domain-event mechanism
 * (SRS §5.5.2). Every assertion here is made through Postgres itself — no
 * Prisma method is mocked — because a rollback/commit/isolation claim proven
 * only against a mock proves nothing about the actual guarantee.
 *
 * `identity.memberships` (unique on `[userId, tenantId]`, FK to `identity.users`
 * and `identity.tenants`) stands in for a "business write" and a "subscriber
 * write": it is the smallest already-RLS-enabled, tenant-scoped table in the
 * schema, and using it means this suite needs no Sales/Kitchen fixtures and
 * makes no claim about Fire (P1E-1 publishes no business event).
 *
 * The `UnitOfWork` and `TransactionalDomainEventDispatcher` instances used
 * below are constructed directly (`.withHandlers(...)`, the manual/test path —
 * see `domain-event-handler-source.ts`) with a handler set for this test only.
 * `PrismaService` itself is the app's real singleton. Every event this suite
 * records goes through `ctx.publishEvent(...)` (P1E-1C) — the one trusted
 * publication surface — exactly as real business code must; there is no lower-
 * level path left for a test (or anyone) to reach from a `UnitOfWork` callback.
 * This suite proves the transactional MECHANISM in isolation;
 * `test/domain-events-registration.e2e-spec.ts` (P1E-1A) separately proves
 * handlers reached through actual Nest-container registration
 * (`@DomainEventHandler`/`DomainEventHandlerRegistry`) behave the same way —
 * the property this suite alone does not establish.
 */
describe('domain-event Unit of Work — real PostgreSQL proof (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;

  const tenantA = newId();
  const tenantB = newId();
  const tenantIds: string[] = [tenantA, tenantB];
  const userIds: string[] = [];
  const membershipIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);

    await admin.tenant.createMany({
      data: [tenantA, tenantB].map((id, i) => ({
        id,
        slug: `domain-events-${i}-${Date.now()}`,
        legalName: 'Domain Events UoW Proof',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
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

  /** A fresh (user, membership id) pair, so `[userId, tenantId]` never collides across tests. */
  async function freshUser(): Promise<string> {
    const userId = newId();
    userIds.push(userId);
    await admin.user.create({
      data: {
        id: userId,
        email: `domain-events.${userId}@example.com`,
        displayName: 'Domain Events Fixture',
      },
    });
    return userId;
  }

  function newMembershipId(): string {
    const id = newId();
    membershipIds.push(id);
    return id;
  }

  /** The `ctx.publishEvent(...)` input — no `tenantId`/`correlationId`; the UoW binds both. */
  const testEventInput = (n: number) => ({
    eventType: 'test.uow.proof' as const,
    eventVersion: 1,
    occurredAt: new Date(),
    branchId: 'branch-1',
    actorId: 'actor-1',
    actorType: 'system' as const,
    idempotencyKey: `idem-${n}`,
    payload: { n },
  });

  it('11. publisher DB write + subscriber DB write commit together', async () => {
    const publisherUser = await freshUser();
    const subscriberUser = await freshUser();
    const publisherId = newMembershipId();
    const subscriberId = newMembershipId();

    const handler: TransactionalDomainEventHandler = {
      eventType: 'test.uow.proof',
      handle: async (_e, ctx: UnitOfWorkContext) => {
        await ctx.tx.membership.create({
          data: { id: subscriberId, userId: subscriberUser, tenantId: tenantA },
        });
      },
    };
    const uow = new UnitOfWork(
      prisma,
      TransactionalDomainEventDispatcher.withHandlers([handler]),
    );

    await uow.execute({ tenantId: tenantA }, async (ctx) => {
      await ctx.tx.membership.create({
        data: { id: publisherId, userId: publisherUser, tenantId: tenantA },
      });
      ctx.publishEvent(testEventInput(1));
    });

    const [pub, sub] = await Promise.all([
      admin.membership.findUnique({ where: { id: publisherId } }),
      admin.membership.findUnique({ where: { id: subscriberId } }),
    ]);
    expect(pub).not.toBeNull();
    expect(sub).not.toBeNull();
  });

  it('12/13. subscriber failure rolls back BOTH the publisher write and the subscriber write', async () => {
    const publisherUser = await freshUser();
    const subscriberUser = await freshUser();
    const publisherId = newMembershipId();
    const subscriberId = newMembershipId();

    const handler: TransactionalDomainEventHandler = {
      eventType: 'test.uow.proof',
      handle: async (_e, ctx: UnitOfWorkContext) => {
        // The subscriber's own write happens BEFORE it throws, proving the
        // rollback undoes work already performed inside this same transaction,
        // not merely work that was about to happen.
        await ctx.tx.membership.create({
          data: { id: subscriberId, userId: subscriberUser, tenantId: tenantA },
        });
        throw new Error('subscriber failed');
      },
    };
    const uow = new UnitOfWork(
      prisma,
      TransactionalDomainEventDispatcher.withHandlers([handler]),
    );

    await expect(
      uow.execute({ tenantId: tenantA }, async (ctx) => {
        await ctx.tx.membership.create({
          data: { id: publisherId, userId: publisherUser, tenantId: tenantA },
        });
        ctx.publishEvent(testEventInput(2));
      }),
    ).rejects.toThrow('subscriber failed');

    const [pub, sub] = await Promise.all([
      admin.membership.findUnique({ where: { id: publisherId } }),
      admin.membership.findUnique({ where: { id: subscriberId } }),
    ]);
    expect(pub).toBeNull();
    expect(sub).toBeNull();
  });

  it('14. the subscriber write is not visible outside the transaction until the whole Unit of Work commits', async () => {
    const publisherUser = await freshUser();
    const subscriberUser = await freshUser();
    const publisherId = newMembershipId();
    const subscriberId = newMembershipId();

    let visibleWhileHandlerRan: boolean | null = null;

    const handler: TransactionalDomainEventHandler = {
      eventType: 'test.uow.proof',
      handle: async (_e, ctx: UnitOfWorkContext) => {
        await ctx.tx.membership.create({
          data: { id: subscriberId, userId: subscriberUser, tenantId: tenantA },
        });
        // A SEPARATE connection (the admin client), mid-transaction: Postgres's
        // default READ COMMITTED isolation means an uncommitted row is
        // invisible to it — this is the direct proof of "before commit is
        // observable".
        const seenFromOutside = await admin.membership.findUnique({
          where: { id: subscriberId },
        });
        visibleWhileHandlerRan = seenFromOutside !== null;
      },
    };
    const uow = new UnitOfWork(
      prisma,
      TransactionalDomainEventDispatcher.withHandlers([handler]),
    );

    await uow.execute({ tenantId: tenantA }, async (ctx) => {
      await ctx.tx.membership.create({
        data: { id: publisherId, userId: publisherUser, tenantId: tenantA },
      });
      ctx.publishEvent(testEventInput(3));
    });

    expect(visibleWhileHandlerRan).toBe(false);
    const afterCommit = await admin.membership.findUnique({
      where: { id: subscriberId },
    });
    expect(afterCommit).not.toBeNull();
  });

  it('15. the RLS tenant context set at Unit-of-Work start is still active inside the subscriber', async () => {
    const ownUser = await freshUser();
    const otherTenantUser = await freshUser();
    const ownId = newMembershipId();
    const otherTenantId = newMembershipId();

    // A row in tenant B, arranged with the superuser/migrator client (bypasses RLS).
    await admin.membership.create({
      data: { id: otherTenantId, userId: otherTenantUser, tenantId: tenantB },
    });

    let seenFromInsideHandler: string[] = [];
    const handler: TransactionalDomainEventHandler = {
      eventType: 'test.uow.proof',
      handle: async (_e, ctx: UnitOfWorkContext) => {
        // No explicit context is set here — proving the RLS context the Unit
        // of Work established at `withAuthContext` start (tenant A) is still
        // the one PostgreSQL enforces for this query, executed on the SAME tx.
        const rows = await ctx.tx.membership.findMany({
          where: { id: { in: [ownId, otherTenantId] } },
          select: { id: true },
        });
        seenFromInsideHandler = rows.map((r) => r.id);
      },
    };
    const uow = new UnitOfWork(
      prisma,
      TransactionalDomainEventDispatcher.withHandlers([handler]),
    );

    await uow.execute({ tenantId: tenantA }, async (ctx) => {
      await ctx.tx.membership.create({
        data: { id: ownId, userId: ownUser, tenantId: tenantA },
      });
      ctx.publishEvent(testEventInput(4));
    });

    expect(seenFromInsideHandler).toEqual([ownId]);
  });

  it('16. concurrent Units of Work for different tenants never cross-contaminate event queues', async () => {
    const observedByHandlerForA: number[] = [];
    const observedByHandlerForB: number[] = [];

    const userA = await freshUser();
    const userB = await freshUser();
    const membershipIdA = newMembershipId();
    const membershipIdB = newMembershipId();

    const handlerA: TransactionalDomainEventHandler = {
      eventType: 'test.uow.proof',
      handle: (e) => {
        observedByHandlerForA.push((e.payload as { n: number }).n);
        return Promise.resolve();
      },
    };
    const handlerB: TransactionalDomainEventHandler = {
      eventType: 'test.uow.proof',
      handle: (e) => {
        observedByHandlerForB.push((e.payload as { n: number }).n);
        return Promise.resolve();
      },
    };
    const uowA = new UnitOfWork(
      prisma,
      TransactionalDomainEventDispatcher.withHandlers([handlerA]),
    );
    const uowB = new UnitOfWork(
      prisma,
      TransactionalDomainEventDispatcher.withHandlers([handlerB]),
    );

    await Promise.all([
      uowA.execute({ tenantId: tenantA }, async (ctx) => {
        await ctx.tx.membership.create({
          data: { id: membershipIdA, userId: userA, tenantId: tenantA },
        });
        // Two events published for A's own dispatcher/collector pair only.
        ctx.publishEvent(testEventInput(101));
        ctx.publishEvent(testEventInput(102));
      }),
      uowB.execute({ tenantId: tenantB }, async (ctx) => {
        await ctx.tx.membership.create({
          data: { id: membershipIdB, userId: userB, tenantId: tenantB },
        });
        ctx.publishEvent(testEventInput(201));
      }),
    ]);

    expect(observedByHandlerForA.sort()).toEqual([101, 102]);
    expect(observedByHandlerForB).toEqual([201]);
  });
});
