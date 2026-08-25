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

/**
 * One-shot local-dev data seeder — NOT wired to any HTTP route, run manually:
 *
 *   nest build && node dist/scripts/seed-dev-data.js
 *
 * Creates one tenant with a full working POS setup (brand, branch, terminal,
 * an owner login, a PIN-authenticated cashier, and one sellable menu item
 * with an active price) by calling the same service layer the controllers
 * call — not raw SQL — so every invariant (RLS, audit trail, password
 * policy, price-list completeness, PIN uniqueness) is enforced exactly as
 * it would be for a real signup. Safe to re-run: tenant/user emails are
 * timestamp-suffixed, so each run creates a fresh, independent tenant rather
 * than colliding with a previous run.
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
  ]);

  // ---------------------------------------------------------------- tenant --
  const tenant = await tenants.create({
    slug: `dev-demo-${stamp}`,
    legalName: 'ROS Dev Demo Restaurant',
    defaultCurrency: 'EGP',
    countryPackCode: 'EG', // real, activated fixture pack -> tax classes auto-provisioned
  });

  // ----------------------------------------------------------------- users --
  const owner = await users.createUser({
    email: `owner.${stamp}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Dev Owner',
  });
  const cashierUser = await users.createUser({
    email: `cashier.${stamp}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Dev Cashier',
  });

  const ownerMembership = await memberships.grant(
    owner.id,
    tenant.id,
    'active',
  );
  const cashierMembership = await memberships.grant(
    cashierUser.id,
    tenant.id,
    'active',
  );

  // ----------------------------------------------------------------- roles --
  const ownerRole = await roles.createTenantRole(tenant.id, {
    name: 'Owner',
    description: 'Full access — seeded dev role.',
  });
  await roles.addPermissions(tenant.id, ownerRole.id, [
    ...Object.values(IDENTITY_PERMISSIONS),
    ...Object.values(SALES_PERMISSIONS),
    ...Object.values(CATALOGUE_PERMISSIONS),
    ...Object.values(INVENTORY_PERMISSIONS),
    ...Object.values(ORGANISATION_PERMISSIONS),
    ...Object.values(PRODUCTION_PERMISSIONS),
    ...Object.values(TREASURY_PERMISSIONS),
  ]);
  await membershipRoles.assign(tenant.id, ownerMembership.id, ownerRole.id);

  const cashierRole = await roles.createTenantRole(tenant.id, {
    name: 'Cashier',
    description: 'POS order capture — seeded dev role.',
  });
  await roles.addPermissions(tenant.id, cashierRole.id, [
    SALES_PERMISSIONS.ORDER_CREATE,
    // P1E-6A: the 2026-08-24 Fire Authorization Ratification names Cashier
    // as a role that receives pos.order.fire as policy. This dev seed is a
    // local-only convenience role, not the shipped standard-role grant
    // FR-SEC-010 still requires — granting it here just lets the seeded
    // dev Cashier actually exercise Fire locally.
    SALES_PERMISSIONS.ORDER_FIRE,
    SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
    CATALOGUE_PERMISSIONS.ITEM_READ,
    CATALOGUE_PERMISSIONS.PRICE_READ,
    CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
  ]);
  await membershipRoles.assign(tenant.id, cashierMembership.id, cashierRole.id);

  // ------------------------------------------------------ brand / branch --
  const brand = await brands.create(tenant.id, owner.id, {
    name: 'Dev Demo Brand',
  });
  const branch = await branches.create(tenant.id, owner.id, {
    brandId: brand.id,
    code: 'MAIN',
    name: 'Main Branch',
    timezone: 'Africa/Cairo',
    baseCurrency: 'EGP',
    countryCode: 'EG',
  });

  // -------------------------------------------------------------- terminal --
  const terminal = await terminals.register(tenant.id, {
    name: 'POS-1',
    terminalType: 'pos',
    branchId: branch.id,
  });

  // -------------------------------------------------------------- employee --
  const employee = await employees.create(tenant.id, owner.id, {
    code: 'EMP001',
    displayName: 'Dev Cashier',
    homeBranchId: branch.id,
    userId: cashierUser.id,
  });
  await pins.setPin(tenant.id, owner.id, employee.id, DEV_PIN);

  // --------------------------------------------------------------- catalogue --
  const taxClass = await prisma.withAuthContext({ tenantId: tenant.id }, (tx) =>
    tx.taxClass.findFirst({
      where: { tenantId: tenant.id, code: 'standard' },
    }),
  );

  const menu = await menus.create(tenant.id, owner.id, {
    name: { en: 'Main Menu', ar: 'القائمة الرئيسية' },
    orderTypes: ['dine_in', 'takeaway'],
  });
  await menus.assignBranch(tenant.id, owner.id, menu.id, branch.id);

  const category = await categories.create(tenant.id, owner.id, menu.id, {
    name: { en: 'Burgers', ar: 'برجر' },
  });

  const item = await menuItems.create(tenant.id, owner.id, {
    names: { en: 'Classic Burger', ar: 'برجر كلاسيك' },
    ...(taxClass ? { taxClassId: taxClass.id } : {}),
  });
  await menuItems.place(tenant.id, owner.id, item.id, category.id);
  const variant = await menuItems.addVariant(tenant.id, owner.id, item.id, {
    name: { en: 'Regular', ar: 'عادي' },
  });

  const priceList = await priceLists.create(tenant.id, owner.id, {
    name: 'Standard Pricing',
    scopeType: 'branch',
    scopeId: branch.id,
  });
  await priceLists.setPriceEntry(tenant.id, owner.id, priceList.id, {
    menuItemVariantId: variant.id,
    price: '25000', // 250.00 EGP, minor units
    currency: 'EGP',
  });
  await priceLists.activate(tenant.id, owner.id, priceList.id);

  await app.close();

  // ------------------------------------------------------------- credentials.md --
  const rows: Array<[string, string]> = [
    ['Tenant ID', tenant.id],
    ['Tenant slug', tenant.slug],
    ['Brand ID', brand.id],
    ['Branch ID', branch.id],
    ['Terminal ID', terminal.id],
    ['Terminal name', 'POS-1'],
    ['Menu ID', menu.id],
    ['Category ID', category.id],
    ['Menu item ID', item.id],
    ['Menu item variant ID', variant.id],
    ['Price list ID', priceList.id],
  ];

  const md = `# ROS dev seed credentials

Generated ${new Date(stamp).toISOString()} by \`src/scripts/seed-dev-data.ts\`
against the local dev database. **Local dev/test data only — do not commit
this file, do not reuse these credentials anywhere but a local scratch DB.**

## Logins

| Role | Auth method | Email / Employee code | Password / PIN | Notes |
|---|---|---|---|---|
| Owner | \`POST /auth/login\` | \`${owner.email}\` | \`${DEV_PASSWORD}\` | Full permissions across every module. Use for admin/config endpoints. |
| Cashier | \`POST /auth/login\` | \`${cashierUser.email}\` | \`${DEV_PASSWORD}\` | Same user as the PIN-login cashier below; password login gets a dashboard session (no POS-only restriction). |
| Cashier (POS) | \`POST /auth/pin\` | employeeCode \`${employee.code}\` | PIN \`${DEV_PIN}\` | Requires \`tenantId\`/\`terminalId\` in the body (below). Session is POS-only (\`typ: 'pos'\`) — can call \`/orders\` routes, cannot call dashboard-only routes. |

\`POST /auth/pin\` body:
\`\`\`json
{
  "tenantId": "${tenant.id}",
  "terminalId": "${terminal.id}",
  "employeeCode": "${employee.code}",
  "pin": "${DEV_PIN}"
}
\`\`\`

After a password login (\`/auth/login\`), select this tenant with:
\`\`\`json
POST /auth/tenant
{ "tenantId": "${tenant.id}" }
\`\`\`

## Seeded IDs

| Entity | ID |
|---|---|
${rows.map(([k, v]) => `| ${k} | \`${v}\` |`).join('\n')}

## What else was seeded

- Permission catalog upserted for every module (identity, sales, catalogue,
  inventory, organisation, production, treasury).
- \`Owner\` role — every permission code above, assigned to the Owner membership.
- \`Cashier\` role — order create/void-prefire + catalogue read, assigned to
  the Cashier membership.
- One menu item + variant, with an \`active\` price list/entry
  (\`GET /catalogue/price-lists\` returns it).

## What was NOT seeded

Inventory items/stock levels, recipes, warehouses, cash sessions, and any
second branch/terminal — not created. Ask if you need any of these too.

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
# PIN login (cashier)
curl -X POST http://localhost:3000/auth/pin \\
  -H "Content-Type: application/json" \\
  -d '{"tenantId":"${tenant.id}","terminalId":"${terminal.id}","employeeCode":"${employee.code}","pin":"${DEV_PIN}"}'

# Owner password login + tenant selection
curl -X POST http://localhost:3000/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"${owner.email}","password":"${DEV_PASSWORD}"}'
curl -X POST http://localhost:3000/auth/tenant \\
  -H "Authorization: Bearer <accessToken>" \\
  -H "Content-Type: application/json" \\
  -d '{"tenantId":"${tenant.id}"}'

# Then, with the scoped token:
curl http://localhost:3000/org/branches -H "Authorization: Bearer <scopedAccessToken>"
curl http://localhost:3000/catalogue/items -H "Authorization: Bearer <scopedAccessToken>"
\`\`\`
`;

  const outPath = join(__dirname, '..', '..', 'credentials.md');
  writeFileSync(outPath, md, 'utf8');

  console.log(`Wrote ${outPath}`);
  console.log(`Tenant: ${tenant.id} (${tenant.slug})`);
  console.log(`Owner login: ${owner.email} / ${DEV_PASSWORD}`);
  console.log(
    `Cashier PIN login: employeeCode=${employee.code} pin=${DEV_PIN} terminalId=${terminal.id}`,
  );
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exitCode = 1;
});
