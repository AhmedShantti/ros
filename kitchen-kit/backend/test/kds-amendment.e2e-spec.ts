import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { UnitOfWork } from './../src/common/domain-events/unit-of-work';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  KDS_PERMISSION_DEFS,
  KDS_PERMISSIONS,
} from './../src/modules/kitchen/kitchen.permissions';
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
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  ORDER_LINE_FIRED_EVENT_TYPE,
  ORDER_LINE_FIRED_EVENT_VERSION,
} from './../src/modules/sales/contract';
import type { OrderLineFiredPayload } from './../src/modules/sales/contract';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import {
  SALES_PERMISSION_DEFS,
  SALES_PERMISSIONS,
} from './../src/modules/sales/sales.permissions';
import { createMigratorClient } from './rls-admin';
import { pinLogin } from './kds-fixtures';

const DEV_PASSWORD = 's3cure-passphrase';
const RELEASE_KEY = generateReleaseKey('kds-amendment-e2e-key');
const TRUST = trustStoreFor(RELEASE_KEY.trusted());
const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);
const packPayload = () => ({
  code: 'EG',
  version: '2026.1',
  effectiveFrom: '2026-01-01',
  currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
  tax: {
    engine: 'vat_standard',
    pricingMode: 'tax_exclusive',
    computationLevel: 'line',
    roundingMode: 'HALF_UP',
    roundingPrecision: 2,
    classes: [{ code: 'standard', rate: '14.0', label: { en: 'Standard' } }],
    serviceChargeTaxable: true,
    orderTypeOverrides: [],
  },
});
const testPackDocument = () => signPackDocument(packPayload(), RELEASE_KEY);

interface OrderBody {
  id: string;
  version: number;
  businessDay: string;
  state: string;
}
interface OrderLineBody {
  id: string;
  state: string;
}
interface StationQueueBody {
  tickets: Array<{ id: string }>;
}
function queueTicketIds(res: { body: unknown }): string[] {
  return (res.body as StationQueueBody).tickets.map((t) => t.id);
}

/**
 * KDS acceptance correction (2026-08-31), Blocker C — amendment Fire into an
 * ALREADY-BUMPED station Ticket, driven through the REAL HTTP/application
 * Fire path (§8 of that correction: "Do NOT test blocker C solely through
 * direct fixture insertion"). Only Kitchen/KDS-side operations reuse the
 * already-proven `test/kds-fixtures.ts` HTTP surface; Order open, line
 * capture and BOTH Fire calls go through the genuine Sales services/HTTP
 * route — nothing here inserts a Ticket/TicketLine row directly.
 */
describe('KDS amendment reactivation — real Fire path (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let unitOfWork: UnitOfWork;
  let orders: OrdersService;
  let lines: OrderLinesService;
  const stamp = Date.now().toString(36);

  let tenantId: string;
  let branchId: string;
  let stationId: string;
  let posTerminalId: string;
  let kdsTerminalId: string;
  let employeeId: string;
  let employeeCode: string;
  let employeeUserId: string;
  let priceListId: string;
  let taxClassId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
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
    unitOfWork = app.get(UnitOfWork);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);

    await app.get(CountryPackService).activate(testPackDocument());

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);
    const permissions = app.get(PermissionsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const pins = app.get(PinService);

    const tenant = await tenants.create({
      slug: `kds-amend-${stamp}`,
      legalName: `KDS Amend ${stamp}`,
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    tenantId = tenant.id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `Brand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `A${stamp.slice(-6)}`,
        name: `Amend Branch ${stamp}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchId = branch.id;
    await admin.location.create({
      data: {
        id: newId(),
        tenantId,
        locationType: 'branch',
        refId: branchId,
        branchId,
      },
    });

    posTerminalId = (
      await admin.terminal.create({
        data: {
          id: newId(),
          tenantId,
          branchId,
          name: `POS-${stamp}`,
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;
    kdsTerminalId = (
      await admin.terminal.create({
        data: {
          id: newId(),
          tenantId,
          branchId,
          name: `KDS-${stamp}`,
          terminalType: 'kds',
          status: 'active',
        },
      })
    ).id;
    const station = await admin.station.create({
      data: {
        id: newId(),
        branchId,
        name: `Grill ${stamp}`,
        displayTerminalId: kdsTerminalId,
      },
    });
    stationId = station.id;
    // FR-KDS-010 tier 5 fallback — routes every fired line to this one
    // station with no per-item routing rule needed.
    await admin.branchKdsConfig.create({
      data: { branchId, tenantId, fallbackStationId: stationId },
    });

    await permissions.upsertMany([
      ...SALES_PERMISSION_DEFS,
      ...KDS_PERMISSION_DEFS,
    ]);
    const role = await roles.createTenantRole(tenantId, {
      name: `amend_operator_${stamp}`,
    });
    await roles.addPermissions(tenantId, role.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.ORDER_FIRE,
      KDS_PERMISSIONS.OPERATE,
    ]);

    const employeeUser = await users.createUser({
      email: `kds.amend.${stamp}@example.com`,
      password: DEV_PASSWORD,
      displayName: 'Amend Cook',
    });
    employeeUserId = employeeUser.id;
    const membership = await memberships.grant(
      employeeUser.id,
      tenantId,
      'active',
    );
    await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });
    employeeCode = `AM${stamp.slice(-6)}`;
    const employee = await employees.create(tenantId, employeeUser.id, {
      code: employeeCode,
      displayName: 'Amend Cook',
      homeBranchId: branchId,
      userId: employeeUser.id,
    });
    employeeId = employee.id;
    await pins.setPin(tenantId, employeeUser.id, employee.id, '9876');

    taxClassId = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId, countryPackCode: 'EG', code: 'standard' },
        select: { id: true },
      })
    ).id;
    priceListId = (
      await admin.priceList.create({
        data: {
          id: newId(),
          tenantId,
          name: `Prices ${stamp}`,
          scopeType: 'branch',
          scopeId: branchId,
          status: 'active',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function mkSellable(
    name: string,
  ): Promise<{ menuItemId: string; variantId: string }> {
    const menuItemId = (
      await admin.menuItem.create({
        data: { id: newId(), tenantId, names: { en: name }, taxClassId },
      })
    ).id;
    const variantId = (
      await admin.menuItemVariant.create({
        data: { id: newId(), tenantId, menuItemId, name: { en: 'Regular' } },
      })
    ).id;
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId,
        priceListId,
        menuItemVariantId: variantId,
        price: 1000n,
        currency: 'EGP',
      },
    });
    return { menuItemId, variantId };
  }

  async function posToken(): Promise<string> {
    return pinLogin(http, tenantId, posTerminalId, employeeCode, '9876');
  }
  async function kdsToken(): Promise<string> {
    return pinLogin(http, tenantId, kdsTerminalId, employeeCode, '9876');
  }

  async function fireOrder(
    token: string,
    orderId: string,
    businessDay: string,
  ): Promise<OrderBody> {
    const before = await admin.order.findFirstOrThrow({
      where: { id: orderId },
      select: { version: true },
    });
    const res = await request(http)
      .post(`/orders/${businessDay}/${orderId}/fire`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `fire-${newId()}`)
      .set('If-Match', String(before.version))
      .expect(200);
    return res.body as OrderBody;
  }

  it('an amendment Fire into an ALREADY-BUMPED station Ticket reuses the SAME Ticket, reactivates it, and Sales readiness for the new line is correct once bumped', async () => {
    const posT = await posToken();

    // ── open order, line A, first Fire ──────────────────────────────────
    const itemA = await mkSellable(`ItemA-${newId().slice(0, 8)}`);
    const order = await orders.create(tenantId, employeeUserId, {
      terminalId: posTerminalId,
      openedByEmployeeId: employeeId,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: new Date(),
      idempotencyKey: `open-${newId()}`,
    });
    const businessDay = order.businessDay.toISOString().slice(0, 10);

    const orderRow1 = await admin.order.findFirstOrThrow({
      where: { id: order.id },
      select: { version: true },
    });
    const { line: lineA } = await lines.addLine(
      tenantId,
      employeeUserId,
      order.id,
      order.businessDay,
      {
        menuItemId: itemA.menuItemId,
        variantId: itemA.variantId,
        quantity: '1',
        expectedVersion: orderRow1.version,
      },
    );

    const afterFireA = await fireOrder(posT, order.id, businessDay);
    expect(afterFireA.state).toBe('open');
    const firedLineA = afterFireA as unknown as { lines: OrderLineBody[] };
    expect(firedLineA.lines.find((l) => l.id === lineA.id)?.state).toBe(
      'fired',
    );

    const ticket = await admin.ticket.findFirstOrThrow({
      where: { tenantId, orderId: order.id, stationId },
    });

    // ── KDS: view + bump-all -> Ticket aggregate BUMPED, excluded from queue ──
    const kdsT = await kdsToken();
    await request(http)
      .post(`/kds/stations/${stationId}/tickets/view`)
      .set('Authorization', `Bearer ${kdsT}`)
      .send({ ticketIds: [ticket.id] })
      .expect(200);
    await request(http)
      .post(`/kds/tickets/${ticket.id}/bump-all`)
      .set('Authorization', `Bearer ${kdsT}`)
      .send({})
      .expect(200);

    const bumpedTicket = await admin.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(bumpedTicket.status).toBe('bumped');
    // Captured AFTER the bump — this is what the amendment cycle must
    // preserve byte-for-byte on line A.
    const ticketLineA = await admin.ticketLine.findFirstOrThrow({
      where: { tenantId, ticketId: ticket.id, orderLineId: lineA.id },
    });
    const readyOrderLineA = await admin.orderLine.findFirstOrThrow({
      where: { id: lineA.id, businessDay: order.businessDay },
    });
    expect(readyOrderLineA.state).toBe('ready');

    const queueBeforeAmendment = await request(http)
      .get(`/kds/stations/${stationId}/queue`)
      .set('Authorization', `Bearer ${kdsT}`)
      .expect(200);
    expect(queueTicketIds(queueBeforeAmendment)).not.toContain(ticket.id);

    // ── amendment: add line B to the STILL-OPEN order, fire again ───────
    const itemB = await mkSellable(`ItemB-${newId().slice(0, 8)}`);
    const orderRow2 = await admin.order.findFirstOrThrow({
      where: { id: order.id },
      select: { version: true },
    });
    const { line: lineB } = await lines.addLine(
      tenantId,
      employeeUserId,
      order.id,
      order.businessDay,
      {
        menuItemId: itemB.menuItemId,
        variantId: itemB.variantId,
        quantity: '1',
        expectedVersion: orderRow2.version,
      },
    );

    const afterFireB = await fireOrder(posT, order.id, businessDay);
    expect(afterFireB.state).toBe('open');

    // ── SAME Ticket id reused (FR-KDS-028 "never as a new ticket") ──────
    const ticketsForOrderStation = await admin.ticket.findMany({
      where: { tenantId, orderId: order.id, stationId },
    });
    expect(ticketsForOrderStation).toHaveLength(1);
    expect(ticketsForOrderStation[0].id).toBe(ticket.id);

    // ── new TicketLine exists, old line untouched ────────────────────────
    const ticketLineB = await admin.ticketLine.findFirstOrThrow({
      where: { tenantId, ticketId: ticket.id, orderLineId: lineB.id },
    });
    expect(ticketLineB.status).toBe('queued');
    const ticketLineAAfter = await admin.ticketLine.findUniqueOrThrow({
      where: { id: ticketLineA.id },
    });
    expect(ticketLineAAfter.status).toBe('bumped');
    expect(ticketLineAAfter.bumpedAt?.toISOString()).toBe(
      ticketLineA.bumpedAt?.toISOString(),
    );
    expect(ticketLineAAfter.bumpedBy).toBe(ticketLineA.bumpedBy);

    // ── Ticket reactivated: visible/active in the station queue again ───
    const reactivatedTicket = await admin.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(reactivatedTicket.status).not.toBe('bumped');
    expect(['queued', 'in_progress']).toContain(reactivatedTicket.status);

    const queueAfterAmendment = await request(http)
      .get(`/kds/stations/${stationId}/queue`)
      .set('Authorization', `Bearer ${kdsT}`)
      .expect(200);
    expect(queueTicketIds(queueAfterAmendment)).toContain(ticket.id);

    // ── bump the amendment line -> aggregate BUMPED again, event re-fires ──
    await request(http)
      .post(`/kds/tickets/${ticket.id}/lines/${ticketLineB.id}/bump`)
      .set('Authorization', `Bearer ${kdsT}`)
      .send({})
      .expect(200);

    const rebumpedTicket = await admin.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(rebumpedTicket.status).toBe('bumped');

    const readyOrderLineB = await admin.orderLine.findFirstOrThrow({
      where: { id: lineB.id, businessDay: order.businessDay },
    });
    expect(readyOrderLineB.state).toBe('ready');
    // Line A's Sales readiness is untouched by the amendment cycle.
    const stillReadyLineA = await admin.orderLine.findFirstOrThrow({
      where: { id: lineA.id, businessDay: order.businessDay },
    });
    expect(stillReadyLineA.state).toBe('ready');
  });

  it('replaying the SAME amendment fired-line event is a no-op: no second line, no spurious reactivation, no duplicate bump/event consequence', async () => {
    const posT = await posToken();
    const itemA = await mkSellable(`ReplayA-${newId().slice(0, 8)}`);
    const order = await orders.create(tenantId, employeeUserId, {
      terminalId: posTerminalId,
      openedByEmployeeId: employeeId,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: new Date(),
      idempotencyKey: `open-${newId()}`,
    });
    const businessDay = order.businessDay.toISOString().slice(0, 10);
    const orderRow = await admin.order.findFirstOrThrow({
      where: { id: order.id },
      select: { version: true },
    });
    const { line: lineA } = await lines.addLine(
      tenantId,
      employeeUserId,
      order.id,
      order.businessDay,
      {
        menuItemId: itemA.menuItemId,
        variantId: itemA.variantId,
        quantity: '1',
        expectedVersion: orderRow.version,
      },
    );
    await fireOrder(posT, order.id, businessDay);

    const ticket = await admin.ticket.findFirstOrThrow({
      where: { tenantId, orderId: order.id, stationId },
    });
    const kdsT = await kdsToken();
    await request(http)
      .post(`/kds/tickets/${ticket.id}/bump-all`)
      .set('Authorization', `Bearer ${kdsT}`)
      .send({})
      .expect(200);
    const bumpedTicket = await admin.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(bumpedTicket.status).toBe('bumped');

    // Re-publish the EXACT SAME order.line.fired event for line A directly
    // (the at-least-once redelivery this handler is already idempotent
    // against, per `kitchen-ticket-concurrency.e2e-spec.ts`'s own
    // "replaying the same fired line" test for the non-amendment case) —
    // never through HTTP, since Fire's own `Idempotency-Key` would just
    // return the cached response without re-invoking the handler at all.
    const orderLineA = await admin.orderLine.findFirstOrThrow({
      where: { id: lineA.id, businessDay: order.businessDay },
    });
    const fireBatch = await admin.ticketFireBatch.findFirstOrThrow({
      where: { tenantId, ticketId: ticket.id },
    });
    const ticketLineARow = await admin.ticketLine.findFirstOrThrow({
      where: { tenantId, ticketId: ticket.id, orderLineId: lineA.id },
    });
    // Must match the EXISTING Ticket/TicketLine header snapshot EXACTLY —
    // `TicketPersistenceService.assertHeaderUnchanged` refuses a replay
    // whose payload disagrees with what was already persisted (P1E-5A),
    // which is the correctness guarantee this test is actually exercising.
    const payload: OrderLineFiredPayload = {
      orderId: order.id,
      businessDay,
      orderLineId: lineA.id,
      fireBatchId: fireBatch.fireBatchId,
      firedAt: orderLineA.firedAt!.toISOString(),
      menuItemId: itemA.menuItemId,
      modifierIds: [],
      categoryIds: [],
      lineStationOverrides: [],
      orderNumber: ticket.orderNumberSnapshot,
      // `Ticket.orderTypeSnapshot` is Kitchen's own plain-string column
      // (P1E-5's deliberate DB-type decoupling from Sales' enum); the
      // request order was opened with `orderType: 'takeaway'`, so that
      // literal both matches the persisted snapshot AND the payload's
      // narrower union type.
      orderType: 'takeaway',
      serviceReference: ticket.serviceReferenceSnapshot,
      itemNameSnapshot: ticketLineARow.itemNameSnapshot as Record<
        string,
        unknown
      >,
      quantity: ticketLineARow.quantity.toString(),
      course: ticketLineARow.course,
      sequence: ticketLineARow.sequence,
      preparationNotes: ticketLineARow.preparationNotes,
      modifiers: [],
    };
    await unitOfWork.execute({ userId: employeeUserId, tenantId }, (ctx) => {
      ctx.publishEvent({
        eventType: ORDER_LINE_FIRED_EVENT_TYPE,
        eventVersion: ORDER_LINE_FIRED_EVENT_VERSION,
        occurredAt: new Date(),
        branchId,
        actorId: employeeUserId,
        actorType: 'user',
        idempotencyKey: newId(),
        payload,
      });
      return Promise.resolve();
    });

    const linesAfterReplay = await admin.ticketLine.findMany({
      where: { tenantId, ticketId: ticket.id, orderLineId: lineA.id },
    });
    expect(linesAfterReplay).toHaveLength(1);
    const ticketAfterReplay = await admin.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    // The replay must NOT reactivate the ticket — it is the SAME already-
    // fired line, not a genuinely new one.
    expect(ticketAfterReplay.status).toBe('bumped');
    expect(ticketAfterReplay.version).toBe(bumpedTicket.version);
  });
});
