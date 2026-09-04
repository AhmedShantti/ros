import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../modules/identity/tenants/tenants.service';
import { UsersService } from '../modules/identity/users/users.service';
import { MembershipsService } from '../modules/identity/memberships/memberships.service';
import { RolesService } from '../modules/identity/authz/roles.service';
import { MembershipRolesService } from '../modules/identity/authz/membership-roles.service';
import { PermissionsService } from '../modules/identity/authz/permissions.service';
import {
  IDENTITY_PERMISSIONS,
  IDENTITY_PERMISSION_DEFS,
} from '../modules/identity/authz/permissions.constants';
import { EmployeesService } from '../modules/identity/employees/employees.service';
import { PinService } from '../modules/identity/employees/pin.service';
import { TerminalsService } from '../modules/identity/terminals/terminals.service';
import { BrandsService } from '../modules/organisation/brands/brands.service';
import { BranchesService } from '../modules/organisation/branches/branches.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from '../modules/organisation/organisation.permissions';
import { MenusService } from '../modules/catalogue/menus/menus.service';
import { CategoriesService } from '../modules/catalogue/categories/categories.service';
import { MenuItemsService } from '../modules/catalogue/menu-items/menu-items.service';
import { PriceListsService } from '../modules/catalogue/price-lists/price-lists.service';
import {
  CATALOGUE_PERMISSIONS,
  CATALOGUE_PERMISSION_DEFS,
} from '../modules/catalogue/catalogue.permissions';
import {
  INVENTORY_PERMISSIONS,
  INVENTORY_PERMISSION_DEFS,
} from '../modules/inventory/inventory.permissions';
import {
  PRODUCTION_PERMISSIONS,
  PRODUCTION_PERMISSION_DEFS,
} from '../modules/production/production.permissions';
import {
  SALES_PERMISSIONS,
  SALES_PERMISSION_DEFS,
} from '../modules/sales/sales.permissions';
import {
  TREASURY_PERMISSIONS,
  TREASURY_PERMISSION_DEFS,
} from '../modules/treasury/treasury.permissions';
import {
  KDS_PERMISSIONS,
  KDS_PERMISSION_DEFS,
} from '../modules/kitchen/kitchen.permissions';
import {
  REPORTING_PERMISSIONS,
  REPORTING_PERMISSION_DEFS,
} from '../modules/reporting/reporting.permissions';
import {
  AUDIT_PERMISSIONS,
  AUDIT_PERMISSION_DEFS,
} from '../modules/governance/audit/audit.permissions';
import {
  WORKFORCE_PERMISSIONS,
  WORKFORCE_PERMISSION_DEFS,
} from '../modules/workforce/workforce.permissions';

/**
 * One-shot local-dev/demo data seeder — NOT wired to any HTTP route, run
 * manually:
 *
 *   nest build && node dist/scripts/seed-dev-data.js
 *
 * MTMB-1: builds the exact two-tenant, multi-branch demo shape by calling
 * the same service layer the controllers call — not raw SQL — so every
 * invariant (RLS, scoped RBAC, audit trail, password policy, PIN
 * uniqueness) is enforced exactly as it would be for a real signup:
 *
 *   Demo Restaurant Group (Tenant A) ── Brand ── Downtown (DOWNTOWN)
 *                                             └─ Airport (AIRPORT)
 *   Second Demo Tenant   (Tenant B) ── Brand ── Main     (MAIN)
 *
 * Actors seeded: a Tenant A owner (TENANT scope), a Downtown-only manager
 * (BRANCH scope Downtown), a multi-branch manager (BRANCH scope Downtown +
 * Airport), a Downtown POS employee (PIN login, home branch Downtown), and
 * a Tenant B owner (TENANT scope on Tenant B, isolated from Tenant A). One
 * POS terminal is registered per operational branch (Downtown, Airport,
 * Main).
 *
 * Safe to re-run: every tenant/user is timestamp-suffixed, so each run
 * creates fresh, independent tenants rather than colliding with a previous
 * run.
 *
 * Writes `credentials.md` (repo root of this package) with every login this
 * run created. That file is local dev output, not application code — do not
 * commit it.
 */

const DEV_PASSWORD = 'DevPass123!';
const DEV_PIN = '1234';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const prisma = app.get(PrismaService);
  const tenants = app.get(TenantsService);
  const users = app.get(UsersService);
  const memberships = app.get(MembershipsService);
  const roles = app.get(RolesService);
  const membershipRoles = app.get(MembershipRolesService);
  const permissions = app.get(PermissionsService);
  const employees = app.get(EmployeesService);
  const pins = app.get(PinService);
  const terminals = app.get(TerminalsService);
  const brands = app.get(BrandsService);
  const branches = app.get(BranchesService);
  const menus = app.get(MenusService);
  const categories = app.get(CategoriesService);
  const menuItems = app.get(MenuItemsService);
  const priceLists = app.get(PriceListsService);

  const stamp = Date.now();

  // ---------------------------------------------------------- permissions --
  await permissions.upsertMany([
    ...IDENTITY_PERMISSION_DEFS,
    ...SALES_PERMISSION_DEFS,
    ...CATALOGUE_PERMISSION_DEFS,
    ...INVENTORY_PERMISSION_DEFS,
    ...ORGANISATION_PERMISSION_DEFS,
    ...PRODUCTION_PERMISSION_DEFS,
    ...TREASURY_PERMISSION_DEFS,
    ...KDS_PERMISSION_DEFS,
    ...REPORTING_PERMISSION_DEFS,
    ...AUDIT_PERMISSION_DEFS,
    ...WORKFORCE_PERMISSION_DEFS,
  ]);

  // ================================================== TENANT A: Demo Group ==
  const tenantA = await tenants.create({
    slug: `demo-restaurant-group-${stamp}`,
    legalName: 'Demo Restaurant Group',
    defaultCurrency: 'EGP',
    countryPackCode: 'EG', // real, activated fixture pack -> tax classes auto-provisioned
  });

  const ownerA = await users.createUser({
    email: `owner.a.${stamp}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Demo Group Owner',
  });
  const managerDowntown = await users.createUser({
    email: `manager.downtown.${stamp}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Downtown Manager',
  });
  const managerMultiBranch = await users.createUser({
    email: `manager.multibranch.${stamp}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Multi-Branch Manager',
  });
  const posUser = await users.createUser({
    email: `cashier.downtown.${stamp}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Downtown Cashier',
  });

  const ownerAMembership = await memberships.grant(
    ownerA.id,
    tenantA.id,
    'active',
  );
  const managerDowntownMembership = await memberships.grant(
    managerDowntown.id,
    tenantA.id,
    'active',
  );
  const managerMultiBranchMembership = await memberships.grant(
    managerMultiBranch.id,
    tenantA.id,
    'active',
  );
  const posUserMembership = await memberships.grant(
    posUser.id,
    tenantA.id,
    'active',
  );

  // ----------------------------------------------------------------- roles --
  const ownerRole = await roles.createTenantRole(tenantA.id, {
    name: 'Owner',
    description: 'Full access — seeded demo role.',
  });
  await roles.addPermissions(tenantA.id, ownerRole.id, [
    ...Object.values(IDENTITY_PERMISSIONS),
    ...Object.values(SALES_PERMISSIONS),
    ...Object.values(CATALOGUE_PERMISSIONS),
    ...Object.values(INVENTORY_PERMISSIONS),
    ...Object.values(ORGANISATION_PERMISSIONS),
    ...Object.values(PRODUCTION_PERMISSIONS),
    ...Object.values(TREASURY_PERMISSIONS),
    ...Object.values(KDS_PERMISSIONS),
    ...Object.values(REPORTING_PERMISSIONS),
    ...Object.values(AUDIT_PERMISSIONS),
    ...Object.values(WORKFORCE_PERMISSIONS),
  ]);
  // B1-2: scope is MANDATORY and never defaulted. The demo seed grants
  // TENANT scope explicitly, which is what this bootstrap role means.
  await membershipRoles.create(tenantA.id, ownerA.id, {
    membershipId: ownerAMembership.id,
    roleId: ownerRole.id,
    scope: { type: 'tenant' },
  });

  // Branch Manager: the day-to-day operating role, granted at BRANCH scope
  // to different actors so one role proves FR-SEC-003 (an actor may hold
  // several independent scoped assignments) rather than needing two roles.
  const managerRole = await roles.createTenantRole(tenantA.id, {
    name: 'Branch Manager',
    description: 'Branch-scoped operations — seeded demo role.',
  });
  await roles.addPermissions(tenantA.id, managerRole.id, [
    ORGANISATION_PERMISSIONS.BRANCH_READ,
    ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    SALES_PERMISSIONS.ORDER_CREATE,
    SALES_PERMISSIONS.ORDER_FIRE,
    SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
    CATALOGUE_PERMISSIONS.ITEM_READ,
    CATALOGUE_PERMISSIONS.PRICE_READ,
    CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
    INVENTORY_PERMISSIONS.VIEW,
    INVENTORY_PERMISSIONS.ADJUST,
    TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW,
    WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE,
    REPORTING_PERMISSIONS.VIEW_SALES,
    REPORTING_PERMISSIONS.VIEW_FINANCIAL,
  ]);

  const cashierRole = await roles.createTenantRole(tenantA.id, {
    name: 'Cashier',
    description: 'POS order capture — seeded demo role.',
  });
  await roles.addPermissions(tenantA.id, cashierRole.id, [
    SALES_PERMISSIONS.ORDER_CREATE,
    // P1E-6A: the 2026-08-24 Fire Authorization Ratification names Cashier
    // as a role that receives pos.order.fire as policy. This dev seed is a
    // local-only convenience role, not the shipped standard-role grant
    // FR-SEC-010 still requires — granting it here just lets the seeded
    // demo Cashier actually exercise Fire locally.
    SALES_PERMISSIONS.ORDER_FIRE,
    SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
    CATALOGUE_PERMISSIONS.ITEM_READ,
    CATALOGUE_PERMISSIONS.PRICE_READ,
    CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
  ]);
  // Tenant-scope assignment: PIN sign-in's own branch restriction comes from
  // Employee.homeBranchId / EmployeeBranch (below), a separate narrowing
  // mechanism — not from the RBAC scope lattice.
  await membershipRoles.create(tenantA.id, ownerA.id, {
    membershipId: posUserMembership.id,
    roleId: cashierRole.id,
    scope: { type: 'tenant' },
  });

  // ------------------------------------------------------ brand / branches --
  const brandA = await brands.create(tenantA.id, ownerA.id, {
    name: 'Demo Restaurant Group',
  });
  const branchDowntown = await branches.create(tenantA.id, ownerA.id, {
    brandId: brandA.id,
    code: 'DOWNTOWN',
    name: 'Downtown',
    timezone: 'Africa/Cairo',
    baseCurrency: 'EGP',
    countryCode: 'EG',
  });
  const branchAirport = await branches.create(tenantA.id, ownerA.id, {
    brandId: brandA.id,
    code: 'AIRPORT',
    name: 'Airport',
    timezone: 'Africa/Cairo',
    baseCurrency: 'EGP',
    countryCode: 'EG',
  });

  await membershipRoles.create(tenantA.id, ownerA.id, {
    membershipId: managerDowntownMembership.id,
    roleId: managerRole.id,
    scope: { type: 'branch', branchId: branchDowntown.id },
  });
  await membershipRoles.create(tenantA.id, ownerA.id, {
    membershipId: managerMultiBranchMembership.id,
    roleId: managerRole.id,
    scope: { type: 'branch', branchId: branchDowntown.id },
  });
  await membershipRoles.create(tenantA.id, ownerA.id, {
    membershipId: managerMultiBranchMembership.id,
    roleId: managerRole.id,
    scope: { type: 'branch', branchId: branchAirport.id },
  });

  // -------------------------------------------------------------- terminals --
  const terminalDowntown = await terminals.register(tenantA.id, {
    name: 'POS-Downtown',
    terminalType: 'pos',
    branchId: branchDowntown.id,
  });
  const terminalAirport = await terminals.register(tenantA.id, {
    name: 'POS-Airport',
    terminalType: 'pos',
    branchId: branchAirport.id,
  });

  // -------------------------------------------------------------- employee --
  const employee = await employees.create(tenantA.id, ownerA.id, {
    code: 'EMP001',
    displayName: 'Downtown Cashier',
    homeBranchId: branchDowntown.id,
    userId: posUser.id,
  });
  await pins.setPin(tenantA.id, ownerA.id, employee.id, DEV_PIN);

  // --------------------------------------------------------------- catalogue --
  const taxClass = await prisma.withAuthContext(
    { tenantId: tenantA.id },
    (tx) =>
      tx.taxClass.findFirst({
        where: { tenantId: tenantA.id, code: 'standard' },
      }),
  );

  const menu = await menus.create(tenantA.id, ownerA.id, {
    name: { en: 'Main Menu', ar: 'القائمة الرئيسية' },
    orderTypes: ['dine_in', 'takeaway'],
  });
  await menus.assignBranch(tenantA.id, ownerA.id, menu.id, branchDowntown.id);
  await menus.assignBranch(tenantA.id, ownerA.id, menu.id, branchAirport.id);

  const category = await categories.create(tenantA.id, ownerA.id, menu.id, {
    name: { en: 'Burgers', ar: 'برجر' },
  });

  const item = await menuItems.create(tenantA.id, ownerA.id, {
    names: { en: 'Classic Burger', ar: 'برجر كلاسيك' },
    ...(taxClass ? { taxClassId: taxClass.id } : {}),
  });
  await menuItems.place(tenantA.id, ownerA.id, item.id, category.id);
  const variant = await menuItems.addVariant(tenantA.id, ownerA.id, item.id, {
    name: { en: 'Regular', ar: 'عادي' },
  });

  const priceList = await priceLists.create(tenantA.id, ownerA.id, {
    name: 'Standard Pricing',
    scopeType: 'brand',
    scopeId: brandA.id,
  });
  await priceLists.setPriceEntry(tenantA.id, ownerA.id, priceList.id, {
    menuItemVariantId: variant.id,
    price: '25000', // 250.00 EGP, minor units
    currency: 'EGP',
  });
  await priceLists.activate(tenantA.id, ownerA.id, priceList.id);

  // ============================================ TENANT B: Second Demo Tenant ==
  const tenantB = await tenants.create({
    slug: `second-demo-tenant-${stamp}`,
    legalName: 'Second Demo Tenant',
    defaultCurrency: 'EGP',
    countryPackCode: 'EG',
  });

  const ownerB = await users.createUser({
    email: `owner.b.${stamp}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Second Tenant Owner',
  });
  const ownerBMembership = await memberships.grant(
    ownerB.id,
    tenantB.id,
    'active',
  );

  const ownerRoleB = await roles.createTenantRole(tenantB.id, {
    name: 'Owner',
    description: 'Full access — seeded demo role.',
  });
  await roles.addPermissions(tenantB.id, ownerRoleB.id, [
    ...Object.values(IDENTITY_PERMISSIONS),
    ...Object.values(SALES_PERMISSIONS),
    ...Object.values(CATALOGUE_PERMISSIONS),
    ...Object.values(INVENTORY_PERMISSIONS),
    ...Object.values(ORGANISATION_PERMISSIONS),
    ...Object.values(PRODUCTION_PERMISSIONS),
    ...Object.values(TREASURY_PERMISSIONS),
    ...Object.values(KDS_PERMISSIONS),
    ...Object.values(REPORTING_PERMISSIONS),
    ...Object.values(AUDIT_PERMISSIONS),
    ...Object.values(WORKFORCE_PERMISSIONS),
  ]);
  await membershipRoles.create(tenantB.id, ownerB.id, {
    membershipId: ownerBMembership.id,
    roleId: ownerRoleB.id,
    scope: { type: 'tenant' },
  });

  const brandB = await brands.create(tenantB.id, ownerB.id, {
    name: 'Second Demo Tenant',
  });
  const branchMain = await branches.create(tenantB.id, ownerB.id, {
    brandId: brandB.id,
    code: 'MAIN',
    name: 'Main',
    timezone: 'Africa/Cairo',
    baseCurrency: 'EGP',
    countryCode: 'EG',
  });
  const terminalMain = await terminals.register(tenantB.id, {
    name: 'POS-Main',
    terminalType: 'pos',
    branchId: branchMain.id,
  });

  await app.close();

  // ------------------------------------------------------------- credentials.md --
  const md = `# ROS dev/demo seed credentials

Generated ${new Date(stamp).toISOString()} by \`src/scripts/seed-dev-data.ts\`
against the local dev database. **Local dev/demo data only — do not commit
this file, do not reuse these credentials anywhere but a local scratch DB.**

MTMB-1 demo shape:

\`\`\`
Demo Restaurant Group (Tenant A)
  Brand: Demo Restaurant Group
    Branch: Downtown (DOWNTOWN)
    Branch: Airport (AIRPORT)

Second Demo Tenant (Tenant B)
  Brand: Second Demo Tenant
    Branch: Main (MAIN)
\`\`\`

## Logins — Tenant A (Demo Restaurant Group)

| Role | Scope | Auth method | Email / Employee code | Password / PIN |
|---|---|---|---|---|
| Owner | TENANT (all of Tenant A) | \`POST /auth/login\` | \`${ownerA.email}\` | \`${DEV_PASSWORD}\` |
| Downtown Manager | BRANCH — Downtown only | \`POST /auth/login\` | \`${managerDowntown.email}\` | \`${DEV_PASSWORD}\` |
| Multi-Branch Manager | BRANCH — Downtown + Airport | \`POST /auth/login\` | \`${managerMultiBranch.email}\` | \`${DEV_PASSWORD}\` |
| Downtown Cashier | TENANT role, home branch Downtown | \`POST /auth/login\` | \`${posUser.email}\` | \`${DEV_PASSWORD}\` |
| Downtown Cashier (POS) | home branch Downtown | \`POST /auth/pin\` | employeeCode \`${employee.code}\` | PIN \`${DEV_PIN}\` |

After a password login (\`/auth/login\`), select Tenant A with:
\`\`\`json
POST /auth/tenant
{ "tenantId": "${tenantA.id}" }
\`\`\`

\`POST /auth/pin\` body (Downtown terminal):
\`\`\`json
{
  "tenantId": "${tenantA.id}",
  "terminalId": "${terminalDowntown.id}",
  "employeeCode": "${employee.code}",
  "pin": "${DEV_PIN}"
}
\`\`\`

## Logins — Tenant B (Second Demo Tenant, isolated from Tenant A)

| Role | Scope | Auth method | Email | Password |
|---|---|---|---|---|
| Owner | TENANT (all of Tenant B) | \`POST /auth/login\` | \`${ownerB.email}\` | \`${DEV_PASSWORD}\` |

\`\`\`json
POST /auth/tenant
{ "tenantId": "${tenantB.id}" }
\`\`\`

## Seeded IDs

| Entity | ID |
|---|---|
| Tenant A ID | \`${tenantA.id}\` |
| Tenant A slug | \`${tenantA.slug}\` |
| Brand A ID | \`${brandA.id}\` |
| Branch Downtown ID | \`${branchDowntown.id}\` |
| Branch Airport ID | \`${branchAirport.id}\` |
| Terminal POS-Downtown ID | \`${terminalDowntown.id}\` |
| Terminal POS-Airport ID | \`${terminalAirport.id}\` |
| Menu ID | \`${menu.id}\` |
| Category ID | \`${category.id}\` |
| Menu item ID | \`${item.id}\` |
| Menu item variant ID | \`${variant.id}\` |
| Price list ID | \`${priceList.id}\` |
| Tenant B ID | \`${tenantB.id}\` |
| Tenant B slug | \`${tenantB.slug}\` |
| Brand B ID | \`${brandB.id}\` |
| Branch Main ID | \`${branchMain.id}\` |
| Terminal POS-Main ID | \`${terminalMain.id}\` |

## What else was seeded

- Permission catalog upserted for every module.
- \`Owner\` role (TENANT scope) in both tenants — every permission code above.
- \`Branch Manager\` role (Tenant A) — branch-scoped operations
  (organisation/sales/catalogue/inventory/treasury/workforce/reporting reads
  and day-to-day writes), assigned at BRANCH scope to the Downtown Manager
  (Downtown only) and the Multi-Branch Manager (Downtown + Airport — two
  independent scoped assignments on ONE role, per FR-SEC-003).
- \`Cashier\` role (Tenant A, TENANT scope) — order create/fire/void-prefire +
  catalogue read, assigned to the Downtown Cashier membership; the PIN
  sign-in's own branch restriction comes from the employee's home branch,
  not from this role scope.
- One menu item + variant, with an \`active\` price list/entry, assigned to
  both Tenant A branches (\`GET /catalogue/price-lists\` returns it).
- \`GET /org/access\` (MTMB-1) returns each actor's own live accessible
  brands/branches — try it with any of the tokens above.

## What was NOT seeded

Inventory items/stock levels, recipes, warehouses, cash sessions, and KDS
terminals/stations — not created. Ask if you need any of these too.

## Known limitation — Sales order creation (\`POST /orders\`) will 422

No country pack is activated in a normal running process anywhere in this
repository (activation requires a cryptographic signature; per
\`env.validation.ts\`'s own comment "the signature verifier is deny-all until a
concrete signing scheme is ratified" — only the e2e test suite can activate
one, via a Jest-only DI override and a self-signed throwaway test pack marked
"TEST SUPPORT ONLY"). This is a pre-existing repository gap, not something
this script introduced: \`POST /orders\` will fail with
\`CountryPackUnavailableError\` (422), and the seeded menu item's
\`taxClassId\` is \`null\` for the same reason. Everything else (auth, RBAC,
terminals/employees, catalogue CRUD, organisation CRUD, inventory,
production) has no such dependency and works today. Ask if you want a
dev-only pack-activation bootstrap added — it's a separate, security-relevant
decision from seeding data.

## Quick smoke test (auth + reads — works today)

\`\`\`bash
# PIN login (Downtown cashier)
curl -X POST http://localhost:3000/auth/pin \\
  -H "Content-Type: application/json" \\
  -d '{"tenantId":"${tenantA.id}","terminalId":"${terminalDowntown.id}","employeeCode":"${employee.code}","pin":"${DEV_PIN}"}'

# Owner A password login + tenant selection
curl -X POST http://localhost:3000/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"${ownerA.email}","password":"${DEV_PASSWORD}"}'
curl -X POST http://localhost:3000/auth/tenant \\
  -H "Authorization: Bearer <accessToken>" \\
  -H "Content-Type: application/json" \\
  -d '{"tenantId":"${tenantA.id}"}'

# Then, with the scoped token:
curl http://localhost:3000/org/access -H "Authorization: Bearer <scopedAccessToken>"
curl http://localhost:3000/org/branches -H "Authorization: Bearer <scopedAccessToken>"
curl http://localhost:3000/catalogue/items -H "Authorization: Bearer <scopedAccessToken>"
\`\`\`
`;

  const outPath = join(__dirname, '..', '..', 'credentials.md');
  writeFileSync(outPath, md, 'utf8');

  console.log(`Wrote ${outPath}`);
  console.log(`Tenant A: ${tenantA.id} (${tenantA.slug})`);
  console.log(`Tenant B: ${tenantB.id} (${tenantB.slug})`);
  console.log(`Owner A login: ${ownerA.email} / ${DEV_PASSWORD}`);
  console.log(`Owner B login: ${ownerB.email} / ${DEV_PASSWORD}`);
  console.log(
    `Downtown Cashier PIN login: employeeCode=${employee.code} pin=${DEV_PIN} terminalId=${terminalDowntown.id}`,
  );
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exitCode = 1;
});
