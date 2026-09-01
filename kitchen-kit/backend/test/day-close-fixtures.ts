import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from '../src/common/ids';
import { PrismaClient } from '../src/generated/prisma/client';
import { MembershipRolesService } from '../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from '../src/modules/identity/authz/permissions.service';
import { RolesService } from '../src/modules/identity/authz/roles.service';
import { EmployeesService } from '../src/modules/identity/employees/employees.service';
import { PinService } from '../src/modules/identity/employees/pin.service';
import { MembershipsService } from '../src/modules/identity/memberships/memberships.service';
import { TenantsService } from '../src/modules/identity/tenants/tenants.service';
import { UsersService } from '../src/modules/identity/users/users.service';
import {
  REPORTING_PERMISSION_DEFS,
  REPORTING_PERMISSIONS,
} from '../src/modules/reporting/reporting.permissions';
import {
  TREASURY_PERMISSION_DEFS,
  TREASURY_PERMISSIONS,
} from '../src/modules/treasury/treasury.permissions';
import { createActiveBranch } from './reporting-fixtures';

/**
 * DayClose (migration 35) e2e bootstrap — mirrors `kds-fixtures.ts` /
 * `reporting-fixtures.ts`'s own bootstrap style. `createDayCloseFixture`
 * seeds a tenant/branch/terminal plus FOUR dashboard identities carrying
 * distinct permission subsets (full, day-close-only, financial-read-only,
 * sales-read-only, no-perms) so the POST/GET authorization matrix (items
 * 39-43 of the acceptance-completion task) can be proven without a second
 * bootstrap per case, plus one PIN-authenticated employee for the
 * POS-session acceptance case (item 44).
 *
 * `TREASURY_PERMISSIONS.REPORT_VIEW_FINANCIAL` and
 * `REPORTING_PERMISSIONS.VIEW_FINANCIAL` are DELIBERATELY the same
 * underlying code (`report.view.financial`, DC-R3) declared as two
 * literals in two modules — seeding via `REPORTING_PERMISSION_DEFS`
 * (Reporting owns the `PermissionDef` row) is correct and sufficient; the
 * DayClose controller's `@RequirePermission` checks the code string, not
 * which module declared it.
 */

export const DEV_PASSWORD = 's3cure-passphrase';

export interface DayCloseFixture {
  readonly tenantId: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly terminalId: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeUserId: string;
  readonly pin: string;
  /** cash.day.close + report.view.financial. */
  readonly fullEmail: string;
  /** cash.day.close only. */
  readonly dayCloseOnlyEmail: string;
  /** report.view.financial only. */
  readonly financialOnlyEmail: string;
  /** report.view.sales only (never authorizes DayClose). */
  readonly salesOnlyEmail: string;
  /** No treasury/reporting permission at all. */
  readonly noPermsEmail: string;
}

export async function createDayCloseFixture(
  app: INestApplication,
  admin: PrismaClient,
  seed: string,
): Promise<DayCloseFixture> {
  const tenants = app.get(TenantsService);
  const users = app.get(UsersService);
  const memberships = app.get(MembershipsService);
  const permissions = app.get(PermissionsService);
  const roles = app.get(RolesService);
  const membershipRoles = app.get(MembershipRolesService);
  const employees = app.get(EmployeesService);
  const pins = app.get(PinService);

  const tenant = await tenants.create({
    slug: `dc-${seed}`,
    legalName: `DayClose ${seed}`,
    defaultCurrency: 'EGP',
    countryPackCode: 'EG',
  });
  const tenantId = tenant.id;

  const brand = await admin.brand.create({
    data: { id: newId(), tenantId, name: `DayClose Brand ${seed}` },
  });
  const branchCode = `D${seed.slice(-6)}`;
  const branchId = await createActiveBranch(admin, tenantId, brand.id, seed);
  // `createActiveBranch` derives its own code from `seed`; force ours so the
  // fixture's returned `branchCode` always matches the persisted row.
  await admin.branch.update({
    where: { id: branchId },
    data: { code: branchCode },
  });

  const terminal = await admin.terminal.create({
    data: {
      id: newId(),
      tenantId,
      branchId,
      name: `POS-${seed}`,
      terminalType: 'pos',
      status: 'active',
    },
  });

  for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
  await permissions.upsertMany(REPORTING_PERMISSION_DEFS);

  const mkRole = async (name: string, codes: readonly string[]) => {
    const role = await roles.createTenantRole(tenantId, {
      name: `${name}_${seed}`,
    });
    if (codes.length > 0) {
      await roles.addPermissions(tenantId, role.id, [...codes]);
    }
    return role.id;
  };
  const fullRole = await mkRole('dc_full', [
    TREASURY_PERMISSIONS.CASH_DAY_CLOSE,
    REPORTING_PERMISSIONS.VIEW_FINANCIAL,
    // Only for the items-24/25 fixture, which proves closed_business_day
    // through the REAL cash-session-close HTTP pipeline (own permission,
    // unrelated to DayClose's own authorization matrix below).
    TREASURY_PERMISSIONS.CASH_SESSION_CLOSE,
  ]);
  const dayCloseOnlyRole = await mkRole('dc_close_only', [
    TREASURY_PERMISSIONS.CASH_DAY_CLOSE,
  ]);
  const financialOnlyRole = await mkRole('dc_financial_only', [
    REPORTING_PERMISSIONS.VIEW_FINANCIAL,
  ]);
  const salesOnlyRole = await mkRole('dc_sales_only', [
    REPORTING_PERMISSIONS.VIEW_SALES,
  ]);
  const noPermsRole = await mkRole('dc_no_perms', []);

  const mkDashboardUser = async (label: string, roleId: string) => {
    const email = `dc.${label}.${seed}@example.com`;
    const user = await users.createUser({
      email,
      password: DEV_PASSWORD,
      displayName: label,
    });
    const membership = await memberships.grant(user.id, tenantId, 'active');
    await membershipRoles.assign(tenantId, membership.id, roleId);
    return email;
  };
  const fullEmail = await mkDashboardUser('full', fullRole);
  const dayCloseOnlyEmail = await mkDashboardUser(
    'close-only',
    dayCloseOnlyRole,
  );
  const financialOnlyEmail = await mkDashboardUser(
    'fin-only',
    financialOnlyRole,
  );
  const salesOnlyEmail = await mkDashboardUser('sales-only', salesOnlyRole);
  const noPermsEmail = await mkDashboardUser('no-perms', noPermsRole);

  // ── the PIN-authenticated employee, granted the FULL role too — the POS
  //    session acceptance case (item 44) needs cash.day.close on a POS
  //    session; report.view.financial is never exercised over a PIN
  //    session by any test (DC-R3's GET route carries no `@AllowPosSession`
  //    and is refused for a PIN session regardless of permission). ────────
  const employeeUser = await users.createUser({
    email: `dc.emp.${seed}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Cashier',
  });
  const employeeMembership = await memberships.grant(
    employeeUser.id,
    tenantId,
    'active',
  );
  await membershipRoles.assign(tenantId, employeeMembership.id, fullRole);
  const employeeCode = `E${seed.slice(-6)}`;
  const employee = await employees.create(tenantId, employeeUser.id, {
    code: employeeCode,
    displayName: 'Cashier',
    homeBranchId: branchId,
    userId: employeeUser.id,
  });
  const pin = '7777';
  await pins.setPin(tenantId, employeeUser.id, employee.id, pin);

  return {
    tenantId,
    branchId,
    branchCode,
    terminalId: terminal.id,
    employeeId: employee.id,
    employeeCode,
    employeeUserId: employeeUser.id,
    pin,
    fullEmail,
    dayCloseOnlyEmail,
    financialOnlyEmail,
    salesOnlyEmail,
    noPermsEmail,
  };
}

export async function dashboardToken(
  http: App,
  email: string,
  tenantId: string,
): Promise<string> {
  const login = await request(http)
    .post('/auth/login')
    .send({ email, password: DEV_PASSWORD })
    .expect(200);
  const scoped = await request(http)
    .post('/auth/tenant')
    .set(
      'Authorization',
      `Bearer ${(login.body as { accessToken: string }).accessToken}`,
    )
    .send({ tenantId })
    .expect(200);
  return (scoped.body as { accessToken: string }).accessToken;
}

export async function pinToken(
  http: App,
  tenantId: string,
  terminalId: string,
  employeeCode: string,
  pin: string,
): Promise<string> {
  const res = await request(http)
    .post('/auth/pin')
    .send({ tenantId, terminalId, employeeCode, pin })
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Directly insert a `treasury.day_close_activations` row, bypassing the
 * real "first POST activates" ceremony (`DayCloseService.attempt()`,
 * ACTIVATION branch) — the same "direct insert, independent of the write
 * pipeline" fixture technique `reporting-fixtures.ts`'s
 * `closeCashSessionWithFacts` already establishes, chosen here for the
 * SAME reason: `DayCloseService`'s `currentBusinessDay` is undecorated
 * `resolveBusinessDay(new Date(), ...)` — real wall-clock, no injectable
 * clock — so a suite proving multi-day eligibility windows (items 8-11,
 * 24-35) needs an activation dated safely in the PAST relative to the
 * real "today" this process runs on, which no sequence of real POSTs can
 * produce inside a single test run. The activation-ceremony ITSELF (items
 * 1-7) is proven separately, through the real POST path, using the
 * fixture's natural "today" activation day.
 */
export async function activatePastEpoch(
  admin: PrismaClient,
  input: {
    tenantId: string;
    branchId: string;
    activatedByUserId: string;
    activationBusinessDay: Date;
  },
): Promise<void> {
  await admin.dayCloseActivation.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      activationBusinessDay: input.activationBusinessDay,
      activatedBy: input.activatedByUserId,
      activatedByEmployeeId: null,
    },
  });
}

export { dateStr, branchBusinessDay, daysBefore } from './reporting-fixtures';
