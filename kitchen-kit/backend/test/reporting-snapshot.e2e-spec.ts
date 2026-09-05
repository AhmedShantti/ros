import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { BranchReportingScopeQueryService } from './../src/modules/organisation/branches/branch-reporting-scope.query.service';
import {
  BRANCH_REPORTING_SCOPE_QUERY,
  type BranchReportingScopeQuery,
  type BranchReportingScopeQueryInput,
} from './../src/modules/organisation/contract';
import { DailyTradingSalesQueryService } from './../src/modules/sales/orders/daily-trading-sales.query.service';
import {
  DAILY_TRADING_SALES_QUERY,
  type DailyTradingSalesFacts,
  type DailyTradingSalesQuery,
  type DailyTradingSalesQueryInput,
} from './../src/modules/sales/contract';
import { createMigratorClient } from './rls-admin';
import {
  branchBusinessDay,
  createCashSession,
  createReportingFixture,
  dashboardToken,
  dateStr,
  insertOrder,
  insertOrderPayment,
} from './reporting-fixtures';

interface ReportResponseBody {
  branchId: string;
  salesSummary: { grossSales: string; completedOrderCount: number };
  tenderTotals: { cash: { amountTotal: string } };
}

/**
 * Snapshot consistency — design gate §8/§13/§46 (Correction F: the branch
 * fail-closed assertion, `currentBusinessDay`, and every financial fact all
 * execute inside the SAME RepeatableRead transaction — no `ReportingBranchGuard`,
 * no second transaction, no TOCTOU window). Proven by INSTRUMENTATION (a
 * barrier-aware test double delaying one of the report's own mid-transaction
 * reads while a concurrent write commits), not by source inspection — the
 * same "test-only DI seam over an existing public-contract token" technique
 * `sales-fire-concurrency.e2e-spec.ts`/`order-completion-concurrency.e2e-spec.ts`
 * already establish in this repository. No `sleep` anywhere: every pause is
 * an explicit, deterministic Promise gate.
 */
describe('Reporting — Snapshot consistency (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let n = 0;
  function orderNumber(): string {
    n += 1;
    return `O-${n}`;
  }

  /** A one-shot, manually-released gate — simpler than a two-party barrier: only the report side needs to pause. */
  function makeGate(): {
    waitUntilPaused: () => Promise<void>;
    release: () => void;
    pauseHere: () => Promise<void>;
  } {
    let markPaused: () => void;
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    let markReleased: () => void;
    const released = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    return {
      waitUntilPaused: () => paused,
      release: () => markReleased(),
      pauseHere: async () => {
        markPaused();
        await released;
      },
    };
  }

  const realBranchScope = new BranchReportingScopeQueryService();
  class GatedBranchReportingScope implements BranchReportingScopeQuery {
    gate: ReturnType<typeof makeGate> | null = null;
    async operativeBranches(
      tx: Prisma.TransactionClient,
      input: BranchReportingScopeQueryInput,
    ) {
      return realBranchScope.operativeBranches(tx, input);
    }
    /**
     * B1-3 retired the single-active-branch mask; what the report still asserts
     * in-transaction is that THIS branch is operative. The gate moved with the
     * assertion, so this suite still proves the same property — the report's
     * branch fact is read inside its own RepeatableRead snapshot — about the
     * check that actually exists now.
     */
    async isOperativeBranch(
      tx: Prisma.TransactionClient,
      input: { tenantId: string; branchId: string },
    ) {
      if (this.gate) await this.gate.pauseHere();
      return realBranchScope.isOperativeBranch(tx, input);
    }
  }
  const branchScopeStub = new GatedBranchReportingScope();

  const realSalesQuery = new DailyTradingSalesQueryService();
  class GatedDailyTradingSalesQuery implements DailyTradingSalesQuery {
    gate: ReturnType<typeof makeGate> | null = null;
    async currentBusinessDay(
      tx: Prisma.TransactionClient,
      input: { tenantId: string; branchId: string },
    ) {
      return realSalesQuery.currentBusinessDay(tx, input);
    }
    async facts(
      tx: Prisma.TransactionClient,
      input: DailyTradingSalesQueryInput,
    ): Promise<DailyTradingSalesFacts> {
      if (this.gate) await this.gate.pauseHere();
      return realSalesQuery.facts(tx, input);
    }
  }
  const salesQueryStub = new GatedDailyTradingSalesQuery();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BRANCH_REPORTING_SCOPE_QUERY)
      .useValue(branchScopeStub)
      .overrideProvider(DAILY_TRADING_SALES_QUERY)
      .useValue(salesQueryStub)
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  afterEach(() => {
    branchScopeStub.gate = null;
    salesQueryStub.gate = null;
  });

  it("a branch DEACTIVATED concurrently mid-transaction never changes THIS report's own operative-branch answer (one RR snapshot for the whole request)", async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const businessDay = branchBusinessDay(new Date());
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);

    const gate = makeGate();
    branchScopeStub.gate = gate;

    // `Promise.resolve(thenable)` adopts a supertest `Test` by calling its
    // `.then()` immediately (Promise/A+), which is what actually DISPATCHES
    // the HTTP request — a supertest `Test` otherwise sends nothing until
    // awaited, which would leave `gate.waitUntilPaused()` below waiting
    // forever for a request that was never sent.
    const reportPromise = Promise.resolve(
      request(http)
        .get(
          `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
        )
        .set('Authorization', `Bearer ${token}`),
    );

    // The report's transaction has already taken its RR snapshot (dataAsOf +
    // branch-existence lookup both ran before this call) and is now paused
    // AT the single-active-branch read, mid-transaction.
    await gate.waitUntilPaused();

    // Concurrently DEACTIVATE the very branch being reported on — a genuinely
    // committed write from an INDEPENDENT connection, landing strictly after
    // this report's snapshot was taken. Before B1-3 the equivalent probe was
    // activating a SECOND branch; that no longer changes any answer, because the
    // tenant's branch COUNT stopped being an input when the Internal-MVP mask
    // was retired. Deactivating THIS branch is the write that would flip the
    // surviving assertion, so it is the one worth racing.
    await admin.branch.update({
      where: { id: fx.branchId },
      data: { status: 'inactive' },
    });
    await admin.$queryRaw`SELECT 1`; // force a round-trip so the write is durably visible to any NEW snapshot

    gate.release();
    const res = await reportPromise;

    // The report's own snapshot was fixed BEFORE the deactivation committed —
    // it must see the branch exactly as it was: active, 200.
    expect(res.status).toBe(200);
    expect((res.body as ReportResponseBody).branchId).toBe(fx.branchId);

    // Restore, so the fixture's branch is left as this suite found it.
    await admin.branch.update({
      where: { id: fx.branchId },
      data: { status: 'active' },
    });
  });

  it("a payment captured concurrently mid-transaction never appears in THIS report's own totals", async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const firstOrderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 111n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: firstOrderId,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 111n,
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const gate = makeGate();
    salesQueryStub.gate = gate;

    // `Promise.resolve(thenable)` adopts a supertest `Test` by calling its
    // `.then()` immediately (Promise/A+), which is what actually DISPATCHES
    // the HTTP request — a supertest `Test` otherwise sends nothing until
    // awaited, which would leave `gate.waitUntilPaused()` below waiting
    // forever for a request that was never sent.
    const reportPromise = Promise.resolve(
      request(http)
        .get(
          `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
        )
        .set('Authorization', `Bearer ${token}`),
    );

    await gate.waitUntilPaused();

    // A second, completed order + payment lands on the SAME branch/day from
    // an independent connection while the report's transaction is paused.
    const secondOrderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 222n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: secondOrderId,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 222n,
    });

    gate.release();
    const res = await reportPromise;

    expect(res.status).toBe(200);
    // Only the FIRST order's totals — the concurrently-committed second
    // order/payment must be entirely invisible to this one snapshot.
    const body = res.body as ReportResponseBody;
    expect(body.salesSummary.grossSales).toBe('111');
    expect(body.salesSummary.completedOrderCount).toBe(1);
    expect(body.tenderTotals.cash.amountTotal).toBe('111');
  });

  it('module-boundary sanity: the SAME transaction handle backs both the branch-scope read and the sales-facts read (single withAuthContext call)', async () => {
    // Instrumentation proof, not source inspection: record the `tx` object
    // identity seen by each stubbed contract call during one real request,
    // and assert they are the exact same Prisma transaction client.
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const businessDay = branchBusinessDay(new Date());
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);

    const seenTx: unknown[] = [];
    const originalBranchScope = branchScopeStub.isOperativeBranch.bind(
      branchScopeStub,
    ) as BranchReportingScopeQuery['isOperativeBranch'];
    const originalSalesFacts = salesQueryStub.facts.bind(
      salesQueryStub,
    ) as DailyTradingSalesQuery['facts'];
    branchScopeStub.isOperativeBranch = (tx, input) => {
      seenTx.push(tx);
      return originalBranchScope(tx, input);
    };
    salesQueryStub.facts = (tx, input) => {
      seenTx.push(tx);
      return originalSalesFacts(tx, input);
    };

    try {
      const res = await request(http)
        .get(
          `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
        )
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(seenTx).toHaveLength(2);
      expect(seenTx[0]).toBe(seenTx[1]);
    } finally {
      branchScopeStub.isOperativeBranch = originalBranchScope;
      salesQueryStub.facts = originalSalesFacts;
    }
  });
});
