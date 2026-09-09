import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  INVENTORY_PERMISSION_DEFS,
  INVENTORY_PERMISSIONS,
} from './../src/modules/inventory/inventory.permissions';
import {
  SALES_PERMISSION_DEFS,
  SALES_PERMISSIONS,
} from './../src/modules/sales/sales.permissions';
import { createMigratorClient } from './rls-admin';
import { DEV_PASSWORD, dashboardToken } from './reporting-fixtures';

/**
 * DEMO-POS-REASON-CODES-BACKEND-P0 — `GET /orders/reason-codes`.
 *
 * No country pack, no catalogue/pricing, no cash session: this route reads
 * ONLY `inventory.reason_codes` + the caller's own scoped authorization, so
 * none of that machinery is needed. `pos-financial-corrections.e2e-spec.ts`
 * (untouched by this slice) remains the authoritative, already-passing proof
 * that discount/comp/refund/post-fire-void mutations still enforce their own
 * action permission and reject a cross-tenant reasonCodeId (mission tests
 * I/H's mutation half) — re-run as regression, not duplicated here.
 */

const stamp = Date.now();
const PIN_CASHIER = '4141';
const PIN_SUPERVISOR = '4242';
const PIN_COMP_ONLY = '4343';
const PIN_NONE = '4444';

describe('POS reason codes (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let terminalA: string;

  let posCashierToken: string;
  let posSupervisorToken: string;
  let posCompOnlyToken: string;
  let posNoneToken: string;
  let dashboardInventoryToken: string;

  let reasonAdjustmentA: string;
  let reasonWasteA: string;
  let reasonAdjustmentB: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
    http = app.getHttpServer();
    admin = createMigratorClient(app);

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);
    const permissions = app.get(PermissionsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const pins = app.get(PinService);

    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of INVENTORY_PERMISSION_DEFS) await permissions.upsert(def);

    tenantA = (
      await tenants.create({
        slug: `prca-${stamp}`,
        legalName: 'PosReasonCodesA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `prcb-${stamp}`,
        legalName: 'PosReasonCodesB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brandA = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: 'PRC Brand' },
    });
    branchA = (
      await admin.branch.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          brandId: brandA.id,
          code: `PRC${stamp % 10000}`,
          name: 'PRC Branch',
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      })
    ).id;
    terminalA = (
      await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          name: 'PRC-POS-1',
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;

    // ── roles ───────────────────────────────────────────────────────────
    // True Cashier shape: reason-requiring actions minus post-fire void
    // (withheld by CLARIFICATION C — Shift-Supervisor-or-higher only).
    const cashierRole = await roles.createTenantRole(tenantA, {
      name: `prc_cashier_${stamp}`,
    });
    await roles.addPermissions(tenantA, cashierRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.DISCOUNT_APPLY,
      SALES_PERMISSIONS.COMP_APPLY,
      SALES_PERMISSIONS.REFUND_ISSUE,
      SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
    ]);
    const supervisorRole = await roles.createTenantRole(tenantA, {
      name: `prc_supervisor_${stamp}`,
    });
    await roles.addPermissions(tenantA, supervisorRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.DISCOUNT_APPLY,
      SALES_PERMISSIONS.COMP_APPLY,
      SALES_PERMISSIONS.REFUND_ISSUE,
      SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
      SALES_PERMISSIONS.ORDER_VOID_LINE_POSTFIRE,
    ]);
    // Holds exactly ONE of the five reason-requiring permissions (comp) —
    // proves the PER-PURPOSE check, not just the route's coarse
    // `RequireAnyPermission` gate.
    const compOnlyRole = await roles.createTenantRole(tenantA, {
      name: `prc_comp_only_${stamp}`,
    });
    await roles.addPermissions(tenantA, compOnlyRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.COMP_APPLY,
    ]);
    // Holds NONE of the five — fails even the route's coarse gate.
    const noneRole = await roles.createTenantRole(tenantA, {
      name: `prc_none_${stamp}`,
    });
    await roles.addPermissions(tenantA, noneRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
    ]);
    // Dashboard-only actor with real Inventory admin visibility — proves
    // GET /inventory/reason-codes itself is untouched (mission test F).
    const inventoryViewerRole = await roles.createTenantRole(tenantA, {
      name: `prc_inv_viewer_${stamp}`,
    });
    await roles.addPermissions(tenantA, inventoryViewerRole.id, [
      INVENTORY_PERMISSIONS.VIEW,
    ]);

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({
        email,
        password: DEV_PASSWORD,
        displayName: 'PRC',
      });
      const m = await memberships.grant(u.id, tenantId, 'active');
      return { userId: u.id, membershipId: m.id };
    };
    const assign = (membershipId: string, roleId: string) =>
      membershipRoles.create(tenantA, null, {
        membershipId,
        roleId,
        scope: { type: 'tenant' },
      });

    const cashier = await mkUser(`prc.cashier.${stamp}@example.com`, tenantA);
    await assign(cashier.membershipId, cashierRole.id);
    const supervisor = await mkUser(
      `prc.supervisor.${stamp}@example.com`,
      tenantA,
    );
    await assign(supervisor.membershipId, supervisorRole.id);
    const compOnly = await mkUser(`prc.componly.${stamp}@example.com`, tenantA);
    await assign(compOnly.membershipId, compOnlyRole.id);
    const none = await mkUser(`prc.none.${stamp}@example.com`, tenantA);
    await assign(none.membershipId, noneRole.id);
    const invViewer = await mkUser(`prc.invview.${stamp}@example.com`, tenantA);
    await assign(invViewer.membershipId, inventoryViewerRole.id);

    const employeeCashierCode = `PRCC${stamp % 1000}`;
    const employeeCashier = (
      await employees.create(tenantA, cashier.userId, {
        code: employeeCashierCode,
        displayName: 'PRC Cashier',
        homeBranchId: branchA,
        userId: cashier.userId,
      })
    ).id;
    const employeeSupervisorCode = `PRCS${stamp % 1000}`;
    const employeeSupervisor = (
      await employees.create(tenantA, cashier.userId, {
        code: employeeSupervisorCode,
        displayName: 'PRC Supervisor',
        homeBranchId: branchA,
        userId: supervisor.userId,
      })
    ).id;
    const employeeCompOnlyCode = `PRCO${stamp % 1000}`;
    const employeeCompOnly = (
      await employees.create(tenantA, cashier.userId, {
        code: employeeCompOnlyCode,
        displayName: 'PRC CompOnly',
        homeBranchId: branchA,
        userId: compOnly.userId,
      })
    ).id;
    const employeeNoneCode = `PRCN${stamp % 1000}`;
    const employeeNone = (
      await employees.create(tenantA, cashier.userId, {
        code: employeeNoneCode,
        displayName: 'PRC None',
        homeBranchId: branchA,
        userId: none.userId,
      })
    ).id;

    await pins.setPin(tenantA, cashier.userId, employeeCashier, PIN_CASHIER);
    await pins.setPin(
      tenantA,
      supervisor.userId,
      employeeSupervisor,
      PIN_SUPERVISOR,
    );
    await pins.setPin(
      tenantA,
      compOnly.userId,
      employeeCompOnly,
      PIN_COMP_ONLY,
    );
    await pins.setPin(tenantA, none.userId, employeeNone, PIN_NONE);

    const pinLogin = async (employeeCode: string, pin: string) => {
      const res = await request(http).post('/auth/pin').send({
        tenantId: tenantA,
        terminalId: terminalA,
        employeeCode,
        pin,
      });
      expect(res.status).toBe(200);
      return (res.body as { accessToken: string }).accessToken;
    };
    posCashierToken = await pinLogin(employeeCashierCode, PIN_CASHIER);
    posSupervisorToken = await pinLogin(employeeSupervisorCode, PIN_SUPERVISOR);
    posCompOnlyToken = await pinLogin(employeeCompOnlyCode, PIN_COMP_ONLY);
    posNoneToken = await pinLogin(employeeNoneCode, PIN_NONE);

    dashboardInventoryToken = await dashboardToken(
      http,
      `prc.invview.${stamp}@example.com`,
      tenantA,
    );

    // ── reason codes ────────────────────────────────────────────────────
    reasonAdjustmentA = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'adjustment',
          code: `MGR_DISC_${stamp}`,
          label: { en: 'Manager discount' },
        },
      })
    ).id;
    reasonWasteA = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'waste',
          code: `SPOILED_${stamp}`,
          label: { en: 'Spoiled / discarded' },
        },
      })
    ).id;
    reasonAdjustmentB = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          category: 'adjustment',
          code: `OTHER_${stamp}`,
          label: { en: 'Other tenant reason' },
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // -------------------------------------------------------- A / B ---
  describe('GET /orders/reason-codes', () => {
    it('A. Cashier (pos.refund.issue) can list refund reason codes', async () => {
      const res = await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'refund' })
        .set(auth(posCashierToken))
        .expect(200);
      const rows = res.body as { id: string; code: string; label: unknown }[];
      expect(rows.map((r) => r.id)).toContain(reasonAdjustmentA);
      // POS-safe shape only — no `category`, no tenantId, no admin fields.
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['code', 'id', 'label']);
      }
      // waste-category is Inventory-only and excluded from every POS purpose.
      expect(rows.map((r) => r.id)).not.toContain(reasonWasteA);
    });

    it('A2. Cashier can also list discount/comp/void-prefire reasons (each its own real permission)', async () => {
      for (const purpose of ['discount', 'comp', 'void_prefire']) {
        const res = await request(http)
          .get('/orders/reason-codes')
          .query({ purpose })
          .set(auth(posCashierToken))
          .expect(200);
        expect((res.body as { id: string }[]).map((r) => r.id)).toContain(
          reasonAdjustmentA,
        );
      }
    });

    it('B1. an actor holding NONE of the five permissions is denied (route-level gate)', async () => {
      await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'refund' })
        .set(auth(posNoneToken))
        .expect(403);
    });

    it('B2. an actor holding a DIFFERENT one of the five (comp, not refund) cannot list refund reasons', async () => {
      // Positive control first: this actor legitimately reads its OWN purpose.
      await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'comp' })
        .set(auth(posCompOnlyToken))
        .expect(200);
      // The same actor, same token, different purpose it holds no permission for.
      await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'refund' })
        .set(auth(posCompOnlyToken))
        .expect(403);
    });

    it('C. Shift-Supervisor-shaped actor (pos.order.void_line_postfire) can list void reasons', async () => {
      const res = await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'void_postfire' })
        .set(auth(posSupervisorToken))
        .expect(200);
      expect((res.body as { id: string }[]).map((r) => r.id)).toContain(
        reasonAdjustmentA,
      );
    });

    it('D. Cashier WITHOUT post-fire void permission cannot gain that read', async () => {
      await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'void_postfire' })
        .set(auth(posCashierToken))
        .expect(403);
    });

    it("H. never returns another tenant's reason code, for any purpose", async () => {
      const res = await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'refund' })
        .set(auth(posCashierToken))
        .expect(200);
      expect((res.body as { id: string }[]).map((r) => r.id)).not.toContain(
        reasonAdjustmentB,
      );
    });

    it('purpose is required — omitting it is a 400, not a silent default', async () => {
      await request(http)
        .get('/orders/reason-codes')
        .set(auth(posCashierToken))
        .expect(400);
    });

    it('an unrecognised purpose value is a 400', async () => {
      await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'not_a_real_purpose' })
        .set(auth(posCashierToken))
        .expect(400);
    });
  });

  // -------------------------------------------------------- E / F ---
  describe('GET /inventory/reason-codes — the admin route is unchanged', () => {
    it('E. a POS session cannot call it at all (FR-SEC-021, structural — never reaches PermissionGuard)', async () => {
      const res = await request(http)
        .get('/inventory/reason-codes')
        .set(auth(posCashierToken))
        .expect(403);
      expect(JSON.stringify(res.body)).toMatch(/PIN.*session/i);
    });

    it('F. a dashboard actor with inventory.view still reads the FULL admin shape (category included, waste included)', async () => {
      const res = await request(http)
        .get('/inventory/reason-codes')
        .set(auth(dashboardInventoryToken))
        .expect(200);
      const rows = res.body as {
        id: string;
        category: string;
        code: string;
        label: unknown;
      }[];
      expect(rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([reasonAdjustmentA, reasonWasteA]),
      );
      const waste = rows.find((r) => r.id === reasonWasteA)!;
      expect(waste.category).toBe('waste');
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          'category',
          'code',
          'id',
          'label',
        ]);
      }
    });

    it('F2. a dashboard actor WITHOUT inventory.view is still refused (unchanged)', async () => {
      const noViewToken = await dashboardToken(
        http,
        `prc.cashier.${stamp}@example.com`, // real user, but no inventory.view grant
        tenantA,
      );
      await request(http)
        .get('/inventory/reason-codes')
        .set(auth(noViewToken))
        .expect(403);
    });
  });

  // ----------------------------------------------------------- G ---
  describe('G. no inactive/deactivation lifecycle exists on ReasonCode', () => {
    it('has no isActive-shaped field anywhere in the persisted row (nothing to exclude on)', async () => {
      const row = await admin.reasonCode.findUniqueOrThrow({
        where: { id: reasonAdjustmentA },
      });
      // Exact column-set assertion, so a future migration adding lifecycle
      // state is a visible, deliberate change to this test, not a silent gap.
      expect(Object.keys(row).sort()).toEqual([
        'category',
        'code',
        'id',
        'label',
        'tenantId',
      ]);
    });

    it('every reason code the tenant holds is therefore always eligible — the read cannot filter on a lifecycle that does not exist', async () => {
      const res = await request(http)
        .get('/orders/reason-codes')
        .query({ purpose: 'discount' })
        .set(auth(posCashierToken))
        .expect(200);
      expect((res.body as { id: string }[]).map((r) => r.id)).toContain(
        reasonAdjustmentA,
      );
    });
  });
});
