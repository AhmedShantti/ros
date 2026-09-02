import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from '../src/common/ids';
import {
  BranchStatus,
  CashMovementType,
  CashSessionStatus,
  OrderChannel,
  OrderLineState,
  OrderPaymentTender,
  OrderState,
  OrderType,
  PrismaClient,
} from '../src/generated/prisma/client';
import { EmployeesService } from '../src/modules/identity/employees/employees.service';
import { PinService } from '../src/modules/identity/employees/pin.service';
import { MembershipRolesService } from '../src/modules/identity/authz/membership-roles.service';
import { MembershipsService } from '../src/modules/identity/memberships/memberships.service';
import { PermissionsService } from '../src/modules/identity/authz/permissions.service';
import { RolesService } from '../src/modules/identity/authz/roles.service';
import { TenantsService } from '../src/modules/identity/tenants/tenants.service';
import { UsersService } from '../src/modules/identity/users/users.service';
import {
  REPORTING_PERMISSIONS,
  REPORTING_PERMISSION_DEFS,
} from '../src/modules/reporting/reporting.permissions';
import { resolveBusinessDay } from '../src/modules/sales/orders/business-day';

/**
 * The branch's business day for `at`, using the SAME FR-FIN-024 algorithm
 * the application uses (imported, never reimplemented) — so a fixture never
 * has to guess what the report will compute as "today"/"yesterday".
 */
export function branchBusinessDay(
  at: Date,
  timezone = 'Africa/Cairo',
  businessDayCutoverMinutes = 0,
): Date {
  return resolveBusinessDay(at, timezone, () => businessDayCutoverMinutes);
}

export function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000);
}

/** `YYYY-MM-DD`, matching the report's own path-param/response format. */
export function dateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Shared Minimum Operational Reporting e2e bootstrap. Mirrors
 * `kds-fixtures.ts`'s style: a real-Postgres tenant/branch/employee/terminal
 * arrangement built through the real service layer for identity/RBAC
 * concerns, plus DIRECT inserts (never through Fire/Payment/CashSession
 * services) for `orders`/`order_lines`/`order_payments`/`cash_sessions`/
 * `cash_movements` — the same "insert directly, independent of the write
 * pipeline" choice `kds-fixtures.ts`'s own docblock makes, and for the same
 * reason: Reporting is a pure read over stored facts, and each report
 * formula/edge case needs EXACT, hand-verifiable stored figures, which a
 * full order lifecycle (price/tax engine, rounding, completion) would make
 * far harder to control precisely across dozens of scenarios.
 */

export const DEV_PASSWORD = 's3cure-passphrase';

export interface ReportingFixture {
  readonly tenantId: string;
  readonly brandId: string;
  readonly branchId: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeUserId: string;
  readonly terminalId: string;
  readonly dashboardUserId: string;
  readonly dashboardEmail: string;
}

export async function createReportingFixture(
  app: INestApplication,
  admin: PrismaClient,
  seed: string,
  permissionCodes: readonly string[] = [
    REPORTING_PERMISSIONS.VIEW_SALES,
    REPORTING_PERMISSIONS.VIEW_FINANCIAL,
  ],
): Promise<ReportingFixture> {
  const tenants = app.get(TenantsService);
  const users = app.get(UsersService);
  const memberships = app.get(MembershipsService);
  const permissions = app.get(PermissionsService);
  const roles = app.get(RolesService);
  const membershipRoles = app.get(MembershipRolesService);
  const employees = app.get(EmployeesService);

  const tenant = await tenants.create({
    slug: `rpt-${seed}`,
    legalName: `Reporting ${seed}`,
    defaultCurrency: 'EGP',
    countryPackCode: 'EG',
  });
  const tenantId = tenant.id;

  const brand = await admin.brand.create({
    data: { id: newId(), tenantId, name: `Reporting Brand ${seed}` },
  });
  const branchId = await createActiveBranch(admin, tenantId, brand.id, seed);

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

  await permissions.upsertMany(REPORTING_PERMISSION_DEFS);
  const role = await roles.createTenantRole(tenantId, {
    name: `reporting_${seed}`,
  });
  if (permissionCodes.length > 0) {
    await roles.addPermissions(tenantId, role.id, [...permissionCodes]);
  }

  const dashboardEmail = `rpt.dashboard.${seed}@example.com`;
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
      roleId: role.id,
      scope: { type: 'tenant' },
    });

  const employeeUser = await users.createUser({
    email: `rpt.emp.${seed}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Employee',
  });
  await memberships.grant(employeeUser.id, tenantId, 'active');
  const employeeCode = `E${seed.slice(-6)}`;
  const employee = await employees.create(tenantId, employeeUser.id, {
    code: employeeCode,
    displayName: 'Employee',
    homeBranchId: branchId,
    userId: employeeUser.id,
  });

  return {
    tenantId,
    brandId: brand.id,
    branchId,
    employeeId: employee.id,
    employeeCode,
    employeeUserId: employeeUser.id,
    terminalId: terminal.id,
    dashboardUserId: dashboardUser.id,
    dashboardEmail,
  };
}

/** Set a PIN for the fixture's employee, for the POS/PIN-session-refusal test. */
export async function setEmployeePin(
  app: INestApplication,
  fx: Pick<ReportingFixture, 'tenantId' | 'employeeUserId' | 'employeeId'>,
  pin: string,
): Promise<void> {
  const pins = app.get(PinService);
  await pins.setPin(fx.tenantId, fx.employeeUserId, fx.employeeId, pin);
}

/** Login -> tenant selection. No terminal bind: the dashboard route is not a POS route. */
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

export async function createActiveBranch(
  admin: PrismaClient,
  tenantId: string,
  brandId: string,
  seed: string,
  overrides: {
    timezone?: string;
    baseCurrency?: string;
    businessDayCutover?: string;
  } = {},
): Promise<string> {
  const branch = await admin.branch.create({
    data: {
      id: newId(),
      tenantId,
      brandId,
      code: `R${seed.slice(-6)}`,
      name: `Reporting Branch ${seed}`,
      timezone: overrides.timezone ?? 'Africa/Cairo',
      baseCurrency: overrides.baseCurrency ?? 'EGP',
      countryCode: 'EG',
      status: 'active',
    },
  });
  await admin.location.create({
    data: {
      id: newId(),
      tenantId,
      locationType: 'branch',
      refId: branch.id,
      branchId: branch.id,
    },
  });
  if (overrides.businessDayCutover) {
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      await admin.operatingHours.create({
        data: {
          id: newId(),
          branchId: branch.id,
          dayOfWeek,
          opensAt: new Date('1970-01-01T00:00:00.000Z'),
          closesAt: new Date('1970-01-01T23:59:00.000Z'),
          businessDayCutover: new Date(
            `1970-01-01T${overrides.businessDayCutover}:00.000Z`,
          ),
        },
      });
    }
  }
  return branch.id;
}

export async function setBranchStatus(
  admin: PrismaClient,
  branchId: string,
  status: BranchStatus,
): Promise<void> {
  await admin.branch.update({ where: { id: branchId }, data: { status } });
}

export async function setBranchBaseCurrency(
  admin: PrismaClient,
  branchId: string,
  baseCurrency: string,
): Promise<void> {
  await admin.branch.update({
    where: { id: branchId },
    data: { baseCurrency },
  });
}

export async function createTaxClass(
  admin: PrismaClient,
  input: { tenantId: string; code: string; countryPackCode?: string },
): Promise<string> {
  const taxClass = await admin.taxClass.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      countryPackCode: input.countryPackCode ?? 'EG',
      code: input.code,
      names: { en: input.code },
    },
  });
  return taxClass.id;
}

interface MenuItemRef {
  readonly menuItemId: string;
  readonly variantId: string;
}

/** A minimal MenuItem/MenuItemVariant pair — only referential integrity target, never read by any reporting assertion. */
export async function createMenuItemRef(
  admin: PrismaClient,
  tenantId: string,
): Promise<MenuItemRef> {
  const menuItemId = newId();
  await admin.menuItem.create({
    data: { id: menuItemId, tenantId, names: { en: 'Item' } },
  });
  const variantId = newId();
  await admin.menuItemVariant.create({
    data: { id: variantId, tenantId, menuItemId, name: { en: 'Regular' } },
  });
  return { menuItemId, variantId };
}

export interface InsertOrderInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly openedBy: string;
  readonly businessDay: Date;
  readonly orderNumber: string;
  readonly state: OrderState;
  readonly currency?: string;
  readonly grandTotal: bigint;
  readonly discountTotal?: bigint;
  readonly taxTotal: bigint;
  /** Deliberately independent of grandTotal in every fixture that can — §40: never read by any formula. */
  readonly subtotal?: bigint;
  readonly orderType?: OrderType;
  readonly channel?: OrderChannel;
  readonly openedAt?: Date;
}

/** Direct insert into `sales.orders` — never through Fire/Payment. */
export async function insertOrder(
  admin: PrismaClient,
  input: InsertOrderInput,
): Promise<string> {
  const id = input.id ?? newId();
  const openedAt = input.openedAt ?? input.businessDay;
  await admin.order.create({
    data: {
      id,
      tenantId: input.tenantId,
      branchId: input.branchId,
      terminalId: input.terminalId,
      orderNumber: input.orderNumber,
      businessDay: input.businessDay,
      orderType: input.orderType ?? 'dine_in',
      channel: input.channel ?? 'pos',
      state: input.state,
      openedBy: input.openedBy,
      currency: input.currency ?? 'EGP',
      // Deliberately WRONG relative to grandTotal in most fixtures — proves
      // `orders.subtotal` never drives any reporting formula (§40).
      subtotal: input.subtotal ?? 999_999_999n,
      discountTotal: input.discountTotal ?? 0n,
      taxTotal: input.taxTotal,
      grandTotal: input.grandTotal,
      paidTotal: input.state === 'completed' ? input.grandTotal : 0n,
      // ck_completed (migration 28): a completed order always carries its
      // completion instant.
      completedAt: input.state === 'completed' ? openedAt : null,
      openedAt,
      originDeviceTime: openedAt,
      idempotencyKey: `idem-${id}`,
      countryPackVersion: 'v1',
    },
  });
  return id;
}

export interface InsertOrderLineInput {
  readonly tenantId: string;
  readonly orderId: string;
  readonly businessDay: Date;
  readonly sequence?: number;
  readonly menuItemId: string;
  readonly variantId: string;
  readonly taxClassId: string;
  readonly taxAmount: bigint;
  readonly lineTotal: bigint;
  readonly state?: OrderLineState;
}

/** Direct insert into `sales.order_lines`. `taxClassId` carries no FK — a fresh `newId()` is a valid "unresolved label" fixture. */
export async function insertOrderLine(
  admin: PrismaClient,
  input: InsertOrderLineInput,
): Promise<string> {
  const id = newId();
  const lineTotal = input.lineTotal;
  await admin.orderLine.create({
    data: {
      id,
      tenantId: input.tenantId,
      orderId: input.orderId,
      businessDay: input.businessDay,
      sequence: input.sequence ?? 1,
      menuItemId: input.menuItemId,
      variantId: input.variantId,
      itemNameSnapshot: { en: 'Item' },
      quantity: '1',
      unitPrice: lineTotal,
      lineSubtotal: lineTotal - input.taxAmount,
      taxClassId: input.taxClassId,
      taxAmount: input.taxAmount,
      lineTotal,
      state: input.state ?? 'served',
      // ck_order_line_fired_at: every state but pending/voided requires it.
      firedAt: ['pending', 'voided'].includes(input.state ?? 'served')
        ? null
        : input.businessDay,
      // ck_order_line_void_reason: a voided line requires a reason id —
      // `fiscal.void_reasons` carries no FK on this column either (mirrors
      // `taxClassId`'s own FK-less design), so a fresh id is valid here too.
      voidReasonId: input.state === 'voided' ? newId() : null,
    },
  });
  return id;
}

export interface InsertOrderPaymentInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly orderId: string;
  readonly businessDay: Date;
  readonly terminalId: string;
  readonly employeeId: string;
  readonly cashSessionId: string;
  readonly tender: OrderPaymentTender;
  readonly amount: bigint;
  readonly roundingAdjustment?: bigint;
  readonly currency?: string;
  readonly tenderedAmount?: bigint;
  readonly changeGiven?: bigint;
  readonly processedAt?: Date;
}

/** Direct insert into `sales.order_payments`. */
export async function insertOrderPayment(
  admin: PrismaClient,
  input: InsertOrderPaymentInput,
): Promise<string> {
  const id = newId();
  const isCash = input.tender === 'cash';
  await admin.orderPayment.create({
    data: {
      id,
      tenantId: input.tenantId,
      branchId: input.branchId,
      orderId: input.orderId,
      businessDay: input.businessDay,
      tender: input.tender,
      currency: input.currency ?? 'EGP',
      amount: input.amount,
      roundingAdjustment: input.roundingAdjustment ?? 0n,
      cashSessionId: input.cashSessionId,
      employeeId: input.employeeId,
      terminalId: input.terminalId,
      tenderedAmount: isCash ? (input.tenderedAmount ?? input.amount) : null,
      changeGiven: isCash ? (input.changeGiven ?? 0n) : null,
      // ck_order_payments_card_fields: required, non-cash-field metadata.
      paymentTerminalTxnRef: isCash ? null : `TXN-${id.slice(0, 12)}`,
      processedAt: input.processedAt ?? input.businessDay,
    },
  });
  return id;
}

export interface CreateCashSessionInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly employeeId: string;
  readonly currency?: string;
  readonly openingFloat?: bigint;
  readonly status?: CashSessionStatus;
  readonly openedAt?: Date;
  readonly closedAt?: Date | null;
  readonly expectedCash?: bigint | null;
  readonly countedCash?: bigint | null;
  readonly variance?: bigint | null;
}

/** Direct insert of a Drawer + Shift + CashSession triple — mirrors the existing `cash-movements-close-and-payment-concurrency.e2e-spec.ts` `mkCashSession` precedent. */
export async function createCashSession(
  admin: PrismaClient,
  input: CreateCashSessionInput,
): Promise<string> {
  const drawer = await admin.drawer.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      name: `Drawer ${newId()}`,
      terminalId: null,
    },
  });
  const openedAt = input.openedAt ?? new Date();
  const shift = await admin.shift.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      employeeId: input.employeeId,
      status: 'open',
      openedAt,
    },
  });
  const session = await admin.cashSession.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      drawerId: drawer.id,
      shiftId: shift.id,
      employeeId: input.employeeId,
      openingFloat: input.openingFloat ?? 0n,
      currency: input.currency ?? 'EGP',
      status: input.status ?? 'open',
      openedAt,
      closedAt: input.closedAt ?? null,
      expectedCash: input.expectedCash ?? null,
      countedCash: input.countedCash ?? null,
      variance: input.variance ?? null,
    },
  });
  return session.id;
}

export interface CloseCashSessionWithFactsInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly cashSessionId: string;
  readonly employeeId: string;
  readonly employeeUserId: string;
  readonly terminalId: string;
  readonly openingFloat: bigint;
  readonly cashSalesTotal: bigint;
  readonly payInTotal?: bigint;
  readonly payOutTotal?: bigint;
  readonly safeDropTotal?: bigint;
  readonly cashRoundingAdjustments?: bigint;
  readonly countedCash: bigint;
  readonly currency?: string;
  readonly closedAt?: Date;
}

/** Shared by `closeCashSessionWithFacts`/`declareClosingSession` below. */
async function declareCloseAttempt(
  admin: PrismaClient,
  input: CloseCashSessionWithFactsInput,
): Promise<{
  attemptId: string;
  expectedCash: bigint;
  variance: bigint;
  closedAt: Date;
}> {
  const currency = input.currency ?? 'EGP';
  const closedAt = input.closedAt ?? new Date();
  const payInTotal = input.payInTotal ?? 0n;
  const payOutTotal = input.payOutTotal ?? 0n;
  const safeDropTotal = input.safeDropTotal ?? 0n;
  const cashRoundingAdjustments = input.cashRoundingAdjustments ?? 0n;

  const policy = await admin.cashClosePolicy.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      countMode: 'blind',
      varianceToleranceMinorUnits: 1_000_000n,
      currency,
      varianceApprovalExpirySeconds: 3600,
      createdBy: input.employeeUserId,
    },
  });

  const expectedCash =
    input.openingFloat +
    input.cashSalesTotal +
    payInTotal -
    payOutTotal -
    safeDropTotal +
    cashRoundingAdjustments;
  const variance = input.countedCash - expectedCash;

  const attempt = await admin.cashSessionCloseAttempt.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      cashSessionId: input.cashSessionId,
      policyVersionId: policy.id,
      toleranceMinorUnits: policy.varianceToleranceMinorUnits,
      countMode: 'blind',
      openingFloat: input.openingFloat,
      cashSalesTotal: input.cashSalesTotal,
      cashTipsTotal: 0n,
      payInTotal,
      cashRefundsTotal: 0n,
      payOutTotal,
      safeDropTotal,
      cashRoundingAdjustments,
      expectedCash,
      countedCash: input.countedCash,
      variance,
      currency,
      approvalRequired: false,
      declaredByEmployeeId: input.employeeId,
      declaredByUserId: input.employeeUserId,
      terminalId: input.terminalId,
      declaredAt: closedAt,
    },
  });
  return { attemptId: attempt.id, expectedCash, variance, closedAt };
}

/**
 * A REAL, constraint-satisfying `closed` `cash_sessions` row — a genuine
 * `CashClosePolicy` + `CashSessionCloseAttempt` pair, hand-computed against
 * the exact FR-FIN-004 formula `ck_csca_formula` enforces (P1G-1 migration
 * 34), rather than driving the full policy-resolution/approval-workflow
 * service. Chosen so `countedCash` never disagrees with the formula
 * (`variance = 0`, `approvalRequired = false`) — the simplest legitimately
 * anchored close, sufficient for Reporting's WHOLE_SESSION close-facts
 * assertions, which do not need to exercise the approval workflow itself.
 */
export async function closeCashSessionWithFacts(
  admin: PrismaClient,
  input: CloseCashSessionWithFactsInput,
): Promise<{
  expectedCash: bigint;
  countedCash: bigint;
  variance: bigint;
}> {
  const { attemptId, expectedCash, variance, closedAt } =
    await declareCloseAttempt(admin, input);

  await admin.cashSession.update({
    where: { id: input.cashSessionId },
    data: {
      status: 'closed',
      closeAttemptId: attemptId,
      expectedCash,
      countedCash: input.countedCash,
      variance,
      closedAt,
      closedByUserId: input.employeeUserId,
      closedByEmployeeId: input.employeeId,
    },
  });

  return { expectedCash, countedCash: input.countedCash, variance };
}

/**
 * A REAL `closing` session — an anchored `CashSessionCloseAttempt` exists
 * (`ck_cs_attempt_anchor` requires it), but the session's OWN close facts
 * stay NULL (`ck_cs_core_facts_require_anchor`'s second disjunct: a
 * non-`closed` row must hold every P1G-1 fact column NULL) — exactly the
 * "declared but not yet finalised" phase of the real state machine.
 */
export async function declareClosingSession(
  admin: PrismaClient,
  input: CloseCashSessionWithFactsInput,
): Promise<void> {
  const { attemptId } = await declareCloseAttempt(admin, input);
  await admin.cashSession.update({
    where: { id: input.cashSessionId },
    data: { status: 'closing', closeAttemptId: attemptId },
  });
}

export async function insertCashMovement(
  admin: PrismaClient,
  input: {
    tenantId: string;
    branchId: string;
    cashSessionId: string;
    employeeId: string;
    performedByUserId: string;
    movementType: CashMovementType;
    amount: bigint;
    currency?: string;
    occurredAt?: Date;
  },
): Promise<void> {
  await admin.cashMovement.create({
    data: {
      id: newId(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      cashSessionId: input.cashSessionId,
      employeeId: input.employeeId,
      movementType: input.movementType,
      amount: input.amount,
      currency: input.currency ?? 'EGP',
      reason: 'e2e fixture',
      occurredAt: input.occurredAt ?? new Date(),
      performedBy: input.performedByUserId,
    },
  });
}
