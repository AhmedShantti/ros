import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from '../src/common/ids';
import {
  OrderType,
  PrismaClient,
  TerminalStatus,
  TerminalType,
} from '../src/generated/prisma/client';
import { MembershipRolesService } from '../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from '../src/modules/identity/authz/permissions.service';
import { RolesService } from '../src/modules/identity/authz/roles.service';
import { EmployeesService } from '../src/modules/identity/employees/employees.service';
import { PinService } from '../src/modules/identity/employees/pin.service';
import { MembershipsService } from '../src/modules/identity/memberships/memberships.service';
import { TenantsService } from '../src/modules/identity/tenants/tenants.service';
import { UsersService } from '../src/modules/identity/users/users.service';
import {
  KDS_PERMISSION_DEFS,
  KDS_PERMISSIONS,
} from '../src/modules/kitchen/kitchen.permissions';

/**
 * Shared KDS e2e bootstrap — tenant/branch/station/terminal/employee/role
 * fixture, factored out because the KDS operator-lifecycle suites
 * (authorization, first-viewed, functional lifecycle, concurrency) all need
 * an identical, real-Postgres arrangement. Mirrors the `sales-fire.e2e-spec.ts`
 * bootstrap style, minus the country-pack/catalogue ceremony Fire needs but
 * KDS does not (tickets are inserted directly, never through Fire).
 */

export const DEV_PASSWORD = 's3cure-passphrase';

export interface KdsFixture {
  readonly tenantId: string;
  readonly branchId: string;
  readonly stationGrillId: string;
  readonly stationPackagingId: string;
  /** Active, `kds`-type, bound to `stationGrillId` only. */
  readonly kdsTerminalId: string;
  /** Active, `pos`-type. */
  readonly posTerminalId: string;
  /** Active, `kiosk`-type. */
  readonly kioskTerminalId: string;
  readonly dashboardUserId: string;
  readonly dashboardEmail: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeUserId: string;
  readonly pin: string;
}

export async function createKdsFixture(
  app: INestApplication,
  admin: PrismaClient,
  seed: string,
): Promise<KdsFixture> {
  const tenants = app.get(TenantsService);
  const users = app.get(UsersService);
  const memberships = app.get(MembershipsService);
  const employees = app.get(EmployeesService);
  const permissions = app.get(PermissionsService);
  const roles = app.get(RolesService);
  const membershipRoles = app.get(MembershipRolesService);
  const pins = app.get(PinService);

  const tenant = await tenants.create({
    slug: `kds-${seed}`,
    legalName: `KDS ${seed}`,
    defaultCurrency: 'EGP',
    countryPackCode: 'EG',
  });
  const tenantId = tenant.id;

  const brand = await admin.brand.create({
    data: { id: newId(), tenantId, name: `KDS Brand ${seed}` },
  });
  const branch = await admin.branch.create({
    data: {
      id: newId(),
      tenantId,
      brandId: brand.id,
      code: `K${seed.slice(-6)}`,
      name: `KDS Branch ${seed}`,
      timezone: 'Africa/Cairo',
      baseCurrency: 'EGP',
      countryCode: 'EG',
    },
  });
  const branchId = branch.id;
  await admin.location.create({
    data: {
      id: newId(),
      tenantId,
      locationType: 'branch',
      refId: branchId,
      branchId,
    },
  });

  const mkTerminal = (terminalType: TerminalType, name: string) =>
    admin.terminal
      .create({
        data: {
          id: newId(),
          tenantId,
          branchId,
          name,
          terminalType,
          status: 'active',
        },
      })
      .then((t) => t.id);

  const kdsTerminalId = await mkTerminal('kds', `KDS-${seed}`);
  const posTerminalId = await mkTerminal('pos', `POS-${seed}`);
  const kioskTerminalId = await mkTerminal('kiosk', `KIOSK-${seed}`);

  const stationGrill = await admin.station.create({
    data: {
      id: newId(),
      branchId,
      name: `Grill ${seed}`,
      displayTerminalId: kdsTerminalId,
    },
  });
  const stationPackaging = await admin.station.create({
    data: { id: newId(), branchId, name: `Packaging ${seed}` },
  });

  await permissions.upsertMany(KDS_PERMISSION_DEFS);
  const kdsRole = await roles.createTenantRole(tenantId, {
    name: `kds_operator_${seed}`,
  });
  await roles.addPermissions(tenantId, kdsRole.id, [KDS_PERMISSIONS.OPERATE]);

  // ── the PIN-authenticated cook ──────────────────────────────────────────
  const employeeUser = await users.createUser({
    email: `kds.cook.${seed}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Cook',
  });
  const employeeMembership = await memberships.grant(
    employeeUser.id,
    tenantId,
    'active',
  );
  await membershipRoles.create(tenantId, null, {
    membershipId: employeeMembership.id,
    roleId: kdsRole.id,
    scope: { type: 'tenant' },
  });
  const employeeCode = `CK${seed.slice(-6)}`;
  const employee = await employees.create(tenantId, employeeUser.id, {
    code: employeeCode,
    displayName: 'Cook',
    homeBranchId: branchId,
    userId: employeeUser.id,
  });
  const pin = '4321';
  await pins.setPin(tenantId, employeeUser.id, employee.id, pin);

  // ── a dashboard user (no PIN) with the same kds.operate grant, for the
  //    "terminal-bound, no employee identity" authorization case ──────────
  const dashboardEmail = `kds.dashboard.${seed}@example.com`;
  const dashboardUser = await users.createUser({
    email: dashboardEmail,
    password: DEV_PASSWORD,
    displayName: 'Dashboard',
  });
  const dashboardMembership = await memberships.grant(
    dashboardUser.id,
    tenantId,
    'active',
  );
  await membershipRoles.create(tenantId, null, {
    membershipId: dashboardMembership.id,
    roleId: kdsRole.id,
    scope: { type: 'tenant' },
  });

  return {
    tenantId,
    branchId,
    stationGrillId: stationGrill.id,
    stationPackagingId: stationPackaging.id,
    kdsTerminalId,
    posTerminalId,
    kioskTerminalId,
    dashboardUserId: dashboardUser.id,
    dashboardEmail,
    employeeId: employee.id,
    employeeCode,
    employeeUserId: employeeUser.id,
    pin,
  };
}

export async function setTerminalStatus(
  admin: PrismaClient,
  terminalId: string,
  status: TerminalStatus,
): Promise<void> {
  await admin.terminal.update({ where: { id: terminalId }, data: { status } });
}

export async function pinLogin(
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

/** Dashboard login -> tenant selection -> terminal bind. No employee identity. */
export async function dashboardTerminalToken(
  http: App,
  email: string,
  tenantId: string,
  terminalId: string,
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
  const bind = await request(http)
    .post('/auth/terminal')
    .set(
      'Authorization',
      `Bearer ${(scoped.body as { accessToken: string }).accessToken}`,
    )
    .send({ terminalId })
    .expect(200);
  return (bind.body as { accessToken: string }).accessToken;
}

export interface FiredTicketLineFixture {
  readonly orderId: string;
  readonly orderLineId: string;
  readonly ticketId: string;
  readonly ticketLineId: string;
}

/**
 * Insert a minimal Order + OrderLine + Ticket + TicketLine directly (never
 * through Fire — the KDS operator lifecycle is deliberately tested
 * independent of the Fire pipeline, exactly as
 * `kitchen-ticket-concurrency.e2e-spec.ts` already does for its own races).
 */
export async function fireTicketLine(
  admin: PrismaClient,
  input: {
    tenantId: string;
    branchId: string;
    stationId: string;
    businessDay: Date;
    orderNumber: string;
    orderType?: OrderType;
    serviceReference?: string | null;
    routedAt?: Date;
    orderLineId?: string;
    /** Must be a real `identity.terminals` row in `tenantId` (FK). */
    terminalId: string;
    /** Must be a real `identity.employees` row in `tenantId` (FK). */
    openedBy: string;
  },
): Promise<FiredTicketLineFixture> {
  const orderId = newId();
  const orderLineId = input.orderLineId ?? newId();
  const ticketId = newId();
  const ticketLineId = newId();
  const routedAt = input.routedAt ?? new Date();

  // order_lines.menu_item_id/variant_id carry real composite FKs
  // (tenant_id, id) -> catalogue.menu_items/menu_item_variants — minimal
  // rows, never read by any KDS test, only present to satisfy referential
  // integrity for the direct-insert fixture (Fire itself is not exercised).
  const menuItemId = newId();
  await admin.menuItem.create({
    data: { id: menuItemId, tenantId: input.tenantId, names: { en: 'Burger' } },
  });
  const variantId = newId();
  await admin.menuItemVariant.create({
    data: {
      id: variantId,
      tenantId: input.tenantId,
      menuItemId,
      name: { en: 'Regular' },
    },
  });

  await admin.order.create({
    data: {
      id: orderId,
      tenantId: input.tenantId,
      branchId: input.branchId,
      terminalId: input.terminalId,
      orderNumber: input.orderNumber,
      businessDay: input.businessDay,
      orderType: input.orderType ?? 'dine_in',
      channel: 'pos',
      openedBy: input.openedBy,
      currency: 'EGP',
      openedAt: routedAt,
      originDeviceTime: routedAt,
      idempotencyKey: `idem-${orderId}`,
      countryPackVersion: 'v1',
    },
  });
  await admin.orderLine.create({
    data: {
      id: orderLineId,
      tenantId: input.tenantId,
      orderId,
      businessDay: input.businessDay,
      sequence: 1,
      menuItemId,
      variantId,
      itemNameSnapshot: { en: 'Burger' },
      quantity: '1',
      unitPrice: 100n,
      lineSubtotal: 100n,
      taxClassId: newId(),
      lineTotal: 100n,
      state: 'fired',
      firedAt: routedAt,
    },
  });
  await admin.ticket.create({
    data: {
      id: ticketId,
      tenantId: input.tenantId,
      branchId: input.branchId,
      businessDay: input.businessDay,
      orderId,
      stationId: input.stationId,
      orderNumberSnapshot: input.orderNumber,
      orderTypeSnapshot: input.orderType ?? 'dine_in',
      serviceReferenceSnapshot: input.serviceReference ?? 'Table 1',
      createdAt: routedAt,
      routedAt,
    },
  });
  const fireBatch = await admin.ticketFireBatch.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      ticketId,
      fireBatchId: newId(),
      firedAt: routedAt,
    },
  });
  await admin.ticketLine.create({
    data: {
      id: ticketLineId,
      tenantId: input.tenantId,
      ticketId,
      fireBatchRowId: fireBatch.id,
      orderId,
      orderLineId,
      businessDay: input.businessDay,
      itemNameSnapshot: { en: 'Burger' },
      quantity: '1',
      sequence: 1,
      createdAt: routedAt,
      routedAt,
    },
  });

  return { orderId, orderLineId, ticketId, ticketLineId };
}

/** A second station's Ticket/TicketLine for the SAME OrderLine (FR-KDS-011 multi-station fixture). */
export async function fireExistingOrderLineToStation(
  admin: PrismaClient,
  input: {
    tenantId: string;
    branchId: string;
    stationId: string;
    businessDay: Date;
    orderId: string;
    orderLineId: string;
    orderNumber: string;
    routedAt?: Date;
  },
): Promise<{ ticketId: string; ticketLineId: string }> {
  const ticketId = newId();
  const ticketLineId = newId();
  const routedAt = input.routedAt ?? new Date();

  await admin.ticket.create({
    data: {
      id: ticketId,
      tenantId: input.tenantId,
      branchId: input.branchId,
      businessDay: input.businessDay,
      orderId: input.orderId,
      stationId: input.stationId,
      orderNumberSnapshot: input.orderNumber,
      orderTypeSnapshot: 'dine_in',
      serviceReferenceSnapshot: 'Table 1',
      createdAt: routedAt,
      routedAt,
    },
  });
  const fireBatch = await admin.ticketFireBatch.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      ticketId,
      fireBatchId: newId(),
      firedAt: routedAt,
    },
  });
  await admin.ticketLine.create({
    data: {
      id: ticketLineId,
      tenantId: input.tenantId,
      ticketId,
      fireBatchRowId: fireBatch.id,
      orderId: input.orderId,
      orderLineId: input.orderLineId,
      businessDay: input.businessDay,
      itemNameSnapshot: { en: 'Burger' },
      quantity: '1',
      sequence: 1,
      createdAt: routedAt,
      routedAt,
    },
  });

  return { ticketId, ticketLineId };
}
