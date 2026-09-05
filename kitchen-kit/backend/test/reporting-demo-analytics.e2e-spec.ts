import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from '../src/common/ids';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';
import { MembershipRolesService } from '../src/modules/identity/authz/membership-roles.service';
import { RolesService } from '../src/modules/identity/authz/roles.service';
import { MembershipsService } from '../src/modules/identity/memberships/memberships.service';
import { UsersService } from '../src/modules/identity/users/users.service';
import { REPORTING_PERMISSIONS } from '../src/modules/reporting/reporting.permissions';
import {
  DEV_PASSWORD,
  branchBusinessDay,
  createActiveBranch,
  createCashSession,
  createReportingFixture,
  closeCashSessionWithFacts,
  dashboardToken,
  dateStr,
  insertCashMovement,
  insertOrder,
  insertOrderPayment,
} from './reporting-fixtures';

/**
 * RPT-DEMO-1 — Operational Analytics / Reporting Demo Pack.
 *
 * `GET /reports/branches/:branchId/overview` — the second Reporting route,
 * gated by the SAME `report.view.sales` + `report.view.financial` (AND)
 * permissions and the SAME `@AuthorizationTarget(branchFromParam('branchId'))`
 * as `daily-trading`.
 *
 * sales/cash reuse `DAILY_TRADING_SALES_QUERY`/`DAILY_CASH_RECONCILIATION_QUERY`
 * verbatim — the same facts `daily-trading` already exhaustively proves
 * (gross/net/discount/refund/tender/AOV formulas, comp exclusion, currency
 * resolution, WHOLE_SESSION cash scope) across
 * `reporting-sales.e2e-spec.ts`, `reporting-tender.e2e-spec.ts`,
 * `reporting-overpayment.e2e-spec.ts`, `reporting-cash-reconciliation.e2e-spec.ts`,
 * `reporting-currency.e2e-spec.ts`, `reporting-period.e2e-spec.ts`, and
 * `pos-financial-corrections.e2e-spec.ts` (discount/comp/refund exact-once
 * semantics) — all re-run as part of this task's regression, and none
 * re-duplicated here. This file proves TWO things those suites cannot:
 * (1) the new route composes the SAME sales/cash facts as `daily-trading`
 * for an identical fixture (cross-endpoint reconciliation), and (2) the
 * genuinely NEW inventory/workforce/kds sections and this route's own
 * multi-branch/tenant isolation.
 */
describe('Reporting — Operational Overview (RPT-DEMO-1, e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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

  let n = 0;
  function orderNumber(): string {
    n += 1;
    return `O-${stamp}-${n}`;
  }

  interface OverviewBody {
    branchId: string;
    businessDay: string;
    periodStatus: string;
    sales: {
      grossSales: string;
      netSales: string;
      discounts: string;
      refunds: string;
      taxTotal: string;
      completedOrderCount: number;
      averageOrderValue: string | null;
      tenderTotals: {
        cash: { amountTotal: string; paymentCount: number };
        manualExternalCard: { amountTotal: string; paymentCount: number };
        tenderGrandTotal: string;
      };
    };
    cash: {
      sessions: {
        cashSessionId: string;
        status: string;
        expectedCash: string | null;
        countedCash: string | null;
        variance: string | null;
        payInTotal: string;
        payOutTotal: string;
        safeDropTotal: string;
      }[];
      contributingSessionCount: number;
    };
    inventory: {
      lowStockItemCount: number;
      waste: { recordCount: number; quantityTotal: string; valueTotal: string };
    };
    workforce: {
      clockedInCount: number;
      attendanceRecordCount: number;
      lateArrivalCount: number;
      earlyDepartureCount: number;
      unscheduledCount: number;
      outsideGeofenceCount: number;
      missingClockOutCount: number;
    };
    kds: {
      ticketCount: number;
      statusCounts: Record<string, number>;
      measuredPrepDurationCount: number;
      averagePrepDurationSeconds: number | null;
    };
  }

  async function getOverview(
    token: string,
    branchId: string,
    businessDay: Date,
  ): Promise<{ status: number; body: OverviewBody }> {
    const res = await request(http)
      .get(`/reports/branches/${branchId}/overview`)
      .query({ businessDay: dateStr(businessDay) })
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body as OverviewBody };
  }

  async function getDailyTrading(
    token: string,
    branchId: string,
    businessDay: Date,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request(http)
      .get(
        `/reports/branches/${branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  // ── Inventory direct-insert fixture helpers ─────────────────────────────

  async function insertStockLevel(input: {
    tenantId: string;
    branchLocationId: string;
    onHand: string;
    reorderPoint?: string;
  }): Promise<string> {
    const uomId = newId();
    await admin.uom.create({
      data: {
        id: uomId,
        dimension: 'count',
        code: `U${uomId.slice(-8)}`,
        name: 'Unit',
        baseUnitOfDimension: true,
      },
    });
    const stockItemId = newId();
    await admin.stockItem.create({
      data: {
        id: stockItemId,
        tenantId: input.tenantId,
        sku: `SKU-${stockItemId.slice(-8)}`,
        names: { en: 'Test Item' },
        baseUnitId: uomId,
      },
    });
    await admin.stockLevel.create({
      data: {
        tenantId: input.tenantId,
        stockItemId,
        locationId: input.branchLocationId,
        quantityOnHand: input.onHand,
      },
    });
    if (input.reorderPoint) {
      await admin.stockItemReorderConfig.create({
        data: {
          id: newId(),
          tenantId: input.tenantId,
          stockItemId,
          locationId: input.branchLocationId,
          reorderPoint: input.reorderPoint,
        },
      });
    }
    return stockItemId;
  }

  async function insertWasteRecord(input: {
    tenantId: string;
    branchLocationId: string;
    recordedAt: Date;
    quantity: string;
    totalValue: bigint;
    recordedBy: string;
  }): Promise<void> {
    const reasonCodeId = newId();
    await admin.reasonCode.create({
      data: {
        id: reasonCodeId,
        tenantId: input.tenantId,
        category: 'waste',
        code: `WASTE-${reasonCodeId.slice(-6)}`,
        label: { en: 'Spoilage' },
      },
    });
    const uomId = newId();
    await admin.uom.create({
      data: {
        id: uomId,
        dimension: 'count',
        code: `U${uomId.slice(-8)}`,
        name: 'Unit',
        baseUnitOfDimension: true,
      },
    });
    const stockItemId = newId();
    await admin.stockItem.create({
      data: {
        id: stockItemId,
        tenantId: input.tenantId,
        sku: `SKU-${stockItemId.slice(-8)}`,
        names: { en: 'Waste Item' },
        baseUnitId: uomId,
      },
    });
    const wasteRecordId = newId();
    await admin.wasteRecord.create({
      data: {
        id: wasteRecordId,
        tenantId: input.tenantId,
        locationId: input.branchLocationId,
        reasonCodeId,
        totalValue: input.totalValue,
        recordedBy: input.recordedBy,
        recordedAt: input.recordedAt,
      },
    });
    await admin.wasteLine.create({
      data: {
        id: newId(),
        wasteRecordId,
        stockItemId,
        quantity: input.quantity,
        unitCost: 0n,
      },
    });
  }

  async function branchLocationId(
    tenantId: string,
    branchId: string,
  ): Promise<string> {
    const loc = await admin.location.findFirstOrThrow({
      where: { tenantId, branchId, locationType: 'branch' },
    });
    return loc.id;
  }

  // ── Workforce direct-insert fixture helper ──────────────────────────────

  async function insertAttendanceRecord(input: {
    tenantId: string;
    branchId: string;
    employeeId: string;
    clockInAt: Date;
    clockOutAt?: Date | null;
    status?: 'open' | 'closed';
    lateArrival?: boolean;
    earlyDeparture?: boolean;
    unscheduled?: boolean;
    outsideGeofence?: boolean;
    missingClockOut?: boolean;
  }): Promise<void> {
    await admin.attendanceRecord.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        branchId: input.branchId,
        employeeId: input.employeeId,
        status: input.status ?? 'open',
        clockInAt: input.clockInAt,
        clockOutAt: input.clockOutAt ?? null,
        lateArrival: input.lateArrival ?? false,
        earlyDeparture: input.earlyDeparture ?? false,
        unscheduled: input.unscheduled ?? false,
        outsideGeofence: input.outsideGeofence ?? false,
        missingClockOut: input.missingClockOut ?? false,
      },
    });
  }

  // ── KDS direct-insert fixture helper (Ticket only — no TicketLine needed) ──

  async function insertTicket(input: {
    tenantId: string;
    branchId: string;
    businessDay: Date;
    stationId: string;
    terminalId: string;
    openedBy: string;
    status:
      'queued' | 'in_progress' | 'ready' | 'bumped' | 'served' | 'recalled';
    startedAt?: Date | null;
    bumpedAt?: Date | null;
  }): Promise<void> {
    const orderId = newId();
    const num = orderNumber();
    await admin.order.create({
      data: {
        id: orderId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        terminalId: input.terminalId,
        orderNumber: num,
        businessDay: input.businessDay,
        orderType: 'dine_in',
        channel: 'pos',
        openedBy: input.openedBy,
        currency: 'EGP',
        openedAt: input.businessDay,
        originDeviceTime: input.businessDay,
        idempotencyKey: `idem-${orderId}`,
        countryPackVersion: 'v1',
      },
    });
    await admin.ticket.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        branchId: input.branchId,
        businessDay: input.businessDay,
        orderId,
        stationId: input.stationId,
        orderNumberSnapshot: num,
        orderTypeSnapshot: 'dine_in',
        status: input.status,
        createdAt: input.businessDay,
        routedAt: input.businessDay,
        startedAt: input.startedAt ?? null,
        bumpedAt: input.bumpedAt ?? null,
      },
    });
  }

  async function createStation(branchId: string): Promise<string> {
    const station = await admin.station.create({
      data: { id: newId(), branchId, name: `Station-${newId().slice(0, 6)}` },
    });
    return station.id;
  }

  // ── Multi-branch actor helper ───────────────────────────────────────────

  async function createBranchScopedActor(
    tenantId: string,
    branchIds: readonly string[],
    seed: string,
  ): Promise<string> {
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const role = await roles.createTenantRole(tenantId, {
      name: `mgr_${seed}`,
    });
    await roles.addPermissions(tenantId, role.id, [
      REPORTING_PERMISSIONS.VIEW_SALES,
      REPORTING_PERMISSIONS.VIEW_FINANCIAL,
    ]);
    const email = `mgr.${seed}@example.com`;
    const user = await users.createUser({
      email,
      password: DEV_PASSWORD,
      displayName: 'Manager',
    });
    const membership = await memberships.grant(user.id, tenantId, 'active');
    for (const branchId of branchIds) {
      await membershipRoles.create(tenantId, null, {
        membershipId: membership.id,
        roleId: role.id,
        scope: { type: 'branch', branchId },
      });
    }
    return email;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1-8: sales/cash reconcile against daily-trading (cross-endpoint proof)
  // ═══════════════════════════════════════════════════════════════════════

  it('sales/cash sections reconcile EXACTLY against the daily-trading route for the same fixture, including a large (>2^53) money value', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}rc`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      openingFloat: 5_000n,
    });

    // A large gross figure, beyond Number.MAX_SAFE_INTEGER (2^53 - 1), to
    // prove decimal-string serialization never round-trips through a float.
    const largeGross = 9_007_199_254_740_993n; // 2^53 + 1
    const c1 = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: largeGross,
      discountTotal: 500n,
      taxTotal: 300n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: c1,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: largeGross,
    });
    await insertCashMovement(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId,
      employeeId: fx.employeeId,
      performedByUserId: fx.dashboardUserId,
      movementType: 'pay_in',
      amount: 1_000n,
    });
    await insertCashMovement(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId,
      employeeId: fx.employeeId,
      performedByUserId: fx.dashboardUserId,
      movementType: 'pay_out',
      amount: 200n,
    });
    await insertCashMovement(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId,
      employeeId: fx.employeeId,
      performedByUserId: fx.dashboardUserId,
      movementType: 'safe_drop',
      amount: 300n,
    });
    await closeCashSessionWithFacts(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId,
      employeeId: fx.employeeId,
      employeeUserId: fx.dashboardUserId,
      terminalId: fx.terminalId,
      openingFloat: 5_000n,
      cashSalesTotal: largeGross,
      payInTotal: 1_000n,
      payOutTotal: 200n,
      safeDropTotal: 300n,
      countedCash: 5_000n + largeGross + 1_000n - 200n - 300n,
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const overview = await getOverview(token, fx.branchId, businessDay);
    const daily = await getDailyTrading(token, fx.branchId, businessDay);
    expect(overview.status).toBe(200);
    expect(daily.status).toBe(200);

    const dailyBody = daily.body as {
      salesSummary: {
        grossSales: string;
        discounts: string;
        refunds: string;
        taxTotal: string;
        netSales: string;
        completedOrderCount: number;
        averageOrderValue: string | null;
      };
      tenderTotals: { tenderGrandTotal: string };
      cashReconciliation: {
        sessions: {
          cashSessionId: string;
          expectedCash: string | null;
          countedCash: string | null;
          variance: string | null;
          payInTotal: string;
          payOutTotal: string;
          safeDropTotal: string;
        }[];
      };
    };

    // Item 1 — gross/net/order count exact-match against daily-trading.
    expect(overview.body.sales.grossSales).toBe(
      dailyBody.salesSummary.grossSales,
    );
    expect(overview.body.sales.grossSales).toBe(largeGross.toString());
    expect(overview.body.sales.netSales).toBe(dailyBody.salesSummary.netSales);
    expect(overview.body.sales.completedOrderCount).toBe(
      dailyBody.salesSummary.completedOrderCount,
    );
    // Item 2 — the discount is reflected exactly once (not doubled by reuse).
    expect(overview.body.sales.discounts).toBe(
      dailyBody.salesSummary.discounts,
    );
    expect(overview.body.sales.discounts).toBe('500');
    // Item 4 — refunds (0 here) reflected exactly once/identically.
    expect(overview.body.sales.refunds).toBe(dailyBody.salesSummary.refunds);
    // Item 5 — AOV matches.
    expect(overview.body.sales.averageOrderValue).toBe(
      dailyBody.salesSummary.averageOrderValue,
    );
    // Item 6 — tender breakdown reconciles.
    expect(overview.body.sales.tenderTotals.tenderGrandTotal).toBe(
      dailyBody.tenderTotals.tenderGrandTotal,
    );
    expect(overview.body.sales.tenderTotals.cash.amountTotal).toBe(
      largeGross.toString(),
    );

    // Item 7 — cash expected reconciles.
    const dailySession = dailyBody.cashReconciliation.sessions.find(
      (s) => s.cashSessionId === cashSessionId,
    )!;
    const overviewSession = overview.body.cash.sessions.find(
      (s) => s.cashSessionId === cashSessionId,
    )!;
    expect(overviewSession.expectedCash).toBe(dailySession.expectedCash);
    expect(overviewSession.countedCash).toBe(dailySession.countedCash);
    expect(overviewSession.variance).toBe(dailySession.variance);
    expect(overviewSession.variance).toBe('0');
    // Item 8 — pay-in/pay-out/safe-drop behavior correct.
    expect(overviewSession.payInTotal).toBe('1000');
    expect(overviewSession.payOutTotal).toBe('200');
    expect(overviewSession.safeDropTotal).toBe('300');
    expect(overviewSession.payInTotal).toBe(dailySession.payInTotal);
    expect(overviewSession.payOutTotal).toBe(dailySession.payOutTotal);
    expect(overviewSession.safeDropTotal).toBe(dailySession.safeDropTotal);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9-10: inventory — low-stock/waste correctness + branch isolation
  // ═══════════════════════════════════════════════════════════════════════

  it('inventory: low-stock count and waste totals are correct and branch-isolated', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}inv`);
    const branchB = await createActiveBranch(
      admin,
      fx.tenantId,
      fx.brandId,
      `${stamp}invb`,
    );
    const businessDay = branchBusinessDay(new Date());
    const locA = await branchLocationId(fx.tenantId, fx.branchId);
    const locB = await branchLocationId(fx.tenantId, branchB);

    // Branch A: one item below reorder point, one item AT/above (not low).
    await insertStockLevel({
      tenantId: fx.tenantId,
      branchLocationId: locA,
      onHand: '2',
      reorderPoint: '10',
    });
    await insertStockLevel({
      tenantId: fx.tenantId,
      branchLocationId: locA,
      onHand: '50',
      reorderPoint: '10',
    });
    // Branch B: two items below reorder point — must NOT leak into A's count.
    await insertStockLevel({
      tenantId: fx.tenantId,
      branchLocationId: locB,
      onHand: '1',
      reorderPoint: '5',
    });
    await insertStockLevel({
      tenantId: fx.tenantId,
      branchLocationId: locB,
      onHand: '0',
      reorderPoint: '5',
    });

    await insertWasteRecord({
      tenantId: fx.tenantId,
      branchLocationId: locA,
      recordedAt: new Date(businessDay.getTime() + 3_600_000),
      quantity: '4.5',
      totalValue: 1_200n,
      recordedBy: fx.dashboardUserId,
    });
    // Outside the business-day window — must be excluded.
    await insertWasteRecord({
      tenantId: fx.tenantId,
      branchLocationId: locA,
      recordedAt: new Date(businessDay.getTime() - 86_400_000 * 5),
      quantity: '99',
      totalValue: 999_999n,
      recordedBy: fx.dashboardUserId,
    });
    // Branch B waste — must NOT leak into A's total.
    await insertWasteRecord({
      tenantId: fx.tenantId,
      branchLocationId: locB,
      recordedAt: new Date(businessDay.getTime() + 3_600_000),
      quantity: '77',
      totalValue: 77_000n,
      recordedBy: fx.dashboardUserId,
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const overviewA = await getOverview(token, fx.branchId, businessDay);
    expect(overviewA.status).toBe(200);
    expect(overviewA.body.inventory.lowStockItemCount).toBe(1);
    expect(overviewA.body.inventory.waste.recordCount).toBe(1);
    expect(overviewA.body.inventory.waste.quantityTotal).toBe('4.5');
    expect(overviewA.body.inventory.waste.valueTotal).toBe('1200');

    const overviewB = await getOverview(token, branchB, businessDay);
    expect(overviewB.status).toBe(200);
    expect(overviewB.body.inventory.lowStockItemCount).toBe(2);
    expect(overviewB.body.inventory.waste.recordCount).toBe(1);
    expect(overviewB.body.inventory.waste.valueTotal).toBe('77000');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11-12: workforce attendance metrics + anomaly flag counts
  // ═══════════════════════════════════════════════════════════════════════

  it('workforce: attendance metrics and anomaly flag counts are correct', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}wf`);
    const businessDay = branchBusinessDay(new Date());
    const inWindow = new Date(businessDay.getTime() + 3_600_000);
    const outOfWindow = new Date(businessDay.getTime() - 86_400_000 * 3);

    // Still clocked in (live gauge) — status open, in-window clock-in.
    await insertAttendanceRecord({
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      clockInAt: inWindow,
      status: 'open',
      lateArrival: true,
    });
    // Closed record, in window, multiple flags set.
    await insertAttendanceRecord({
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      clockInAt: inWindow,
      clockOutAt: new Date(inWindow.getTime() + 3_600_000),
      status: 'closed',
      earlyDeparture: true,
      unscheduled: true,
      outsideGeofence: true,
      missingClockOut: true,
    });
    // Outside the requested day's window — must be excluded from the counts.
    await insertAttendanceRecord({
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      clockInAt: outOfWindow,
      clockOutAt: new Date(outOfWindow.getTime() + 3_600_000),
      status: 'closed',
      lateArrival: true,
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const overview = await getOverview(token, fx.branchId, businessDay);
    expect(overview.status).toBe(200);
    expect(overview.body.workforce.clockedInCount).toBe(1);
    expect(overview.body.workforce.attendanceRecordCount).toBe(2);
    expect(overview.body.workforce.lateArrivalCount).toBe(1);
    expect(overview.body.workforce.earlyDepartureCount).toBe(1);
    expect(overview.body.workforce.unscheduledCount).toBe(1);
    expect(overview.body.workforce.outsideGeofenceCount).toBe(1);
    expect(overview.body.workforce.missingClockOutCount).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13: KDS ticket count / status counts / average prep duration
  // ═══════════════════════════════════════════════════════════════════════

  it('kds: ticket count, status counts, and average prep duration are correct', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}kds`);
    const businessDay = branchBusinessDay(new Date());
    const stationId = await createStation(fx.branchId);

    const started1 = businessDay;
    const bumped1 = new Date(started1.getTime() + 120_000); // 120s
    await insertTicket({
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      businessDay,
      stationId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      status: 'bumped',
      startedAt: started1,
      bumpedAt: bumped1,
    });
    const started2 = businessDay;
    const bumped2 = new Date(started2.getTime() + 80_000); // 80s
    await insertTicket({
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      businessDay,
      stationId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      status: 'bumped',
      startedAt: started2,
      bumpedAt: bumped2,
    });
    // Still in progress — no bumpedAt, must not enter the duration average.
    await insertTicket({
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      businessDay,
      stationId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      status: 'in_progress',
      startedAt: businessDay,
    });
    await insertTicket({
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      businessDay,
      stationId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      status: 'queued',
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const overview = await getOverview(token, fx.branchId, businessDay);
    expect(overview.status).toBe(200);
    expect(overview.body.kds.ticketCount).toBe(4);
    expect(overview.body.kds.statusCounts.bumped).toBe(2);
    expect(overview.body.kds.statusCounts.in_progress).toBe(1);
    expect(overview.body.kds.statusCounts.queued).toBe(1);
    expect(overview.body.kds.measuredPrepDurationCount).toBe(2);
    expect(overview.body.kds.averagePrepDurationSeconds).toBe(100); // (120+80)/2
  });

  it('kds: zero tickets omits no fields and reports a real null (not a fabricated) average', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}kdsz`);
    const businessDay = branchBusinessDay(new Date());
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const overview = await getOverview(token, fx.branchId, businessDay);
    expect(overview.status).toBe(200);
    expect(overview.body.kds.ticketCount).toBe(0);
    expect(overview.body.kds.measuredPrepDurationCount).toBe(0);
    expect(overview.body.kds.averagePrepDurationSeconds).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14-18: multi-branch / multi-tenant authorization (P0)
  // ═══════════════════════════════════════════════════════════════════════

  describe('multi-branch/tenant authorization', () => {
    it('A1-only manager can report A1 but not A2; A1+A2 manager can report both; tenant owner can report both; Tenant B never appears', async () => {
      const fx = await createReportingFixture(app, admin, `${stamp}mb`);
      const branchA2 = await createActiveBranch(
        admin,
        fx.tenantId,
        fx.brandId,
        `${stamp}mba2`,
      );
      const businessDay = branchBusinessDay(new Date());

      // Distinct, hand-verifiable gross sales per branch.
      const cashSessionA1 = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        employeeId: fx.employeeId,
      });
      const orderA1 = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: 11_000n,
        taxTotal: 0n,
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        orderId: orderA1,
        businessDay,
        terminalId: fx.terminalId,
        employeeId: fx.employeeId,
        cashSessionId: cashSessionA1,
        tender: 'cash',
        amount: 11_000n,
      });

      const terminalA2 = await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: fx.tenantId,
          branchId: branchA2,
          name: `POS-${stamp}a2`,
          terminalType: 'pos',
          status: 'active',
        },
      });
      const cashSessionA2 = await createCashSession(admin, {
        tenantId: fx.tenantId,
        branchId: branchA2,
        employeeId: fx.employeeId,
      });
      const orderA2 = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: branchA2,
        terminalId: terminalA2.id,
        openedBy: fx.employeeId,
        businessDay,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: 22_000n,
        taxTotal: 0n,
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: branchA2,
        orderId: orderA2,
        businessDay,
        terminalId: terminalA2.id,
        employeeId: fx.employeeId,
        cashSessionId: cashSessionA2,
        tender: 'cash',
        amount: 22_000n,
      });

      const a1OnlyEmail = await createBranchScopedActor(
        fx.tenantId,
        [fx.branchId],
        `${stamp}a1only`,
      );
      const bothEmail = await createBranchScopedActor(
        fx.tenantId,
        [fx.branchId, branchA2],
        `${stamp}both`,
      );

      const a1OnlyToken = await dashboardToken(http, a1OnlyEmail, fx.tenantId);
      const bothToken = await dashboardToken(http, bothEmail, fx.tenantId);
      // `createReportingFixture`'s own dashboard user is a TENANT-scoped
      // grant — the tenant owner for this test.
      const ownerToken = await dashboardToken(
        http,
        fx.dashboardEmail,
        fx.tenantId,
      );

      // Item 14 — A1-only manager: can report A1.
      const a1OnlyReadsA1 = await getOverview(
        a1OnlyToken,
        fx.branchId,
        businessDay,
      );
      expect(a1OnlyReadsA1.status).toBe(200);
      expect(a1OnlyReadsA1.body.sales.grossSales).toBe('11000');
      // Item 14 — A1-only manager: CANNOT report A2.
      const a1OnlyReadsA2 = await getOverview(
        a1OnlyToken,
        branchA2,
        businessDay,
      );
      expect(a1OnlyReadsA2.status).toBe(403);

      // Item 16 — A1+A2 manager: can report both individually.
      const bothReadsA1 = await getOverview(
        bothToken,
        fx.branchId,
        businessDay,
      );
      expect(bothReadsA1.status).toBe(200);
      expect(bothReadsA1.body.sales.grossSales).toBe('11000');
      const bothReadsA2 = await getOverview(bothToken, branchA2, businessDay);
      expect(bothReadsA2.status).toBe(200);
      expect(bothReadsA2.body.sales.grossSales).toBe('22000');

      // Item 17 — tenant owner: can report both.
      const ownerReadsA1 = await getOverview(
        ownerToken,
        fx.branchId,
        businessDay,
      );
      expect(ownerReadsA1.status).toBe(200);
      const ownerReadsA2 = await getOverview(ownerToken, branchA2, businessDay);
      expect(ownerReadsA2.status).toBe(200);

      // Item 18 — Tenant B never appears in Tenant A results: a Tenant-B
      // actor addressing Tenant A's branchId gets a byte-identical 404
      // (tenant-safe non-enumeration), never a 200 with A's data.
      const fxB = await createReportingFixture(app, admin, `${stamp}mbB`);
      const tenantBToken = await dashboardToken(
        http,
        fxB.dashboardEmail,
        fxB.tenantId,
      );
      const crossTenantRead = await getOverview(
        tenantBToken,
        fx.branchId,
        businessDay,
      );
      expect(crossTenantRead.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 19: zero-data branch returns valid zero/empty structures
  // ═══════════════════════════════════════════════════════════════════════

  it('a branch with zero data of every kind returns valid zero/empty structures, not an error', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}zero`);
    const businessDay = branchBusinessDay(new Date());
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);

    const overview = await getOverview(token, fx.branchId, businessDay);
    expect(overview.status).toBe(200);
    expect(overview.body.sales.grossSales).toBe('0');
    expect(overview.body.sales.completedOrderCount).toBe(0);
    expect(overview.body.sales.averageOrderValue).toBeNull();
    expect(overview.body.cash.sessions).toEqual([]);
    expect(overview.body.cash.contributingSessionCount).toBe(0);
    expect(overview.body.inventory.lowStockItemCount).toBe(0);
    expect(overview.body.inventory.waste.recordCount).toBe(0);
    expect(overview.body.inventory.waste.quantityTotal).toBe('0');
    expect(overview.body.inventory.waste.valueTotal).toBe('0');
    expect(overview.body.workforce.clockedInCount).toBe(0);
    expect(overview.body.workforce.attendanceRecordCount).toBe(0);
    expect(overview.body.kds.ticketCount).toBe(0);
    expect(overview.body.kds.averagePrepDurationSeconds).toBeNull();
    expect(overview.body.periodStatus).toBe('OPEN');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 20: covered above — the large-money-value assertion in the first test.
  // ═══════════════════════════════════════════════════════════════════════

  // ── Cheap authorization insurance (mirrors daily-trading's own coverage;
  //    reporting-authorization.e2e-spec.ts proves the generic guard chain
  //    behavior this route reuses verbatim) ────────────────────────────────

  it('403s without report.view.financial; 404s for a foreign/unknown branchId', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}auth`, [
      REPORTING_PERMISSIONS.VIEW_SALES,
    ]);
    const businessDay = branchBusinessDay(new Date());
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);

    const missingPerm = await getOverview(token, fx.branchId, businessDay);
    expect(missingPerm.status).toBe(403);

    const fxFull = await createReportingFixture(app, admin, `${stamp}auth2`);
    const fullToken = await dashboardToken(
      http,
      fxFull.dashboardEmail,
      fxFull.tenantId,
    );
    const unknownBranch = await getOverview(fullToken, newId(), businessDay);
    expect(unknownBranch.status).toBe(404);
  });
});
