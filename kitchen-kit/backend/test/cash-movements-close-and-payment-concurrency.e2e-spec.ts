import { ConflictException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
import { AuditService } from './../src/modules/governance/audit/audit.service';
import { AUDIT_ACTION } from './../src/modules/governance/audit/audit.constants';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1G-0 ACCEPTANCE CLOSURE §3/§4 — the two cross-module concurrency proofs
 * the original P1G-0 implementation report did not cover.
 *
 * Authority: docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md
 * (CONTROLLING) + docs/reports/claude/2026-08-28_P1G0_cash-movements.md §F/§L.
 *
 * §D — SAFE_DROP vs a settling Payment on the SAME CashSession. Repository
 * fact (verified by direct code reading, `sales-payment.service.ts` step 5):
 * `SalesPaymentService.capture` reads CashSession facts via a PLAIN SELECT
 * (`CASH_SESSION_FACTS_QUERY`) — it takes NO lock on `cash_sessions`, the
 * `ros_cash_session` advisory lock included. This is therefore an
 * INTERLEAVING/INTEGRITY proof, not a mutual-lock proof: it demonstrates a
 * genuinely concurrent settling Payment completes correctly — and is NOT
 * blocked — while a SAFE_DROP holds that advisory lock open on the SAME
 * session, with no lost update, no duplicate row, and no deadlock. Payment/
 * CashSession serialization itself remains an open P1G-1 obligation, not
 * something P1G-0 provides or claims.
 *
 * §E — Movement vs a future CashSession close. No close service exists yet
 * (P1G-1). The design gate hands P1G-1 a binding contract: acquire the
 * IDENTICAL advisory lock (`pg_advisory_xact_lock(hashtext('ros_cash_
 * session'), hashtext(id))`) before mutating a session. This proves that
 * contract with TEST-ONLY fixture code only — a raw admin/migrator-
 * connection "future close writer" exercising the same lock, NOT a
 * production close service/controller/route, and NOT a `ros_app` grant
 * change (the writer uses the migrator connection precisely because
 * `ros_app` cannot UPDATE `cash_sessions` today).
 */
describe('P1G-0 acceptance closure — cross-module concurrency (§D Payment interleaving, §E close-lock contract)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let paymentService: SalesPaymentService;
  let movementsService: CashMovementsService;
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
   * Gate ONLY the `CASH_MOVEMENT_RECORDED` audit write — the LAST statement
   * inside `CashMovementsService.record`'s create path, still holding the
   * `ros_cash_session` advisory lock and still inside an uncommitted
   * transaction. Filtered by `action` (unlike the simpler single-purpose
   * gate in `cash-movements.e2e-spec.ts`) so a concurrently-running
   * Payment's OWN audit writes (`PAYMENT_CAPTURED`, `ORDER_COMPLETED`, the
   * `SALE_DEPLETED`/COGS-posting writes) never trip this gate.
   */
  class GatedCashMovementAuditService extends AuditService {
    private armed = false;
    private acquiredResolve: (() => void) | null = null;
    private gate: Promise<void> | null = null;
    private releaseGateFn: (() => void) | null = null;

    arm(): Promise<void> {
      this.armed = true;
      const acquired = new Promise<void>((res) => {
        this.acquiredResolve = res;
      });
      this.gate = new Promise<void>((res) => {
        this.releaseGateFn = res;
      });
      return acquired;
    }
    release(): void {
      this.releaseGateFn?.();
    }
    override async record(
      tx: Prisma.TransactionClient,
      event: Parameters<AuditService['record']>[1],
    ) {
      if (this.armed && event.action === AUDIT_ACTION.CASH_MOVEMENT_RECORDED) {
        this.armed = false;
        this.acquiredResolve?.();
        await this.gate;
      }
      return super.record(tx, event);
    }
  }

  /** Poll until a real, distinct backend is genuinely BLOCKED waiting on the
   *  `ros_cash_session` advisory lock — via
   *  `pg_stat_activity.wait_event_type='Lock'` on a backend whose own query
   *  names `pg_advisory_xact_lock`. Never a fixed sleep used as the proof
   *  itself, only as poll cadence. */
  async function waitForRealLockContention(
    client: PrismaClient,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await client.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%pg_advisory_xact_lock%'
      `;
      if (Number(rows[0].c) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          'Timed out waiting for genuine Postgres advisory-lock contention.',
        );
      }
      await new Promise((r) => setTimeout(r, 15));
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
    const shift = await admin.shift.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        employeeId: employeeA,
        status: 'open',
        openedAt: AT,
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
        openedAt: AT,
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

  // ================================================================= §D
  describe('D. SAFE_DROP vs a settling Payment on the SAME CashSession', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: both succeed, exactly one movement, exactly one payment, no lost update, no deadlock`, async () => {
        const sid = await mkCashSession();
        const item = await mkSellable(`SDvP-${run}-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        const lockAcquired = gatedAudit.arm();
        const safeDropId = newId();
        const safeDropPromise = movementsService.safeDrop(
          tenantA,
          userA,
          movementInput(sid, {
            id: safeDropId,
            amountMinor: '3000',
            reason: `safe drop run ${run}`,
          }),
        );
        // SAFE_DROP has inserted its row and holds the `ros_cash_session`
        // advisory lock, paused before its audit write — its transaction is
        // still open/uncommitted.
        await lockAcquired;

        // Prove genuine pre-Payment overlap: the SAFE_DROP row is NOT yet
        // visible from a separate connection.
        const beforePayment = await admin.cashMovement.findMany({
          where: { id: safeDropId },
        });
        expect(beforePayment).toHaveLength(0);

        // Fire and fully await a REAL settling Payment on the SAME session
        // WHILE the SAFE_DROP transaction is still open holding the
        // advisory lock. Payment takes no lock on `cash_sessions` (verified
        // repository fact), so it must complete without waiting.
        const paymentResult = await capture(order, sid);
        expect(paymentResult.order.state).toBe('completed');
        expect(paymentResult.payment.amount).toBe(order.grandTotal);
        expect(paymentResult.payment.tender).toBe('cash');
        expect(paymentResult.payment.cashSessionId).toBe(sid);

        // The SAFE_DROP row STILL must not be visible — proves the Payment
        // really completed CONCURRENTLY WITH (not after) the SAFE_DROP.
        const stillBefore = await admin.cashMovement.findMany({
          where: { id: safeDropId },
        });
        expect(stillBefore).toHaveLength(0);

        gatedAudit.release();
        const safeDropResult = await safeDropPromise;
        expect(safeDropResult.created).toBe(true);

        // ── Final integrity assertions ──
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
  describe('E. Movement vs a future CashSession close — TEST-ONLY lock-contract proof', () => {
    /**
     * TEST-ONLY "future close writer": raw admin/migrator-connection code
     * exercising the EXACT SAME advisory lock namespace/key the P1G-0
     * design gate binds a future P1G-1 close to acquire. NOT a production
     * close service/controller/route; no `ros_app` grant is added — the
     * writer uses the migrator connection precisely because `ros_app`
     * cannot UPDATE `cash_sessions` today (repository fact, §F).
     */
    function closeSessionHoldingLock(sessionId: string): {
      acquired: Promise<void>;
      release: () => void;
      commitPromise: Promise<void>;
    } {
      let acquiredResolve!: () => void;
      const acquired = new Promise<void>((res) => {
        acquiredResolve = res;
      });
      let releaseGateFn!: () => void;
      const gate = new Promise<void>((res) => {
        releaseGateFn = res;
      });

      const commitPromise = admin.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
            'ros_cash_session',
            sessionId,
          );
          await tx.cashSession.update({
            where: { id: sessionId },
            data: { status: 'closed', closedAt: new Date() },
          });
          acquiredResolve();
          await gate;
        },
        { timeout: 20_000, maxWait: 20_000 },
      );
      return { acquired, release: () => releaseGateFn(), commitPromise };
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: REQUIRED CASE — close-writer wins the lock first -> movement genuinely waits -> sees closed -> 409, zero rows written`, async () => {
        const sid = await mkCashSession();

        const closer = closeSessionHoldingLock(sid);
        // Close-writer holds the advisory lock, has already updated
        // status='closed', and is still uncommitted.
        await closer.acquired;

        const movementId = newId();
        const movementPromise = movementsService.payIn(
          tenantA,
          userA,
          movementInput(sid, {
            id: movementId,
            amountMinor: '4000',
            reason: `close race run ${run}`,
          }),
        );

        // Prove genuine contention: the movement's backend is really
        // BLOCKED waiting on the SAME advisory lock, not merely slow.
        await waitForRealLockContention(admin);

        closer.release();
        await closer.commitPromise; // close committed

        await expect(movementPromise).rejects.toThrow(ConflictException);

        const rows = await admin.cashMovement.findMany({
          where: { cashSessionId: sid },
        });
        expect(rows).toHaveLength(0);

        const session = await admin.cashSession.findUniqueOrThrow({
          where: { id: sid },
        });
        expect(session.status).toBe('closed');
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: opposite direction — a movement that wins the lock first commits, then the close proceeds normally`, async () => {
        const sid = await mkCashSession();

        const lockAcquired = gatedAudit.arm();
        const movementId = newId();
        const movementPromise = movementsService.payIn(
          tenantA,
          userA,
          movementInput(sid, {
            id: movementId,
            amountMinor: '2500',
            reason: `movement wins first run ${run}`,
          }),
        );
        // Movement holds the advisory lock, has inserted its row, paused
        // before its audit write — still uncommitted.
        await lockAcquired;

        const closer = closeSessionHoldingLock(sid);
        // The close-writer must now be genuinely blocked on the SAME lock
        // the movement is holding.
        await waitForRealLockContention(admin);

        gatedAudit.release();
        const movementResult = await movementPromise;
        expect(movementResult.created).toBe(true);

        // The close-writer, now free to acquire the lock, proceeds and
        // commits normally.
        await closer.acquired;
        closer.release();
        await closer.commitPromise;

        const session = await admin.cashSession.findUniqueOrThrow({
          where: { id: sid },
        });
        expect(session.status).toBe('closed');
        const rows = await admin.cashMovement.findMany({
          where: { cashSessionId: sid },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(movementId);
      }, 20_000);
    }
  });
});
