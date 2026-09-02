import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  COUNTRY_PACK_SIGNATURE_VERIFIER,
  COUNTRY_PACK_TRUST_STORE,
  Ed25519CountryPackSignatureVerifier,
} from './../src/modules/localisation/country-pack/country-pack.signature';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './../src/modules/localisation/country-pack/country-pack.signing.fixture';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { DayCloseService } from './../src/modules/treasury/day-close/day-close.service';
import { createMigratorClient } from './rls-admin';
import {
  dayCloseAuthorization,
  activatePastEpoch,
  branchBusinessDay,
  createDayCloseFixture,
  daysBefore,
  DayCloseFixture,
} from './day-close-fixtures';

/**
 * DayClose x Order-create — the CUTOVER RACE (DAYCLOSE ACCEPTANCE COMPLETION
 * task §5, non-negotiable). Proves the invariant the shared
 * `ros_order_number(branchId, businessDay)` advisory-lock fence exists for:
 * it must be IMPOSSIBLE to end with a committed `DayClose(D)` followed by a
 * later-committed `Order(businessDay=D)`.
 *
 * Both code paths are called DIRECTLY through their services (never HTTP) —
 * the same choice `order-completion-concurrency.e2e-spec.ts` makes for its
 * own real-Postgres races — so the race is exactly at the two services'
 * shared advisory-lock fence, not diluted by the idempotency
 * interceptor/permission guards (already proven independently by
 * `day-close.e2e-spec.ts` and the existing Sales e2e suites).
 *
 * No sleeps anywhere in this file. Test A is a REAL, unforced concurrent
 * race — the two transactions are started together with no artificial
 * barrier, and Postgres's own `pg_advisory_xact_lock` is the
 * synchronisation primitive under test, run 3 times for clean-run evidence.
 * Tests B/C deterministically force each of the two possible lock orderings
 * (there is no third) by running the two calls sequentially, proving the
 * invariant holds structurally for both, not just probabilistically.
 */
describe('DayClose x Order-create — cutover race (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let dayClose: DayCloseService;
  let packs: CountryPackService;

  const RELEASE_KEY = generateReleaseKey('e2e-cutover-race-release-key');
  const TRUST = trustStoreFor(RELEASE_KEY.trusted());
  const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);
  const testPackDocument = () =>
    signPackDocument(
      {
        code: 'EG',
        version: '2026.1',
        effectiveFrom: '2026-01-01',
        currency: {
          code: 'EGP',
          exponent: 2,
          cashRounding: { enabled: false },
        },
        tax: {
          engine: 'vat_standard',
          pricingMode: 'tax_exclusive',
          computationLevel: 'line',
          roundingMode: 'HALF_UP',
          roundingPrecision: 2,
          classes: [
            { code: 'standard', rate: '14.0', label: { en: 'Standard' } },
          ],
          serviceChargeTaxable: true,
          orderTypeOverrides: [],
        },
      },
      RELEASE_KEY,
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    orders = app.get(OrdersService);
    dayClose = app.get(DayCloseService);
    packs = app.get(CountryPackService);
    await packs.activate(testPackDocument());
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let seedN = 0;
  const seed = () => `${stamp}${(seedN++).toString(36)}`;
  let orderSeq = 0;

  async function mkFx(): Promise<{ fx: DayCloseFixture; target: Date }> {
    const fx = await createDayCloseFixture(app, admin, seed());
    const activationBusinessDay = daysBefore(branchBusinessDay(new Date()), 5);
    await activatePastEpoch(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      activatedByUserId: fx.employeeUserId,
      activationBusinessDay,
    });
    const target = daysBefore(activationBusinessDay, -1); // A+1, eligible
    return { fx, target };
  }

  function createOrder(fx: DayCloseFixture, target: Date) {
    orderSeq += 1;
    return orders.create(fx.tenantId, fx.employeeUserId, {
      id: newId(),
      terminalId: fx.terminalId,
      openedByEmployeeId: fx.employeeId,
      orderType: 'dine_in',
      channel: 'pos',
      originDeviceTime: target,
      idempotencyKey: `cutover-race-${seed()}-${orderSeq}`,
      at: target, // pins the resolved businessDay to the target eligible day
    });
  }

  function closeDayClose(fx: DayCloseFixture, target: Date) {
    return dayClose.post(
      fx.tenantId,
      fx.employeeUserId,
      { employeeId: fx.employeeId, terminalId: fx.terminalId },
      dayCloseAuthorization(fx),
      { branchId: fx.branchId, businessDay: target },
    );
  }

  // =============================================================== TEST A ===
  for (let run = 1; run <= 3; run++) {
    it(`run ${run}/3: REAL concurrent race — whichever side wins the shared fence, the invariant holds`, async () => {
      const { fx, target } = await mkFx();

      // Genuinely concurrent — no barrier. Both call the SAME advisory-lock
      // key `hashtext('ros_order_number')/hashtext('${branchId}:${target}')`
      // (verified equal on both sides by source review — see the
      // acceptance-completion report §3); Postgres decides the winner.
      const [orderResult, closeResult] = await Promise.allSettled([
        createOrder(fx, target),
        closeDayClose(fx, target),
      ]);

      const orderSucceeded = orderResult.status === 'fulfilled';
      const closeSucceeded =
        closeResult.status === 'fulfilled' &&
        closeResult.value.outcome === 'CLOSED';

      // THE required invariant: never both.
      expect(orderSucceeded && closeSucceeded).toBe(false);

      if (orderSucceeded) {
        // Order won the fence first: DayClose (whenever it ran) must have
        // been blocked BY that order — never silently closed past it.
        expect(closeSucceeded).toBe(false);
        if (closeResult.status === 'rejected') {
          const err = closeResult.reason as { status?: number };
          expect(err.status).toBe(409);
        }
        const persistedOrder = await admin.order.findFirstOrThrow({
          where: {
            id: (orderResult as PromiseFulfilledResult<{ id: string }>).value
              .id,
          },
        });
        expect(persistedOrder.businessDay.toISOString().slice(0, 10)).toBe(
          target.toISOString().slice(0, 10),
        );
        const dc = await admin.dayClose.findFirst({
          where: {
            tenantId: fx.tenantId,
            branchId: fx.branchId,
            businessDay: target,
          },
        });
        expect(dc).toBeNull();
      } else {
        // DayClose won: the order attempt MUST have been refused because
        // the day is closed — never silently created into a sealed day.
        expect(closeSucceeded).toBe(true);
        expect(orderResult.status).toBe('rejected');
        if (orderResult.status === 'rejected') {
          const err = orderResult.reason as {
            status?: number;
            message?: string;
          };
          expect(err.status).toBe(409);
        }
        const orderCount = await admin.order.count({
          where: {
            tenantId: fx.tenantId,
            branchId: fx.branchId,
            businessDay: target,
          },
        });
        expect(orderCount).toBe(0);
      }
    });
  }

  // =============================================================== TEST B ===
  it('deterministic ordering — Order commits FIRST: DayClose is blocked by it, never seals past it', async () => {
    const { fx, target } = await mkFx();
    const order = await createOrder(fx, target);
    expect(order.state).toBe('draft'); // an OPEN state (Sales' own OPEN_ORDER_STATES)

    await expect(closeDayClose(fx, target)).rejects.toMatchObject({
      status: 409,
    });
    const dc = await admin.dayClose.findFirst({
      where: {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        businessDay: target,
      },
    });
    expect(dc).toBeNull();
  });

  // =============================================================== TEST C ===
  it('deterministic ordering — DayClose commits FIRST: a later order for that day is refused, never silently landed in a sealed day', async () => {
    const { fx, target } = await mkFx();
    const closed = await closeDayClose(fx, target);
    expect(closed.outcome).toBe('CLOSED');

    await expect(createOrder(fx, target)).rejects.toMatchObject({
      status: 409,
    });
    const orderCount = await admin.order.count({
      where: {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        businessDay: target,
      },
    });
    expect(orderCount).toBe(0);
  });
});
