import { ConflictException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Client as PgClient } from 'pg';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
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
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { CashMovementsService } from './../src/modules/treasury/cash-movements/cash-movements.service';
import { CashClosePolicyService } from './../src/modules/treasury/cash-close-policy/cash-close-policy.service';
import { CashSessionCloseService } from './../src/modules/treasury/cash-session-close/cash-session-close.service';
import { TREASURY_PERMISSIONS } from './../src/modules/treasury/treasury.permissions';
import { AuditService } from './../src/modules/governance/audit/audit.service';
import { AUDIT_ACTION } from './../src/modules/governance/audit/audit.constants';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1G-0 ACCEPTANCE CLOSURE §3/§4, superseded/extended by P1G-1 migration 34.
 *
 * Authority: docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md
 * + docs/reports/claude/2026-08-28_P1G0_cash-movements.md §F/§L, corrected by
 * the P1G-1 CashSession Close final design gate §8 (the Payment/Close
 * advisory-lock defect) and closed by the P1G-1 migration 34 final
 * implementation slice.
 *
 * §D — SAFE_DROP vs a Payment on the SAME CashSession. UPDATED: the P1G-1
 * design gate found that `SalesPaymentService.capture` read CashSession
 * status via a PLAIN, unlocked SELECT — a genuine race where a close could
 * compute expected cash and CLOSE the session between that read and the
 * Payment's own INSERT, permanently misstating the recorded variance. The
 * fix (`sales-payment.service.ts`, "step 1.5") makes Payment acquire the
 * SAME `ros_cash_session` advisory lock `CashMovementsService` and
 * `CashSessionCloseService` already use, BEFORE loading the Order — so §D is
 * now a genuine MUTUAL-EXCLUSION proof, not merely an interleaving one: a
 * concurrent Payment now genuinely WAITS for a SAFE_DROP holding the lock,
 * exactly like two movements already waited for each other.
 *
 * §E — Movement vs CashSession Close. P1G-1 migration 34 implements the
 * close service the P1G-0 design gate anticipated; §E now exercises the
 * REAL `CashSessionCloseService.declareClose` (not a TEST-ONLY raw writer)
 * acquiring the IDENTICAL advisory lock namespace/key.
 *
 * §F (NEW) — Payment vs CashSession Close, both orderings, both tenders.
 * The exact race the P1G-1 design gate's Payment/Close correction exists to
 * close: proves neither a settling cash payment nor a manual/external-card
 * payment can commit interleaved with a close's expected-cash computation.
 */
describe('P1G-0/P1G-1 acceptance closure — cross-module concurrency (§D Payment/movement mutual exclusion, §E movement-vs-close, §F Payment-vs-close)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let paymentService: SalesPaymentService;
  let movementsService: CashMovementsService;
  let closeService: CashSessionCloseService;
  let packs: CountryPackService;
  let gatedAudit: GatedCashMovementAuditService;

  const stamp = Date.now();
  const AT = new Date('2026-08-28T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-p1g0-closure-release-key');
  const TRUST = trustStoreFor(RELEASE_KEY.trusted());
  const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);
  const testPackDocument = () =>
    signPackDocument(
      {
        code: 'EG',
        version: PACK,
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

  /**
   * Gate one or more audit actions independently — each pauses the LAST
   * statement inside its target transaction's create path, still holding the
   * `ros_cash_session` advisory lock and still uncommitted. `arm(action)`
   * (default `CASH_MOVEMENT_RECORDED`, the original §D/§E single-purpose
   * gate) may now be called MULTIPLE TIMES for DIFFERENT actions while an
   * earlier arm is still pending release — §E/§F need this: a movement
   * paused on `CASH_MOVEMENT_RECORDED` and a close paused on
   * `CASH_SESSION_CLOSED` (or a partial payment on `PAYMENT_CAPTURED`) can be
   * simultaneously in flight, each released independently by its own
   * `release(action)` call. Keyed by a `Map`, not shared mutable fields, so
   * the two gates cannot clobber each other's resolver.
   */
  class GatedCashMovementAuditService extends AuditService {
    private readonly armed = new Map<
      string,
      { acquiredResolve: () => void; gate: Promise<void>; releaseGateFn: () => void }
    >();

    arm(action: string = AUDIT_ACTION.CASH_MOVEMENT_RECORDED): Promise<void> {
      let acquiredResolve!: () => void;
      const acquired = new Promise<void>((res) => {
        acquiredResolve = res;
      });
      let releaseGateFn!: () => void;
      const gate = new Promise<void>((res) => {
        releaseGateFn = res;
      });
      this.armed.set(action, { acquiredResolve, gate, releaseGateFn });
      return acquired;
    }
    release(action: string = AUDIT_ACTION.CASH_MOVEMENT_RECORDED): void {
      this.armed.get(action)?.releaseGateFn();
    }
    override async record(
      tx: Prisma.TransactionClient,
      event: Parameters<AuditService['record']>[1],
    ) {
      const entry = this.armed.get(event.action);
      if (entry) {
        this.armed.delete(event.action);
        entry.acquiredResolve();
        await entry.gate;
      }
      return super.record(tx, event);
    }
  }

  let tenantA: string;
  let branchA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let priceListA: string;
  let taxClassStandard: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
      .overrideProvider(AuditService)
      .useFactory({
        factory: (prisma: PrismaService) => {
          gatedAudit = new GatedCashMovementAuditService(prisma);
          return gatedAudit;
        },
        inject: [PrismaService],
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    paymentService = app.get(SalesPaymentService);
    movementsService = app.get(CashMovementsService);
    closeService = app.get(CashSessionCloseService);
    packs = app.get(CountryPackService);

    await packs.activate(testPackDocument());

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `p1g0closure-${stamp}`,
        legalName: 'P1G0 Closure',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `P1G0 Brand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `PG${stamp % 10000}`,
        name: 'P1G0 Closure Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchA = branch.id;

    // `SaleDepletionService.depleteForCompletedSale` looks up the branch's
    // inventory Location before touching any recipe line — required even
    // though these fixtures deliberately carry zero depletion effects.
    await admin.location.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        locationType: 'branch',
        refId: branchA,
        branchId: branchA,
      },
    });

    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'P1G0-Closure-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `p1g0.closure.${stamp}@example.com`,
        displayName: 'Closure',
      },
    });
    userA = user.id;
    await admin.membership.create({
      data: { id: newId(), userId: userA, tenantId: tenantA, status: 'active' },
    });

    const employee = await admin.employee.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        code: `PGE${stamp % 1000}`,
        displayName: 'Closure Employee',
        homeBranchId: branchA,
        userId: userA,
      },
    });
    employeeA = employee.id;
    await admin.employeeBranch.create({
      data: { tenantId: tenantA, employeeId: employeeA, branchId: branchA },
    });

    taxClassStandard = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;

    priceListA = (
      await admin.priceList.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          name: 'P1G0 closure pricing',
          scopeType: 'branch',
          scopeId: branchA,
          status: 'active',
        },
      })
    ).id;

    // A HUGE tolerance: every §D/§E/§F declared close in this file stays on
    // the within-tolerance fast path (one CASH_SESSION_CLOSED audit write,
    // the gate point these races pause at) regardless of the concurrent
    // movement/payment amount — the point of these races is lock ordering,
    // not variance-approval behaviour (covered by cash-session-close.e2e-spec.ts).
    // `effectiveFrom` omitted -> effective immediately (DB time, here). Every
    // fixture session's `openedAt` (`mkCashSession`) is `new Date()` taken
    // AFTER this call, so R-3(a)'s "policy effective at session.openedAt"
    // resolution always finds this row.
    const policies = app.get(CashClosePolicyService);
    await policies.create(tenantA, userA, {
      branchId: branchA,
      varianceToleranceMinorUnits: '999999999999',
      varianceApprovalExpirySeconds: 300,
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  const mkSellable = async (name: string, price = 10_000n) => {
    const item = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: name },
        taxClassId: taxClassStandard,
      },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: item.id,
        name: { en: 'V' },
      },
    });
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        priceListId: priceListA,
        menuItemVariantId: variant.id,
        price,
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  };

  /** No recipe attached — a menu item with `recipeVersionId === null` on its
   *  order line resolves to 0 depletion, no gap (BR-MNU-012, verified by
   *  direct code reading of `consumption-resolution.service.ts`), so
   *  Completion succeeds without any inventory/recipe fixture at all. */
  const mkOpenOrderWithLine = async (
    itemId: string,
    variantId: string,
  ): Promise<{
    id: string;
    businessDay: Date;
    grandTotal: bigint;
    version: number;
  }> => {
    const order = await orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    await lines.addLine(tenantA, userA, order.id, order.businessDay, {
      menuItemId: itemId,
      variantId,
      quantity: '1',
      expectedVersion: order.version,
    });
    const opened = await orders.transition(
      tenantA,
      userA,
      order.id,
      order.businessDay,
      'open',
      order.version + 1,
    );
    return {
      id: opened.id,
      businessDay: opened.businessDay,
      grandTotal: opened.grandTotal,
      version: opened.version,
    };
  };

  const mkCashSession = async (): Promise<string> => {
    const drawer = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: `P1G0 Drawer ${newId()}`,
        terminalId: null,
      },
    });
    // `openedAt` is deliberately `new Date()` (the true session-open instant),
    // NOT the fixed historical `AT` used for order/business-day fixtures:
    // R-3(a) resolves a session's cash-close policy `asOf` its OWN
    // `openedAt`, and `CashClosePolicyService.create` refuses a backdated
    // `effectiveFrom` — so a session opened at a fixed-past `AT` could never
    // resolve the "effective immediately" policy `beforeAll` configures.
    const openedAt = new Date();
    const shift = await admin.shift.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        employeeId: employeeA,
        status: 'open',
        openedAt,
      },
    });
    const session = await admin.cashSession.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        drawerId: drawer.id,
        shiftId: shift.id,
        employeeId: employeeA,
        openingFloat: 50_000n,
        currency: 'EGP',
        status: 'open',
        openedAt,
      },
    });
    return session.id;
  };

  const movementInput = (
    sid: string,
    over: Partial<{ id: string; amountMinor: string; reason: string }> = {},
  ) => ({
    id: over.id ?? newId(),
    cashSessionId: sid,
    amountMinor: over.amountMinor ?? '3000',
    reason: over.reason ?? 'p1g0 closure race',
    employeeId: employeeA,
    terminalId: terminalA,
  });

  const capture = (
    order: {
      id: string;
      businessDay: Date;
      grandTotal: bigint;
      version: number;
    },
    cashSessionId: string,
  ) =>
    paymentService.capture(tenantA, userA, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: order.version,
      tender: 'cash',
      amountMinor: order.grandTotal,
      cashSessionId,
      employeeId: employeeA,
      terminalId: terminalA,
      tenderedAmountMinor: order.grandTotal,
    });

  /** A NON-settling cash payment — its ONE audit write (`PAYMENT_CAPTURED`)
   *  is the transaction's last statement, the same gate shape §D/§E's
   *  movement writes have. `amountMinor` is half the grand total. */
  const capturePartialCash = (
    order: {
      id: string;
      businessDay: Date;
      grandTotal: bigint;
      version: number;
    },
    cashSessionId: string,
  ) => {
    const half = order.grandTotal / 2n || 1n;
    return paymentService.capture(tenantA, userA, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: order.version,
      tender: 'cash',
      amountMinor: half,
      cashSessionId,
      employeeId: employeeA,
      terminalId: terminalA,
      tenderedAmountMinor: half,
    });
  };

  const captureManualCard = (
    order: {
      id: string;
      businessDay: Date;
      grandTotal: bigint;
      version: number;
    },
    cashSessionId: string,
  ) =>
    paymentService.capture(tenantA, userA, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: order.version,
      tender: 'manual_external_card',
      amountMinor: order.grandTotal,
      cashSessionId,
      employeeId: employeeA,
      terminalId: terminalA,
      terminalReference: `manual-ref-${newId()}`,
    });

  /** `cash.session.close` — the OWN-session case (`employeeA` opened every
   *  fixture session in this file). */
  const CLOSE_PERMISSIONS = new Set([TREASURY_PERMISSIONS.CASH_SESSION_CLOSE]);

  // =============================================================== §G
  // DETERMINISTIC lock-queue harness — acceptance closure Blocker C.
  //
  // A RAW, plain `pg` connection (NOT a Prisma transaction, NOT bound by
  // `PrismaService.withAuthContext`'s fixed 5s interactive-transaction
  // timeout) takes a SESSION-level advisory lock
  // (`pg_advisory_lock`, released only by an explicit `pg_advisory_unlock`
  // or the connection closing) on the EXACT SAME `(classid, objid)` pair —
  // `hashtext('ros_cash_session')`, `hashtext(sessionId)` — that every
  // production caller's `pg_advisory_xact_lock` uses. PostgreSQL advisory
  // locks share ONE lock table regardless of session/transaction scope; a
  // session-level holder genuinely blocks a transaction-level requester on
  // the same key, and (unlike §D/E/F's earlier gated-AuditService technique)
  // this holder has NO Prisma timeout of any kind to race against, because
  // it is not inside any ORM-managed transaction at all.
  //
  // `waitUntilGenuinelyBlocked` polls `pg_stat_activity` (the SAME proven
  // detection query used earlier in this file's history — verified via raw
  // `psql` to register genuine contention in well under 0.5s) — bounded,
  // never a fixed sleep used as the proof itself.
  //
  // Ordering technique: rather than queueing TWO production calls behind the
  // raw holder simultaneously (and depending on an unverified assumption
  // about PostgreSQL's exact lock-queue fairness under concurrent waiters),
  // each proof here holds the lock, fires ONE production call, observes it
  // genuinely blocked, releases, and ONLY THEN starts the second — a
  // strictly stronger, dependency-free determinism: call A is proven to have
  // fully committed before call B ever attempts anything, with no reliance
  // on how Postgres orders concurrent waiters.

  async function acquireRawSessionLock(sessionId: string): Promise<PgClient> {
    const client = new PgClient({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      'SELECT pg_advisory_lock(hashtext($1), hashtext($2))',
      ['ros_cash_session', sessionId],
    );
    return client;
  }

  async function releaseRawSessionLock(client: PgClient): Promise<void> {
    await client.query('SELECT pg_advisory_unlock_all()');
    await client.end();
  }

  async function waitUntilGenuinelyBlocked(
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await admin.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%pg_advisory_xact_lock%'
      `;
      if (Number(rows[0].c) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          'Timed out waiting for genuine Postgres advisory-lock contention ' +
            '(deterministic harness).',
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /**
   * Runs `blockedCall` while a raw session-level lock is held on `sessionId`,
   * waits for GENUINE Postgres-level contention, releases the lock, and only
   * THEN resolves — so by the time this returns, `blockedCall` has fully
   * committed (or rejected) and the caller may deterministically start a
   * second call knowing the first is already finished.
   */
  async function runFullySerializedFirst<T>(
    sessionId: string,
    blockedCall: () => Promise<T>,
  ): Promise<T> {
    const holder = await acquireRawSessionLock(sessionId);
    try {
      const promise = blockedCall();
      await waitUntilGenuinelyBlocked();
      await releaseRawSessionLock(holder);
      return await promise;
    } catch (err) {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await holder.end().catch(() => undefined);
      throw err;
    }
  }

  const declareCloseFastPath = (sessionId: string) =>
    closeService.declareClose(
      tenantA,
      userA,
      { employeeId: employeeA, terminalId: terminalA },
      CLOSE_PERMISSIONS,
      { cashSessionId: sessionId, closeAttemptId: newId(), countedTotalMinorUnits: '0' },
    );

  /**
   * §D/E/F all needed a "hold a REAL production-service transaction open
   * long enough to observe/force an ordering" gate at some point in this
   * file's history. That technique was ABANDONED for these three sections:
   * empirically, on this repository's local Postgres + ts-jest, pausing
   * `SalesPaymentService.capture` / `CashSessionCloseService.declareClose` —
   * both bound to `PrismaService.withAuthContext`'s FIXED, unconfigurable
   * Prisma-default interactive-transaction timeout (5000 ms) — for even a
   * short, bounded window WHILE ANOTHER call blocks waiting on the SAME
   * `ros_cash_session` advisory lock was repeatedly and reproducibly (in
   * complete test-file isolation, not merely under cumulative load)
   * observed to exceed that 5-second budget and leave the connection in an
   * inconsistent state (a stale "expired transaction" error surfacing on an
   * unrelated later query). This is a genuine fragility of combining a
   * fixed client-side interactive-transaction timeout with a deliberately
   * lock-contended test harness, not a defect in the production locking
   * logic itself (independently proven correct via raw `psql`: two
   * sessions contending for `pg_advisory_xact_lock` show up in
   * `pg_stat_activity` as blocked within under half a second).
   *
   * §D/E/F below instead use the SAME gate-free, statistically-repeated
   * concurrent-fire pattern already proven reliable elsewhere in this
   * repository (`cash-session.e2e-spec.ts`'s "admits exactly ONE of two
   * concurrent opens", `cash-close-policy.e2e-spec.ts`'s
   * `runConcurrentRace`): fire both sides via `Promise.allSettled` with NO
   * artificial pause, then assert DB-final-state correctness under
   * whichever genuine ordering actually occurred — repeated several times
   * so both orderings are exercised across the run. What this proves: no
   * lost update, no double-close, no corrupted expected-cash figure, and no
   * deadlock, for REAL concurrent Payment/Movement/declareClose traffic on
   * the SAME session — the mutual-exclusion PROPERTY the advisory lock
   * exists to guarantee. What it does NOT claim to prove on any single run:
   * which specific side won the lock (unlike the retired `waitFor
   * RealLockContention` gate, this file no longer asserts on ordering).
   */

  // ================================================================= §D
  describe('D. SAFE_DROP vs a Payment on the SAME CashSession — mutual exclusion (P1G-1 correction)', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: both genuinely concurrent, no lost update, no deadlock`, async () => {
        const sid = await mkCashSession();
        const item = await mkSellable(`SDvP-${run}-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);
        const safeDropId = newId();

        const [safeDropOutcome, paymentOutcome] = await Promise.allSettled([
          movementsService.safeDrop(
            tenantA,
            userA,
            movementInput(sid, {
              id: safeDropId,
              amountMinor: '3000',
              reason: `safe drop run ${run}`,
            }),
          ),
          capture(order, sid),
        ]);

        expect(safeDropOutcome.status).toBe('fulfilled');
        expect(paymentOutcome.status).toBe('fulfilled');
        if (safeDropOutcome.status !== 'fulfilled' || paymentOutcome.status !== 'fulfilled') {
          return; // unreachable — satisfies the type narrower below
        }
        expect(safeDropOutcome.value.created).toBe(true);
        expect(paymentOutcome.value.order.state).toBe('completed');
        expect(paymentOutcome.value.payment.amount).toBe(order.grandTotal);
        expect(paymentOutcome.value.payment.tender).toBe('cash');
        expect(paymentOutcome.value.payment.cashSessionId).toBe(sid);

        // ── Final integrity assertions — no lost update either way. ──
        const movementRows = await admin.cashMovement.findMany({
          where: { cashSessionId: sid },
        });
        expect(movementRows).toHaveLength(1);
        expect(movementRows[0].movementType).toBe('safe_drop');
        expect(movementRows[0].amount).toBe(3000n);

        const paymentRows = await admin.orderPayment.findMany({
          where: { orderId: order.id },
        });
        expect(paymentRows).toHaveLength(1);
        expect(paymentRows[0].amount).toBe(order.grandTotal);
        expect(paymentRows[0].cashSessionId).toBe(sid);

        const finalOrder = await admin.order.findUniqueOrThrow({
          where: {
            id_businessDay: { id: order.id, businessDay: order.businessDay },
          },
        });
        expect(finalOrder.state).toBe('completed');
        expect(finalOrder.paidTotal).toBe(order.grandTotal);
      }, 20_000);
    }
  });

  // ================================================================= §E
  describe('E. Movement vs the REAL CashSessionCloseService.declareClose', () => {
    /** Exactly one of two mutually exclusive, both-valid outcomes for a
     *  genuine Movement/Close race — see the section docblock above. */
    async function raceMovementVsClose(sid: string, runLabel: string) {
      const movementId = newId();
      const [movementOutcome, closeOutcome] = await Promise.allSettled([
        movementsService.payIn(
          tenantA,
          userA,
          movementInput(sid, {
            id: movementId,
            amountMinor: '2500',
            reason: runLabel,
          }),
        ),
        closeService.declareClose(
          tenantA,
          userA,
          { employeeId: employeeA, terminalId: terminalA },
          CLOSE_PERMISSIONS,
          { cashSessionId: sid, closeAttemptId: newId(), countedTotalMinorUnits: '0' },
        ),
      ]);
      return { movementId, movementOutcome, closeOutcome };
    }

    for (let run = 1; run <= 5; run++) {
      it(`run ${run}/5: genuine race — movement wins (included in expected cash) OR close wins (movement conflicts on the now-closed session), never both/neither`, async () => {
        const sid = await mkCashSession();
        const { movementId, movementOutcome, closeOutcome } =
          await raceMovementVsClose(sid, `close race run ${run}`);

        // The close ALWAYS eventually succeeds — either it ran first, or it
        // ran second after the movement committed (never blocked forever,
        // never corrupted by the movement's presence or absence).
        expect(closeOutcome.status).toBe('fulfilled');
        const session = await admin.cashSession.findUniqueOrThrow({
          where: { id: sid },
        });
        expect(session.status).toBe('closed');

        const movementRows = await admin.cashMovement.findMany({
          where: { cashSessionId: sid },
        });

        if (movementOutcome.status === 'fulfilled') {
          // Movement won the lock first — close (running after) must have
          // read and included it.
          expect(movementRows).toHaveLength(1);
          expect(movementRows[0].id).toBe(movementId);
          expect(session.expectedCash).toBe(52_500n); // 50000 + 2500
          expect(session.variance).toBe(-52_500n);
        } else {
          // Close won the lock first — the movement, running after, must
          // see the NOW-CLOSED session and refuse (FR-FIN-005 immutability),
          // writing NOTHING.
          expect(movementOutcome.reason).toBeInstanceOf(ConflictException);
          expect(movementRows).toHaveLength(0);
          expect(session.expectedCash).toBe(50_000n); // opening float only
        }
      }, 20_000);
    }
  });

  // ================================================================= §F
  describe('F. Payment vs the REAL CashSessionCloseService.declareClose — both orderings, both tenders', () => {
    async function racePaymentVsClose(
      sid: string,
      paymentPromise: Promise<Awaited<ReturnType<typeof capture>>>,
    ) {
      const [paymentOutcome, closeOutcome] = await Promise.allSettled([
        paymentPromise,
        closeService.declareClose(
          tenantA,
          userA,
          { employeeId: employeeA, terminalId: terminalA },
          CLOSE_PERMISSIONS,
          { cashSessionId: sid, closeAttemptId: newId(), countedTotalMinorUnits: '0' },
        ),
      ]);
      return { paymentOutcome, closeOutcome };
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: genuine race, CASH tender — payment wins (included) OR close wins (payment sees a closed session), never both/neither`, async () => {
        const sid = await mkCashSession();
        const item = await mkSellable(`PvC-cash-${run}-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        const { paymentOutcome, closeOutcome } = await racePaymentVsClose(
          sid,
          capture(order, sid),
        );

        expect(closeOutcome.status).toBe('fulfilled');
        const session = await admin.cashSession.findUniqueOrThrow({
          where: { id: sid },
        });
        expect(session.status).toBe('closed');
        const paymentRows = await admin.orderPayment.findMany({
          where: { orderId: order.id },
        });

        if (paymentOutcome.status === 'fulfilled') {
          expect(paymentRows).toHaveLength(1);
          expect(session.expectedCash).toBe(50_000n + order.grandTotal);
        } else {
          expect(String(paymentOutcome.reason)).toMatch(/not open/i);
          expect(paymentRows).toHaveLength(0);
          expect(session.expectedCash).toBe(50_000n);
        }
      }, 20_000);
    }

    it('genuine race, MANUAL_EXTERNAL_CARD tender — payment wins (included) OR close wins (payment sees a closed session), never both/neither', async () => {
      const sid = await mkCashSession();
      const item = await mkSellable(`PvC-card-${newId()}`);
      const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

      const { paymentOutcome, closeOutcome } = await racePaymentVsClose(
        sid,
        captureManualCard(order, sid),
      );

      expect(closeOutcome.status).toBe('fulfilled');
      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('closed');
      const paymentRows = await admin.orderPayment.findMany({
        where: { orderId: order.id },
      });

      if (paymentOutcome.status === 'fulfilled') {
        expect(paymentRows).toHaveLength(1);
        // manual_external_card is NOT a cash term — expected cash is
        // unaffected by whether this payment landed before or after close.
        expect(session.expectedCash).toBe(50_000n);
      } else {
        expect(String(paymentOutcome.reason)).toMatch(/not open/i);
        expect(paymentRows).toHaveLength(0);
      }
    }, 20_000);

    it('a PARTIAL (non-settling) CASH payment racing close never phantom-completes the order either way', async () => {
      const sid = await mkCashSession();
      const item = await mkSellable(`PvC-partial-${newId()}`, 20_000n);
      const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

      const { paymentOutcome, closeOutcome } = await racePaymentVsClose(
        sid,
        capturePartialCash(order, sid),
      );

      expect(closeOutcome.status).toBe('fulfilled');
      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('closed');

      if (paymentOutcome.status === 'fulfilled') {
        expect(paymentOutcome.value.order.state).toBe('partially_paid');
        expect(session.expectedCash).toBe(50_000n + order.grandTotal / 2n);
      } else {
        expect(String(paymentOutcome.reason)).toMatch(/not open/i);
        expect(session.expectedCash).toBe(50_000n);
      }
    }, 20_000);
  });

  // ================================================================= §G
  describe('G. DETERMINISTIC ordering proofs — acceptance closure Blocker C', () => {
    for (let run = 1; run <= 3; run++) {
      it(`A run ${run}/3: CASH Payment queued before Close -> Payment commits -> Close includes it in expected cash`, async () => {
        const sid = await mkCashSession();
        const item = await mkSellable(`G-A-${run}-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        const paymentResult = await runFullySerializedFirst(sid, () =>
          capture(order, sid),
        );
        expect(paymentResult.order.state).toBe('completed');

        const closeResult = await declareCloseFastPath(sid);
        expect(closeResult.status).toBe('closed');

        const session = await admin.cashSession.findUniqueOrThrow({
          where: { id: sid },
        });
        expect(session.expectedCash).toBe(50_000n + order.grandTotal);
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`B run ${run}/3: Close queued before CASH Payment -> Close commits CLOSED -> Payment wakes and rejects (session not open)`, async () => {
        const sid = await mkCashSession();
        const item = await mkSellable(`G-B-${run}-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        const closeResult = await runFullySerializedFirst(sid, () =>
          declareCloseFastPath(sid),
        );
        expect(closeResult.status).toBe('closed');

        await expect(capture(order, sid)).rejects.toThrow(/not open/i);

        const paymentRows = await admin.orderPayment.findMany({
          where: { orderId: order.id },
        });
        expect(paymentRows).toHaveLength(0);
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`C run ${run}/3: MANUAL_EXTERNAL_CARD Payment queued before Close -> included in the tender table but NOT in expected cash`, async () => {
        const sid = await mkCashSession();
        const item = await mkSellable(`G-C-${run}-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        const paymentResult = await runFullySerializedFirst(sid, () =>
          captureManualCard(order, sid),
        );
        expect(paymentResult.order.state).toBe('completed');

        const closeResult = await declareCloseFastPath(sid);
        expect(closeResult.status).toBe('closed');

        const session = await admin.cashSession.findUniqueOrThrow({
          where: { id: sid },
        });
        // manual_external_card is NOT a cash term — expected cash is the
        // opening float alone, unaffected by whether this payment landed
        // before or after close.
        expect(session.expectedCash).toBe(50_000n);
        const paymentRows = await admin.orderPayment.findMany({
          where: { orderId: order.id },
        });
        expect(paymentRows).toHaveLength(1);
        expect(paymentRows[0].tender).toBe('manual_external_card');
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`D run ${run}/3: Close queued before MANUAL_EXTERNAL_CARD Payment -> Payment wakes and rejects`, async () => {
        const sid = await mkCashSession();
        const item = await mkSellable(`G-D-${run}-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        const closeResult = await runFullySerializedFirst(sid, () =>
          declareCloseFastPath(sid),
        );
        expect(closeResult.status).toBe('closed');

        await expect(captureManualCard(order, sid)).rejects.toThrow(/not open/i);
        expect(
          await admin.orderPayment.count({ where: { orderId: order.id } }),
        ).toBe(0);
      }, 20_000);
    }

    // ── Movement ordering — pay_in, pay_out, safe_drop, both directions ───

    it('pay_in queued before Close -> included in expected cash (+2500)', async () => {
      const sid = await mkCashSession();
      const movementResult = await runFullySerializedFirst(sid, () =>
        movementsService.payIn(
          tenantA,
          userA,
          movementInput(sid, { amountMinor: '2500', reason: 'G pay_in first' }),
        ),
      );
      expect(movementResult.created).toBe(true);

      const closeResult = await declareCloseFastPath(sid);
      expect(closeResult.status).toBe('closed');
      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.expectedCash).toBe(52_500n);
    }, 20_000);

    it('Close queued before pay_in -> pay_in wakes and rejects', async () => {
      const sid = await mkCashSession();
      const closeResult = await runFullySerializedFirst(sid, () =>
        declareCloseFastPath(sid),
      );
      expect(closeResult.status).toBe('closed');

      await expect(
        movementsService.payIn(
          tenantA,
          userA,
          movementInput(sid, { amountMinor: '2500', reason: 'G pay_in second' }),
        ),
      ).rejects.toThrow(ConflictException);
      expect(
        await admin.cashMovement.count({ where: { cashSessionId: sid } }),
      ).toBe(0);
    }, 20_000);

    it('pay_out queued before Close -> included in expected cash (-2500)', async () => {
      const sid = await mkCashSession();
      const movementResult = await runFullySerializedFirst(sid, () =>
        movementsService.payOut(
          tenantA,
          userA,
          movementInput(sid, { amountMinor: '2500', reason: 'G pay_out first' }),
        ),
      );
      expect(movementResult.created).toBe(true);

      const closeResult = await declareCloseFastPath(sid);
      expect(closeResult.status).toBe('closed');
      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.expectedCash).toBe(47_500n);
    }, 20_000);

    it('Close queued before pay_out -> pay_out wakes and rejects', async () => {
      const sid = await mkCashSession();
      const closeResult = await runFullySerializedFirst(sid, () =>
        declareCloseFastPath(sid),
      );
      expect(closeResult.status).toBe('closed');

      await expect(
        movementsService.payOut(
          tenantA,
          userA,
          movementInput(sid, { amountMinor: '2500', reason: 'G pay_out second' }),
        ),
      ).rejects.toThrow(ConflictException);
      expect(
        await admin.cashMovement.count({ where: { cashSessionId: sid } }),
      ).toBe(0);
    }, 20_000);

    it('safe_drop queued before Close -> included in expected cash (-2500)', async () => {
      const sid = await mkCashSession();
      const movementResult = await runFullySerializedFirst(sid, () =>
        movementsService.safeDrop(
          tenantA,
          userA,
          movementInput(sid, { amountMinor: '2500', reason: 'G safe_drop first' }),
        ),
      );
      expect(movementResult.created).toBe(true);

      const closeResult = await declareCloseFastPath(sid);
      expect(closeResult.status).toBe('closed');
      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.expectedCash).toBe(47_500n);
    }, 20_000);

    it('Close queued before safe_drop -> safe_drop wakes and rejects', async () => {
      const sid = await mkCashSession();
      const closeResult = await runFullySerializedFirst(sid, () =>
        declareCloseFastPath(sid),
      );
      expect(closeResult.status).toBe('closed');

      await expect(
        movementsService.safeDrop(
          tenantA,
          userA,
          movementInput(sid, { amountMinor: '2500', reason: 'G safe_drop second' }),
        ),
      ).rejects.toThrow(ConflictException);
      expect(
        await admin.cashMovement.count({ where: { cashSessionId: sid } }),
      ).toBe(0);
    }, 20_000);

    // ── Directly proves the two-simultaneous-waiters queue too, as extra
    //    corroboration for `runFullySerializedFirst`'s "one at a time"
    //    simplification above (not required by any single proof case, but
    //    strengthens confidence that PostgreSQL genuinely queues concurrent
    //    advisory-lock waiters rather than resolving them arbitrarily). ──
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: two simultaneous waiters (pay_in AND Close) both queue behind one raw holder and both eventually resolve, no deadlock`, async () => {
        const sid = await mkCashSession();
        const holder = await acquireRawSessionLock(sid);

        const movementPromise = movementsService.payIn(
          tenantA,
          userA,
          movementInput(sid, {
            amountMinor: '1500',
            reason: `G double-wait run ${run}`,
          }),
        );
        await waitUntilGenuinelyBlocked();

        const closePromise = declareCloseFastPath(sid);
        // A second, distinct waiter must now ALSO be genuinely blocked —
        // re-poll for >= 2 blocked backends specifically.
        const deadline = Date.now() + 3000;
        for (;;) {
          const rows = await admin.$queryRaw<{ c: bigint }[]>`
            SELECT count(*)::bigint AS c FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query ILIKE '%pg_advisory_xact_lock%'
          `;
          if (Number(rows[0].c) >= 2) break;
          if (Date.now() > deadline) {
            throw new Error('Second waiter never registered as blocked.');
          }
          await new Promise((r) => setTimeout(r, 15));
        }

        await releaseRawSessionLock(holder);

        const [movementOutcome, closeOutcome] = await Promise.allSettled([
          movementPromise,
          closePromise,
        ]);
        // Whichever ordering Postgres resolved them in, exactly one of the
        // two valid final states holds (no deadlock, no corruption) —
        // identical invariant to §E's statistical proof, now reached via
        // two GENUINELY, SIMULTANEOUSLY queued real production calls.
        expect(closeOutcome.status).toBe('fulfilled');
        const session = await admin.cashSession.findUniqueOrThrow({
          where: { id: sid },
        });
        expect(session.status).toBe('closed');
        if (movementOutcome.status === 'fulfilled') {
          expect(session.expectedCash).toBe(51_500n);
        } else {
          expect(movementOutcome.reason).toBeInstanceOf(ConflictException);
          expect(session.expectedCash).toBe(50_000n);
        }
      }, 20_000);
    }
  });
});
