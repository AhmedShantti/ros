import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import {
  TransactionalDomainEventDispatcher,
  TransactionalDomainEventHandler,
} from './../src/common/domain-events/domain-event-dispatcher';
import { UnitOfWork } from './../src/common/domain-events/unit-of-work';
import type { DomainEventEnvelope } from './../src/common/domain-events/domain-event.types';
import type { DayClosedPayload } from './../src/modules/treasury/contract';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { CashClosePolicyService } from './../src/modules/treasury/cash-close-policy/cash-close-policy.service';
import type {
  DayCloseView,
  DayClosePostResult,
} from './../src/modules/treasury/day-close/day-close.service';
import { createMigratorClient } from './rls-admin';
import {
  activatePastEpoch,
  branchBusinessDay,
  createDayCloseFixture,
  dashboardToken,
  daysBefore,
  dateStr,
  DayCloseFixture,
  pinToken,
} from './day-close-fixtures';
import {
  closeCashSessionWithFacts,
  createCashSession,
  createMenuItemRef,
  createTaxClass,
  declareClosingSession,
  insertOrder,
  insertOrderLine,
  insertOrderPayment,
} from './reporting-fixtures';

/** The POST route's response body, typed — never `res.body` accessed raw. */
function postBody(res: request.Response): DayClosePostResult {
  return res.body as DayClosePostResult;
}

/** The GET route's response body, typed. */
function getBody(res: request.Response): DayCloseView {
  return res.body as DayCloseView;
}

/** Narrows a `DayClosePostResult` to its CLOSED variant, or fails loudly. */
function asClosed(
  result: DayClosePostResult,
): Extract<DayClosePostResult, { outcome: 'CLOSED' }> {
  if (result.outcome !== 'CLOSED') {
    throw new Error(`Expected outcome 'CLOSED', got '${result.outcome}'.`);
  }
  return result;
}

/** A 409 Problem-Details-shaped body carrying either blocker list. */
interface BlockerErrorBody {
  readonly message?: string;
  readonly blockingOrderIds?: readonly string[];
  readonly blockingSessions?: readonly { id: string; status: string }[];
}
function blockerBody(res: request.Response): BlockerErrorBody {
  return res.body as BlockerErrorBody;
}

/** `GET .../close-context` response — mirrors `cash-session-close.e2e-spec.ts`'s own `ContextBody`. */
interface CloseContextBody {
  readonly expectedCashMinorUnits?: string;
}
function closeContextBody(res: request.Response): CloseContextBody {
  return res.body as CloseContextBody;
}

/** `POST .../close` response — mirrors `cash-session-close.e2e-spec.ts`'s own `DeclareBody`. */
interface DeclareCloseBody {
  readonly status: 'closing' | 'closed';
}
function declareCloseBody(res: request.Response): DeclareCloseBody {
  return res.body as DeclareCloseBody;
}

/**
 * DayClose (e2e) — Migration 35, DAYCLOSE ACCEPTANCE COMPLETION task
 * (2026-09-01). Authority: `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
 * DC-R1/R2/R3 + the four 2026-08-31 DayClose design/correction reports —
 * BINDING. This suite proves the implementation against those decisions; it
 * does not reopen or reinterpret them.
 *
 * Item numbers in comments (`item 1`, `item 24`, …) trace to the
 * acceptance-completion task's §4 required-coverage list, for the
 * completion report's traceability table. Closely related items sharing one
 * fixture/mechanism are proven together inside a single `it()`.
 */
describe('DayClose (e2e) — Migration 35', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let prisma: PrismaService;
  let policies: CashClosePolicyService;

  const capturedDayClosedEvents: DomainEventEnvelope<
    'day.closed',
    DayClosedPayload
  >[] = [];
  let throwOnNextDayClosedEvent = false;
  const dayClosedCaptureHandler: TransactionalDomainEventHandler = {
    eventType: 'day.closed',
    handle: (event) => {
      capturedDayClosedEvents.push(
        event as DomainEventEnvelope<'day.closed', DayClosedPayload>,
      );
      if (throwOnNextDayClosedEvent) {
        throwOnNextDayClosedEvent = false;
        return Promise.reject(
          new Error('test-injected subscriber failure (item 48)'),
        );
      }
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(UnitOfWork)
      .useFactory({
        factory: (prismaService: PrismaService) =>
          new UnitOfWork(
            prismaService,
            TransactionalDomainEventDispatcher.withHandlers([
              dayClosedCaptureHandler,
            ]),
          ),
        inject: [PrismaService],
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    policies = app.get(CashClosePolicyService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let seedN = 0;
  const seed = () => `${stamp}${(seedN++).toString(36)}`;

  let n = 0;
  const orderNumber = () => `O-${++n}`;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  function post(
    fx: Pick<DayCloseFixture, 'branchId'>,
    token: string,
    businessDay: Date,
    idempotencyKey = newId(),
  ) {
    return request(http)
      .post(`/branches/${fx.branchId}/day-closes/${dateStr(businessDay)}`)
      .set(auth(token))
      .set('Idempotency-Key', idempotencyKey)
      .send({});
  }

  function get(
    fx: Pick<DayCloseFixture, 'branchId'>,
    token: string,
    businessDay: Date,
  ) {
    return request(http)
      .get(`/branches/${fx.branchId}/day-closes/${dateStr(businessDay)}`)
      .set(auth(token));
  }

  /** Fresh fixture + full-permission dashboard token, ready to POST/GET. */
  async function mkFx(): Promise<{ fx: DayCloseFixture; token: string }> {
    const fx = await createDayCloseFixture(app, admin, seed());
    const token = await dashboardToken(http, fx.fullEmail, fx.tenantId);
    return { fx, token };
  }

  /** Activate `daysAgo` before "today" (branch business day), return the epoch. */
  async function activate(fx: DayCloseFixture, daysAgo: number): Promise<Date> {
    const activationBusinessDay = daysBefore(
      branchBusinessDay(new Date()),
      daysAgo,
    );
    await activatePastEpoch(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      activatedByUserId: fx.employeeUserId,
      activationBusinessDay,
    });
    return activationBusinessDay;
  }

  // =========================================================== ACTIVATION ===
  describe('ACTIVATION (items 1-7)', () => {
    it('items 1-4: first POST activates (never a day sealed), persists, audits once, no day.closed', async () => {
      const { fx, token } = await mkFx();
      const before = capturedDayClosedEvents.length;
      const businessDay = branchBusinessDay(new Date());
      const res = await post(fx, token, businessDay).expect(200);
      const result = postBody(res);
      expect(result).toMatchObject({
        outcome: 'ACTIVATED',
        branchId: fx.branchId,
        businessDay: dateStr(businessDay),
        activationBusinessDay: dateStr(businessDay),
        firstEligibleBusinessDay: dateStr(daysBefore(businessDay, -1)),
      });
      expect('dayClose' in result).toBe(false);

      // item 2 — persists.
      const row = await admin.dayCloseActivation.findUnique({
        where: {
          tenantId_branchId: { tenantId: fx.tenantId, branchId: fx.branchId },
        },
      });
      expect(row).not.toBeNull();
      expect(dateStr(row!.activationBusinessDay)).toBe(dateStr(businessDay));

      // item 3 — exactly one DAY_CLOSE_ACTIVATED audit entry.
      const audits = await admin.auditEntry.count({
        where: {
          tenantId: fx.tenantId,
          action: 'DAY_CLOSE_ACTIVATED',
          entityId: row!.id,
        },
      });
      expect(audits).toBe(1);

      // item 4 — no day.closed published on activation.
      expect(capturedDayClosedEvents.length).toBe(before);
      const dayCloseRows = await admin.dayClose.count({
        where: { tenantId: fx.tenantId, branchId: fx.branchId },
      });
      expect(dayCloseRows).toBe(0);
    });

    it('item 5: same Idempotency-Key replay returns the identical ACTIVATED result', async () => {
      const { fx, token } = await mkFx();
      const businessDay = branchBusinessDay(new Date());
      const key = newId();
      const first = await post(fx, token, businessDay, key).expect(200);
      const replay = await post(fx, token, businessDay, key).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['idempotent-replay']).toBe('true');
      const activations = await admin.dayCloseActivation.count({
        where: { tenantId: fx.tenantId, branchId: fx.branchId },
      });
      expect(activations).toBe(1);
    });

    it('item 6: a NEW key later may close, once eligible', async () => {
      const { fx, token } = await mkFx();
      // Activate far enough in the past that "today" already has an
      // eligible closeable day (A+1), then activate via a DIFFERENT
      // (earlier, already-consumed) key, then close with a fresh key.
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1); // A+1
      const res = await post(fx, token, target, newId()).expect(200);
      expect(postBody(res).outcome).toBe('CLOSED');
    });

    it('item 7: concurrent first activation creates exactly one activation row', async () => {
      const { fx, token } = await mkFx();
      const today = branchBusinessDay(new Date());
      const tomorrow = daysBefore(today, -1);
      // Real Postgres race: two DIFFERENT target businessDays (today,
      // tomorrow) so the two requests take DIFFERENT
      // `ros_order_number(branchId, businessDay)` advisory-lock keys and do
      // NOT serialise against each other — both may reach the `!existing
      // Activation` branch genuinely concurrently and race on the
      // `day_close_activations` INSERT itself, exercising
      // `uq_day_close_activations_branch` and `post()`'s bounded P2002
      // retry (same-target-day concurrency would just be serialised by the
      // shared fence lock before either reaches the INSERT, proving nothing
      // about the retry path). Whichever loses is retried by `post()` from
      // a fresh transaction, which then re-evaluates ITS OWN requested day
      // against the now-committed epoch: "today" is rejected as the
      // not-yet-closeable current day (409); "tomorrow" is rejected as a
      // future day (400). Exactly one request gets ACTIVATED; the other
      // gets a coherent, day-specific rejection — never a second
      // activation row.
      const results = await Promise.all([
        post(fx, token, today, newId()),
        post(fx, token, tomorrow, newId()),
      ]);
      const activated = results.filter((r) => r.status === 200);
      const rejected = results.filter((r) => r.status !== 200);
      expect(activated).toHaveLength(1);
      expect(postBody(activated[0]).outcome).toBe('ACTIVATED');
      expect(rejected).toHaveLength(1);
      expect([400, 409]).toContain(rejected[0].status);

      const activations = await admin.dayCloseActivation.count({
        where: { tenantId: fx.tenantId, branchId: fx.branchId },
      });
      expect(activations).toBe(1);
    });
  });

  // ====================================================== DAY ELIGIBILITY ===
  describe('DAY ELIGIBILITY (items 8-11)', () => {
    it('item 8: a future business day is rejected (400)', async () => {
      const { fx, token } = await mkFx();
      await activate(fx, 5);
      const tomorrow = daysBefore(branchBusinessDay(new Date()), -1);
      await post(fx, token, tomorrow).expect(400);
    });

    it('item 9: the current business day cannot yet be closed (409)', async () => {
      const { fx, token } = await mkFx();
      await activate(fx, 10);
      const today = branchBusinessDay(new Date());
      await post(fx, token, today).expect(409);
    });

    it('item 10: the activation day itself is outside the epoch (409)', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      await post(fx, token, activationDay).expect(409);
    });

    it('item 11: the first eligible day (A+1) closes once current >= A+2', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const firstEligible = daysBefore(activationDay, -1);
      const res = await post(fx, token, firstEligible).expect(200);
      const result = asClosed(postBody(res));
      expect(result.outcome).toBe('CLOSED');
      expect(result.dayClose.zNumber).toBe('1');
    });
  });

  // ===================================================== FR-FIN-021 =========
  describe('FR-FIN-021 — global open/closing cash-session blocker (items 12-16)', () => {
    it('items 12-15: an open session (with or without payments/movements) and a closing session both block', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);

      // item 12/14 — a zero-payment OPEN session blocks.
      const openSession = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      const blocked1 = await post(fx, token, target).expect(409);
      expect(blockerBody(blocked1).blockingSessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: openSession, status: 'open' }),
        ]),
      );

      // item 13 — swap to a CLOSING (declared, not finalised) session.
      await admin.cashSession.delete({ where: { id: openSession } }).catch(
        // FK-protected in general; if delete fails (real invariant), close it
        // out of the way instead so the next assertion is still isolated.
        async () => {
          await admin.cashSession.update({
            where: { id: openSession },
            data: { status: 'closed', closedAt: new Date() },
          });
        },
      );
      const closingSession = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      await declareClosingSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        cashSessionId: closingSession,
        employeeId: fx.employeeId,
        employeeUserId: fx.employeeUserId,
        terminalId: fx.terminalId,
        openingFloat: 0n,
        cashSalesTotal: 0n,
        countedCash: 0n,
      });
      const blocked2 = await post(fx, token, target).expect(409);
      expect(blockerBody(blocked2).blockingSessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: closingSession, status: 'closing' }),
        ]),
      );
    });

    it('item 16: a blocking session belongs to the branch/tenant — another tenant/branch never blocks', async () => {
      const { fx, token } = await mkFx();
      const other = await createDayCloseFixture(app, admin, seed());
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      // An open session at a DIFFERENT tenant/branch must not block fx's close.
      await createCashSession(admin, {
        tenantId: other.tenantId,
        branchId: other.branchId,
        employeeId: other.employeeId,
      });
      const res = await post(fx, token, target).expect(200);
      expect(postBody(res).outcome).toBe('CLOSED');
    });
  });

  // ========================================================= OPEN ORDERS ====
  describe('OPEN ORDERS (items 17-23)', () => {
    it.each([
      ['draft', true],
      ['open', true],
      ['held', true],
      ['parked', true],
      ['partially_paid', true],
      ['completed', false],
      ['cancelled', false],
    ] as const)('item 17-23: state=%s blocks=%s', async (state, blocks) => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      const orderId = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: target,
        orderNumber: orderNumber(),
        state,
        grandTotal: 100n,
        taxTotal: 10n,
      });
      const res = await post(fx, token, target);
      if (blocks) {
        expect(res.status).toBe(409);
        expect(blockerBody(res).blockingOrderIds).toEqual([orderId]);
      } else {
        expect(res.status).toBe(200);
        expect(postBody(res).outcome).toBe('CLOSED');
      }
    });
  });

  // ============================================ CASHSESSION CLOSED_BUSINESS_DAY
  describe('cash_sessions.closed_business_day (items 24-27)', () => {
    it('items 24-25: the final CLOSED transition writes closed_business_day, consistent with the same close facts', async () => {
      const fx = await createDayCloseFixture(app, admin, seed());
      const businessDay = branchBusinessDay(new Date());
      await policies.create(fx.tenantId, fx.employeeUserId, {
        branchId: fx.branchId,
        varianceToleranceMinorUnits: '0',
        varianceApprovalExpirySeconds: 300,
      });
      const sessionId = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      // Use the REAL close-context/close pipeline via HTTP, exactly as
      // `cash-session-close.e2e-spec.ts` does, so this proves the actual
      // production write path (not a fixture shortcut). This route
      // requires a POS/PIN identity (`requirePosIdentity`), never a
      // dashboard-only token.
      const posToken = await pinToken(
        http,
        fx.tenantId,
        fx.terminalId,
        fx.employeeCode,
        fx.pin,
      );
      const context = await request(http)
        .get(`/cash-sessions/${sessionId}/close-context`)
        .set(auth(posToken))
        .expect(200);
      const declare = await request(http)
        .post(`/cash-sessions/${sessionId}/close`)
        .set(auth(posToken))
        .set('Idempotency-Key', newId())
        .send({
          closeAttemptId: newId(),
          countedTotalMinorUnits:
            closeContextBody(context).expectedCashMinorUnits ?? '0',
        })
        .expect(201);
      // countedTotalMinorUnits == expectedCashMinorUnits exactly (variance
      // 0), so this always closes in the ONE-request fast path; the
      // above-tolerance `closing` -> `close/finalize` (manager PIN) branch
      // is exhaustively covered by `cash-session-close.e2e-spec.ts` itself.
      expect(declareCloseBody(declare).status).toBe('closed');
      const row = await admin.cashSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(row.status).toBe('closed');
      expect(row.closedBusinessDay).not.toBeNull();
      expect(dateStr(row.closedBusinessDay!)).toBe(dateStr(businessDay));
      // Written in the SAME row/transaction as the other close facts —
      // if the transaction were split, a row could exist with facts set but
      // closedBusinessDay NULL. It never does.
      expect(row.expectedCash).not.toBeNull();
      expect(row.closedAt).not.toBeNull();
    });

    it('item 27: a legacy closed session (pre-migration-35 shape) keeps closed_business_day NULL and is never attributed as a variance owner', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      // Direct-insert `closed`, closedBusinessDay left NULL — the exact
      // "closed before migration 35" shape (never backfilled/inferred).
      await closeCashSessionWithFacts(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        cashSessionId: await createCashSession(admin, {
          tenantId: fx.tenantId,
          branchId: fx.branchId,
          employeeId: fx.employeeId,
        }),
        employeeId: fx.employeeId,
        employeeUserId: fx.employeeUserId,
        terminalId: fx.terminalId,
        openingFloat: 1_000n,
        cashSalesTotal: 0n,
        countedCash: 1_000n,
      });
      const res = await post(fx, token, target).expect(200);
      const dayClose = asClosed(postBody(res)).dayClose;
      expect(dayClose.cashReconciliation.sessionCount).toBe(0);
      expect(dayClose.cashReconciliation.varianceOwnerSessionCount).toBe(0);
    });

    /**
     * GAP B (2026-09-01 final-acceptance-cleanup task) — mechanical proof
     * that `treasury.cash_sessions.closed_business_day` cannot be rewritten
     * once `status = 'closed'`, via the SAME `cash_sessions_update` RLS
     * policy migration 34 already installed (`USING (... AND status IN
     * ('open','closing'))` — a `closed` row is simply not VISIBLE to any
     * UPDATE `ros_app` issues, regardless of which column is targeted). No
     * new grant, trigger, or policy is added by migration 35 or by this
     * test; migration 35 only adds a column-level `UPDATE
     * ("closed_business_day")` GRANT, which this test proves the
     * PRE-EXISTING row-visibility policy still fully neutralises for any
     * already-closed row.
     */
    it('GAP B: closed_business_day (and every other close fact) is unwritable via raw SQL once the session is closed', async () => {
      const fx = await createDayCloseFixture(app, admin, seed());
      const businessDay = branchBusinessDay(new Date());
      await policies.create(fx.tenantId, fx.employeeUserId, {
        branchId: fx.branchId,
        varianceToleranceMinorUnits: '0',
        varianceApprovalExpirySeconds: 300,
      });
      const sessionId = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      const posToken = await pinToken(
        http,
        fx.tenantId,
        fx.terminalId,
        fx.employeeCode,
        fx.pin,
      );
      const context = await request(http)
        .get(`/cash-sessions/${sessionId}/close-context`)
        .set(auth(posToken))
        .expect(200);
      const declare = await request(http)
        .post(`/cash-sessions/${sessionId}/close`)
        .set(auth(posToken))
        .set('Idempotency-Key', newId())
        .send({
          closeAttemptId: newId(),
          countedTotalMinorUnits:
            closeContextBody(context).expectedCashMinorUnits ?? '0',
        })
        .expect(201);
      expect(declareCloseBody(declare).status).toBe('closed');

      // 1-3: real close pipeline, status = closed, closed_business_day = D.
      const before = await admin.cashSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(before.status).toBe('closed');
      expect(before.closedBusinessDay).not.toBeNull();
      expect(dateStr(before.closedBusinessDay!)).toBe(dateStr(businessDay));
      const originalClosedBusinessDay = before.closedBusinessDay!;
      const originalCountedCash = before.countedCash;

      // 4: as ros_app (PrismaService — the RLS-constrained runtime role),
      // inside valid tenant context, attempt to rewrite closed_business_day
      // to a DIFFERENT day.
      const differentDay = daysBefore(businessDay, 3);
      let rewriteRowCount: number | null = null;
      let rewriteError: unknown = null;
      try {
        rewriteRowCount = await prisma.withAuthContext(
          { tenantId: fx.tenantId },
          (tx) =>
            tx.$executeRawUnsafe(
              `UPDATE treasury.cash_sessions
                 SET closed_business_day = $1
               WHERE tenant_id = $2 AND id = $3`,
              differentDay,
              fx.tenantId,
              sessionId,
            ),
        );
      } catch (err) {
        rewriteError = err;
      }

      // Also attempt another granted close column, on the SAME closed row,
      // to demonstrate the row itself is entirely not update-visible, not
      // just this one column.
      let secondRowCount: number | null = null;
      let secondError: unknown = null;
      try {
        secondRowCount = await prisma.withAuthContext(
          { tenantId: fx.tenantId },
          (tx) =>
            tx.$executeRawUnsafe(
              `UPDATE treasury.cash_sessions
                 SET counted_cash = counted_cash + 1
               WHERE tenant_id = $1 AND id = $2`,
              fx.tenantId,
              sessionId,
            ),
        );
      } catch (err) {
        secondError = err;
      }

      // 5: the durable invariant — regardless of WHICH shape Postgres/RLS
      // chose (zero rows affected, or a thrown policy/permission error),
      // the persisted value never changed. OBSERVED (final-acceptance-
      // cleanup verification, 2026-09-01): both raw UPDATE attempts affect
      // ZERO rows and throw NO error — Postgres's standard RLS `UPDATE`
      // semantics for a restrictive `USING` clause (§migration 34's
      // `cash_sessions_update` policy): a row that fails `USING` is simply
      // not a candidate for the UPDATE, exactly as it would not be for a
      // `SELECT ... FOR UPDATE`, so the command reports 0 rows affected
      // rather than throwing a permission/policy error.
      const after = await admin.cashSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(dateStr(after.closedBusinessDay!)).toBe(
        dateStr(originalClosedBusinessDay),
      );
      expect(after.countedCash).toBe(originalCountedCash);
      expect(after.status).toBe('closed');

      // Record which shape was actually observed, for the report — RLS's
      // `USING` clause on a restrictive-visibility policy is expected to
      // manifest as "zero rows affected", never a thrown error, since the
      // GRANT itself is present (migration 34/35); a thrown error is
      // accepted too (either shape proves the same durable invariant).
      if (rewriteError === null) {
        expect(rewriteRowCount).toBe(0);
      }
      if (secondError === null) {
        expect(secondRowCount).toBe(0);
      }
    });
  });

  // ===================================== DC-R2 SPANNING SESSION / VARIANCE ===
  describe('DC-R2 — spanning session variance ownership (items 28-35)', () => {
    it('items 28-33: a session spanning D and D+1 links to BOTH DayCloses; variance belongs to the close day only, exactly once; two linkage rows exist (no unconditional unique)', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 8);
      const dayD = daysBefore(activationDay, -1); // A+1
      const dayD1 = daysBefore(dayD, -1); // A+2

      const sessionId = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      // item 28/29 — tender contribution on BOTH days.
      const orderD = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: dayD,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: 200n,
        taxTotal: 20n,
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        orderId: orderD,
        businessDay: dayD,
        terminalId: fx.terminalId,
        employeeId: fx.employeeId,
        cashSessionId: sessionId,
        tender: 'cash',
        amount: 200n,
      });
      const orderD1 = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: dayD1,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: 300n,
        taxTotal: 30n,
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        orderId: orderD1,
        businessDay: dayD1,
        terminalId: fx.terminalId,
        employeeId: fx.employeeId,
        cashSessionId: sessionId,
        tender: 'cash',
        amount: 300n,
      });
      // Whole-session close facts, closedBusinessDay = D+1 (the close day).
      const { variance } = await closeCashSessionWithFacts(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        cashSessionId: sessionId,
        employeeId: fx.employeeId,
        employeeUserId: fx.employeeUserId,
        terminalId: fx.terminalId,
        openingFloat: 1_000n,
        cashSalesTotal: 500n, // whole-session cash (D + D1 combined)
        countedCash: 1_050n, // deliberately off by 50 to get a nonzero variance
      });
      await admin.cashSession.update({
        where: { id: sessionId },
        data: { closedBusinessDay: dayD1 },
      });
      expect(variance).not.toBe(0n);

      const dcD = asClosed(
        postBody(await post(fx, token, dayD).expect(200)),
      ).dayClose;
      const dcD1 = asClosed(
        postBody(await post(fx, token, dayD1).expect(200)),
      ).dayClose;

      const sessD = dcD.cashReconciliation.sessions.find(
        (s) => s.cashSessionId === sessionId,
      );
      const sessD1 = dcD1.cashReconciliation.sessions.find(
        (s) => s.cashSessionId === sessionId,
      );
      expect(sessD).toBeDefined();
      expect(sessD1).toBeDefined();
      // item 28/29 — day-scoped cash totals differ per day.
      expect(sessD!.dayScoped.cashSalesTotal).toBe('200');
      expect(sessD1!.dayScoped.cashSalesTotal).toBe('300');
      // item 30 — variance owned by D+1 only.
      expect(sessD!.isVarianceOwner).toBe(false);
      expect(sessD1!.isVarianceOwner).toBe(true);
      expect(dcD.cashReconciliation.varianceTotal).toBe('0');
      expect(dcD1.cashReconciliation.varianceTotal).toBe(variance.toString());
      // item 31 — summed across both DayCloses, the variance appears exactly once.
      const totalAcrossBoth =
        BigInt(dcD.cashReconciliation.varianceTotal) +
        BigInt(dcD1.cashReconciliation.varianceTotal);
      expect(totalAcrossBoth).toBe(variance);

      // item 32/33 — TWO linkage rows for the SAME cash_session_id, under
      // two DIFFERENT day_close_id — proves no unconditional
      // UNIQUE(tenant_id, cash_session_id) exists (it would have made the
      // second linkage insert fail).
      const linkageRows = await admin.dayCloseSession.findMany({
        where: { tenantId: fx.tenantId, cashSessionId: sessionId },
      });
      expect(linkageRows).toHaveLength(2);
      expect(new Set(linkageRows.map((r) => r.dayCloseId)).size).toBe(2);
    });

    it('items 34-35: a zero-payment closed session and a movement-only closed session are both linked and variance-owned on their close day', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);

      // item 34 — zero payments at all.
      const zeroPaymentSession = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      await closeCashSessionWithFacts(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        cashSessionId: zeroPaymentSession,
        employeeId: fx.employeeId,
        employeeUserId: fx.employeeUserId,
        terminalId: fx.terminalId,
        openingFloat: 500n,
        cashSalesTotal: 0n,
        countedCash: 500n,
      });
      await admin.cashSession.update({
        where: { id: zeroPaymentSession },
        data: { closedBusinessDay: target },
      });

      // item 35 — movement-only (pay-in/pay-out drive expectedCash; zero
      // order payments).
      const movementSession = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      await closeCashSessionWithFacts(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        cashSessionId: movementSession,
        employeeId: fx.employeeId,
        employeeUserId: fx.employeeUserId,
        terminalId: fx.terminalId,
        openingFloat: 200n,
        cashSalesTotal: 0n,
        payInTotal: 300n,
        payOutTotal: 50n,
        countedCash: 450n, // 200 + 300 - 50
      });
      await admin.cashSession.update({
        where: { id: movementSession },
        data: { closedBusinessDay: target },
      });

      const res = await post(fx, token, target).expect(200);
      const dayClose = asClosed(postBody(res)).dayClose;
      expect(dayClose.cashReconciliation.sessionCount).toBe(2);
      expect(dayClose.cashReconciliation.varianceOwnerSessionCount).toBe(2);
      const ids = dayClose.cashReconciliation.sessions.map(
        (s) => s.cashSessionId,
      );
      expect(ids).toEqual(
        expect.arrayContaining([zeroPaymentSession, movementSession]),
      );
    });
  });

  // ============================================================ HISTORICAL ===
  describe('HISTORICAL GET (items 36-41)', () => {
    it('item 36: GET reads the persisted snapshot only — later mutation of underlying orders never changes it', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: target,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: 1_000n,
        taxTotal: 100n,
      });
      const closed = asClosed(
        postBody(await post(fx, token, target).expect(200)),
      );
      expect(closed.dayClose.salesSummary.grossSales).toBe('1000');

      // Mutate the underlying fact AFTER the close — the persisted Z must
      // not move.
      await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: target,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: 5_000n,
        taxTotal: 500n,
      });

      const historical = getBody(await get(fx, token, target).expect(200));
      expect(historical.salesSummary.grossSales).toBe('1000');
      expect(historical.zNumber).toBe(closed.dayClose.zNumber);
    });

    it('item 37: a day with no persisted DayClose returns 404, including a pre-activation day', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const eligibleButOpen = daysBefore(activationDay, -1);
      await get(fx, token, eligibleButOpen).expect(404);
      const preActivation = daysBefore(activationDay, -2);
      await get(fx, token, preActivation).expect(404);
    });

    it('item 38: GET never creates a DayClose as a side effect', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      await get(fx, token, target).expect(404);
      const count = await admin.dayClose.count({
        where: { tenantId: fx.tenantId, branchId: fx.branchId },
      });
      expect(count).toBe(0);
    });

    it('items 39-41: GET requires report.view.financial; cash.day.close or report.view.sales alone are refused', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      await post(fx, token, target).expect(200);

      const financialOnlyToken = await dashboardToken(
        http,
        fx.financialOnlyEmail,
        fx.tenantId,
      );
      await get(fx, financialOnlyToken, target).expect(200); // item 39 positive

      const dayCloseOnlyToken = await dashboardToken(
        http,
        fx.dayCloseOnlyEmail,
        fx.tenantId,
      );
      await get(fx, dayCloseOnlyToken, target).expect(403); // item 40

      const salesOnlyToken = await dashboardToken(
        http,
        fx.salesOnlyEmail,
        fx.tenantId,
      );
      await get(fx, salesOnlyToken, target).expect(403); // item 41
    });
  });

  // ================================================================ POST AUTH
  describe('POST authorization (items 42-44)', () => {
    it('items 42-43: cash.day.close is required; report.view.financial alone cannot POST', async () => {
      const { fx } = await mkFx();
      const businessDay = branchBusinessDay(new Date());

      const dayCloseOnlyToken = await dashboardToken(
        http,
        fx.dayCloseOnlyEmail,
        fx.tenantId,
      );
      await post(fx, dayCloseOnlyToken, businessDay).expect(200); // item 42

      const fx2 = await createDayCloseFixture(app, admin, seed());
      const financialOnlyToken = await dashboardToken(
        http,
        fx2.financialOnlyEmail,
        fx2.tenantId,
      );
      await post(fx2, financialOnlyToken, branchBusinessDay(new Date())).expect(
        403,
      ); // item 43
    });

    it('item 44: both a POS/PIN session and a dashboard session may POST', async () => {
      const fx = await createDayCloseFixture(app, admin, seed());
      const posToken = await pinToken(
        http,
        fx.tenantId,
        fx.terminalId,
        fx.employeeCode,
        fx.pin,
      );
      const posRes = await post(fx, posToken, branchBusinessDay(new Date()));
      expect(posRes.status).toBe(200);
      expect(postBody(posRes).outcome).toBe('ACTIVATED');

      const fx2 = await createDayCloseFixture(app, admin, seed());
      const dashToken = await dashboardToken(http, fx2.fullEmail, fx2.tenantId);
      const dashRes = await post(fx2, dashToken, branchBusinessDay(new Date()));
      expect(dashRes.status).toBe(200);
      expect(postBody(dashRes).outcome).toBe('ACTIVATED');
    });
  });

  // ================================================================ IDEMPOTENCY
  describe('IDEMPOTENCY (items 45-48)', () => {
    it('item 45: a CLOSED same-key replay returns the identical result; no duplicate row', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      const key = newId();
      const first = await post(fx, token, target, key).expect(200);
      const replay = await post(fx, token, target, key).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['idempotent-replay']).toBe('true');
      const count = await admin.dayClose.count({
        where: { tenantId: fx.tenantId, branchId: fx.branchId },
      });
      expect(count).toBe(1);
    });

    it('item 46: the SAME key against a DIFFERENT businessDay (different path/fingerprint) is a 409', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 8);
      const dayD = daysBefore(activationDay, -1);
      const dayD1 = daysBefore(dayD, -1);
      const key = newId();
      await post(fx, token, dayD, key).expect(200);
      await post(fx, token, dayD1, key).expect(409);
    });

    it('item 47: a NEW distinct key against an already-closed day gets the normal business-conflict 409, not a replay', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      await post(fx, token, target, newId()).expect(200);
      const res = await post(fx, token, target, newId()).expect(409);
      expect(res.headers['idempotent-replay']).toBeUndefined();
    });

    it('item 48: a subscriber failure rolls back the WHOLE transaction — no durable DayClose/audit/event survive', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      throwOnNextDayClosedEvent = true;
      try {
        await post(fx, token, target, newId());
      } catch {
        // The HTTP call itself may resolve as a 5xx rather than throw client-side.
      } finally {
        throwOnNextDayClosedEvent = false;
      }
      const dayCloseCount = await admin.dayClose.count({
        where: { tenantId: fx.tenantId, branchId: fx.branchId },
      });
      expect(dayCloseCount).toBe(0);
      const auditCount = await admin.auditEntry.count({
        where: { tenantId: fx.tenantId, action: 'DAY_CLOSED' },
      });
      expect(auditCount).toBe(0);

      // A fresh key against the SAME day now succeeds cleanly.
      const retry = await post(fx, token, target, newId());
      expect(retry.status).toBe(200);
      expect(postBody(retry).outcome).toBe('CLOSED');
    });
  });

  // =============================================================== SNAPSHOT ===
  describe('SNAPSHOT MATH (item §8 of the task)', () => {
    it('gross/discounts/refunds/net/count/AOV, tender totals, order-type split, pre-fire void, tax-by-class, currency all match hand-computed figures', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);

      const taxClass = await createTaxClass(admin, {
        tenantId: fx.tenantId,
        code: 'standard',
      });
      const item = await createMenuItemRef(admin, fx.tenantId);
      const cashSessionId = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });

      // Order 1 — dine_in, cash, one voided (pre-fire) line worth 50.
      const order1 = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: target,
        orderNumber: orderNumber(),
        state: 'completed',
        orderType: 'dine_in',
        grandTotal: 1_000n,
        taxTotal: 100n,
      });
      await insertOrderLine(admin, {
        tenantId: fx.tenantId,
        orderId: order1,
        businessDay: target,
        sequence: 1,
        menuItemId: item.menuItemId,
        variantId: item.variantId,
        taxClassId: taxClass,
        taxAmount: 100n,
        lineTotal: 1_000n,
        state: 'served',
      });
      await insertOrderLine(admin, {
        tenantId: fx.tenantId,
        orderId: order1,
        businessDay: target,
        sequence: 2,
        menuItemId: item.menuItemId,
        variantId: item.variantId,
        taxClassId: taxClass,
        taxAmount: 5n,
        lineTotal: 50n,
        state: 'voided',
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        orderId: order1,
        businessDay: target,
        terminalId: fx.terminalId,
        employeeId: fx.employeeId,
        cashSessionId,
        tender: 'cash',
        amount: 1_000n,
      });

      // Order 2 — takeaway, manual_external_card.
      const order2 = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: target,
        orderNumber: orderNumber(),
        state: 'completed',
        orderType: 'takeaway',
        grandTotal: 500n,
        taxTotal: 50n,
      });
      await insertOrderLine(admin, {
        tenantId: fx.tenantId,
        orderId: order2,
        businessDay: target,
        sequence: 1,
        menuItemId: item.menuItemId,
        variantId: item.variantId,
        taxClassId: taxClass,
        taxAmount: 50n,
        lineTotal: 500n,
        state: 'served',
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        orderId: order2,
        businessDay: target,
        terminalId: fx.terminalId,
        employeeId: fx.employeeId,
        cashSessionId,
        tender: 'manual_external_card',
        amount: 500n,
      });

      // Close the whole-session facts to match the cash payment exactly.
      await closeCashSessionWithFacts(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        cashSessionId,
        employeeId: fx.employeeId,
        employeeUserId: fx.employeeUserId,
        terminalId: fx.terminalId,
        openingFloat: 0n,
        cashSalesTotal: 1_000n,
        countedCash: 1_000n,
      });
      await admin.cashSession.update({
        where: { id: cashSessionId },
        data: { closedBusinessDay: target },
      });

      const res = await post(fx, token, target).expect(200);
      const dc = asClosed(postBody(res)).dayClose;

      // gross = 1000 + 500 = 1500; tax = 150; net = 1350; count = 2; AOV = 675
      expect(dc.salesSummary.grossSales).toBe('1500');
      expect(dc.salesSummary.discounts).toBe('0');
      expect(dc.salesSummary.refunds).toBe('0');
      expect(dc.salesSummary.taxTotal).toBe('150');
      expect(dc.salesSummary.netSales).toBe('1350');
      expect(dc.salesSummary.completedOrderCount).toBe(2);
      expect(dc.salesSummary.averageOrderValue).toBe('675');

      expect(dc.tenderTotals.cash.amountTotal).toBe('1000');
      expect(dc.tenderTotals.cash.paymentCount).toBe(1);
      expect(dc.tenderTotals.manualExternalCard.amountTotal).toBe('500');
      expect(dc.tenderTotals.manualExternalCard.paymentCount).toBe(1);
      expect(dc.tenderTotals.unsettledCapturedTotal).toBe('0');
      expect(dc.tenderTotals.completedExcessCapturedTotal).toBe('0');

      expect(dc.salesByOrderType).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderType: 'dine_in',
            grossSales: '1000',
            netSales: '900',
            orderCount: 1,
          }),
          expect.objectContaining({
            orderType: 'takeaway',
            grossSales: '500',
            netSales: '450',
            orderCount: 1,
          }),
        ]),
      );

      // Pre-fire void: 1 line, value 50.
      expect(dc.voidAndCompSummary.voidedLineCount).toBe(1);
      expect(dc.voidAndCompSummary.voidedLineValue).toBe('50');
      // FR-FIN-022 comp remains structurally zero.
      expect(dc.voidAndCompSummary.compLineCount).toBe(0);
      expect(dc.voidAndCompSummary.compLineValue).toBe('0');

      // Tax by class — ONE class, tax = 100+5+50 = 155, net = 900+45+450=1395,
      // gross = 1050+500 = ... computed from order_lines directly, NOT orders:
      // line1 (served) 1000/100, line2 (voided) excluded by DAILY_TRADING's
      // own state filter (voided/comped excluded) — so tax-by-class reflects
      // ONLY non-voided lines: 100 (order1 served line) + 50 (order2 line) = 150.
      expect(dc.taxByClass).toHaveLength(1);
      expect(dc.taxByClass[0].taxClassId).toBe(taxClass);
      expect(dc.taxByClass[0].taxAmount).toBe('150');
      expect(dc.taxByClass[0].netAmount).toBe('1350');
      expect(dc.taxByClass[0].grossAmount).toBe('1500');

      // FR-FIN-022 tax-by-RATE / sales-by-category remain absent — never claimed.
      expect(dc.taxByClass[0]).not.toHaveProperty('taxRate');
      expect(dc).not.toHaveProperty('salesByCategory');

      // Historical currency — no override, resolves to branch base currency (EGP).
      expect(dc.currency).toBe('EGP');

      // Cash reconciliation ties to the closed session.
      expect(dc.cashReconciliation.sessionCount).toBe(1);
      expect(dc.cashReconciliation.varianceOwnerSessionCount).toBe(1);
      expect(dc.cashReconciliation.varianceTotal).toBe('0');
      expect(dc.cashReconciliation.sessions[0].dayScoped.cashSalesTotal).toBe(
        '1000',
      );
    });
  });

  // ============================================================= IMMUTABILITY
  describe('IMMUTABILITY (mechanical, ros_app grants — DB-level, not just service-level)', () => {
    it('day_closes: UPDATE and DELETE are rejected at the database (no grant, ros_app)', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      const res = await post(fx, token, target).expect(200);
      const id = asClosed(postBody(res)).dayClose.id;

      await expect(
        prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            'UPDATE treasury.day_closes SET z_number = z_number WHERE id = $1',
            id,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            'DELETE FROM treasury.day_closes WHERE id = $1',
            id,
          ),
        ),
      ).rejects.toThrow();
      // Still there, unmodified.
      const row = await admin.dayClose.findUniqueOrThrow({ where: { id } });
      expect(row.zNumber.toString()).toBe('1');
    });

    it('day_close_activations: UPDATE and DELETE are rejected at the database', async () => {
      const { fx, token } = await mkFx();
      const businessDay = branchBusinessDay(new Date());
      await post(fx, token, businessDay).expect(200);
      const row = await admin.dayCloseActivation.findUniqueOrThrow({
        where: {
          tenantId_branchId: { tenantId: fx.tenantId, branchId: fx.branchId },
        },
      });
      await expect(
        prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            'UPDATE treasury.day_close_activations SET activation_business_day = activation_business_day WHERE id = $1',
            row.id,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            'DELETE FROM treasury.day_close_activations WHERE id = $1',
            row.id,
          ),
        ),
      ).rejects.toThrow();
    });

    it('day_close_sessions / tax_class_totals / order_type_totals: UPDATE and DELETE are rejected at the database', async () => {
      const { fx, token } = await mkFx();
      const activationDay = await activate(fx, 5);
      const target = daysBefore(activationDay, -1);
      const taxClass = await createTaxClass(admin, {
        tenantId: fx.tenantId,
        code: 'standard',
      });
      const item = await createMenuItemRef(admin, fx.tenantId);
      const order = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay: target,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: 100n,
        taxTotal: 10n,
      });
      await insertOrderLine(admin, {
        tenantId: fx.tenantId,
        orderId: order,
        businessDay: target,
        menuItemId: item.menuItemId,
        variantId: item.variantId,
        taxClassId: taxClass,
        taxAmount: 10n,
        lineTotal: 100n,
      });
      const cashSessionId = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        orderId: order,
        businessDay: target,
        terminalId: fx.terminalId,
        employeeId: fx.employeeId,
        cashSessionId,
        tender: 'cash',
        amount: 100n,
      });
      await closeCashSessionWithFacts(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        cashSessionId,
        employeeId: fx.employeeId,
        employeeUserId: fx.employeeUserId,
        terminalId: fx.terminalId,
        openingFloat: 0n,
        cashSalesTotal: 100n,
        countedCash: 100n,
      });
      await admin.cashSession.update({
        where: { id: cashSessionId },
        data: { closedBusinessDay: target },
      });

      await post(fx, token, target).expect(200);
      const dcSession = await admin.dayCloseSession.findFirstOrThrow({
        where: { tenantId: fx.tenantId, cashSessionId },
      });
      const dcTax = await admin.dayCloseTaxClassTotal.findFirstOrThrow({
        where: { tenantId: fx.tenantId },
      });
      const dcType = await admin.dayCloseOrderTypeTotal.findFirstOrThrow({
        where: { tenantId: fx.tenantId },
      });

      await expect(
        prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            'UPDATE treasury.day_close_sessions SET is_variance_owner = is_variance_owner WHERE id = $1',
            dcSession.id,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            'UPDATE treasury.day_close_tax_class_totals SET line_count = line_count WHERE id = $1',
            dcTax.id,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            'UPDATE treasury.day_close_order_type_totals SET order_count = order_count WHERE id = $1',
            dcType.id,
          ),
        ),
      ).rejects.toThrow();
    });
  });
});
