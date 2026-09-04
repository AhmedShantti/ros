import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { AttendanceCorrectionService } from './../src/modules/workforce/attendance/attendance-correction.service';
import { AttendanceService } from './../src/modules/workforce/attendance/attendance.service';
import { WorkforceEmployeesService } from './../src/modules/workforce/employees/employees.service';
import {
  WORKFORCE_PERMISSIONS,
  WORKFORCE_PERMISSION_DEFS,
} from './../src/modules/workforce/workforce.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * HR-1 — Workforce Core: Employee record, Schedule substrate, Attendance.
 *
 * Real PostgreSQL throughout — no mocks. Covers the CLAUDE.md §L test matrix
 * items 1-39 (40-43 overtime are NOT IMPLEMENTED — see the HR-1 report).
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const shortStamp = stamp.toString().slice(-6);
const PIN_A = '5813';
const PIN_LATE = '5814';
const PIN_INACTIVE = '5815';

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}

describe('HR-1 — Workforce Core (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let workforceEmployees: WorkforceEmployeesService;
  let attendanceService: AttendanceService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let branchA2: string;
  let terminalA: string;

  let managerTokenA: string;
  let noPermTokenA: string;
  let managerTokenB: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const scoped = async (email: string, tid: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .send({ tenantId: tid })
      .expect(200);
    return (sel.body as Tokens).accessToken;
  };

  const pinLogin = async (
    tid: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ) => {
    const res = await request(http)
      .post('/auth/pin')
      .send({ tenantId: tid, terminalId, employeeCode, pin })
      .expect(200);
    return (res.body as Tokens).accessToken;
  };

  let idemCounter = 0;
  const idemKey = () => `hr1-${stamp}-${++idemCounter}`;

  /**
   * A fresh, dedicated PIN-capable employee for a time-boundary attendance
   * test — never `fx().lateEmployeeId`. Every such test schedules a shift
   * anchored to real "now", and reusing one employee across several would
   * make their shifts collide on §7.3 #26's overlap invariant (a GOOD
   * thing to enforce, a BAD thing to trip over by accident in a fixture).
   */
  const mkPosEmployee = async (
    label: string,
  ): Promise<{ id: string; code: string; pin: string }> => {
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const pins = app.get(PinService);
    const suffix = `${label}${++idemCounter}`;
    const user = await users.createUser({
      email: `hr1.${suffix}.${stamp}@example.com`,
      password,
      displayName: `HR1 ${label}`,
    });
    await memberships.grant(user.id, tenantA, 'active');
    const code = `B${suffix}${shortStamp}`.slice(0, 20);
    const employee = await workforceEmployees.create(
      tenantA,
      fx().managerUserIdA,
      {
        code,
        displayName: `HR1 ${label}`,
        homeBranchId: branchA,
        employmentType: 'full_time',
        userId: user.id,
      },
    );
    const pin = String(1000 + (idemCounter % 9000)).padStart(4, '0');
    await pins.setPin(tenantA, fx().managerUserIdA, employee.id, pin);
    return { id: employee.id, code, pin };
  };

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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    workforceEmployees = app.get(WorkforceEmployeesService);
    attendanceService = app.get(AttendanceService);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(WORKFORCE_PERMISSION_DEFS);
    await permissions.upsert({
      code: 'settings.branch.manage',
      module: 'organisation',
      description: 'Branch configuration',
    });

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantA = await mkTenant(`hr1-a-${stamp}`);
    tenantB = await mkTenant(`hr1-b-${stamp}`);

    const mkBranch = async (tid: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId: tid, name: `HR1 Brand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId: tid,
          brandId: brand.id,
          code,
          name: `HR1 Branch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      await admin.location.create({
        data: {
          id: newId(),
          tenantId: tid,
          locationType: 'branch',
          refId: branch.id,
          branchId: branch.id,
        },
      });
      return branch.id;
    };
    branchA = await mkBranch(tenantA, `HRA${shortStamp}`);
    branchA2 = await mkBranch(tenantA, `HRX${shortStamp}`);
    // tenant B needs no branch of its own: test 5's cross-tenant
    // invisibility check and test 36's cross-tenant correction check both
    // only need tenant B's own token, never one of its resources.

    terminalA = await admin.terminal
      .create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          name: 'HR1-POS-1',
          terminalType: 'pos',
          status: 'active',
        },
      })
      .then((t) => t.id);

    // Dashboard managers, one per tenant, holding every HR-1 permission.
    const mkManager = async (email: string, tid: string, codes: string[]) => {
      const u = await users.createUser({
        email,
        password,
        displayName: 'HR Manager',
      });
      const m = await memberships.grant(u.id, tid, 'active');
      const role = await roles.createTenantRole(tid, {
        name: `hr1-role-${email}`,
      });
      await roles.addPermissions(tid, role.id, codes);
      await membershipRoles.create(tid, null, {
        membershipId: m.id,
        roleId: role.id,
        scope: { type: 'tenant' },
      });
      return u.id;
    };

    const managerCodes = [
      WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE,
      WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW,
      WORKFORCE_PERMISSIONS.COMPENSATION_VIEW,
      WORKFORCE_PERMISSIONS.SCHEDULE_MANAGE,
      WORKFORCE_PERMISSIONS.ATTENDANCE_CORRECT,
      'settings.branch.manage',
    ];
    const managerUserIdA = await mkManager(
      `hr1.mgrA.${stamp}@example.com`,
      tenantA,
      managerCodes,
    );
    await mkManager(`hr1.mgrB.${stamp}@example.com`, tenantB, managerCodes);
    // Same tenant, holds EMPLOYEE_MANAGE and SCHEDULE_MANAGE but NOT
    // COMPENSATION_VIEW and NOT ATTENDANCE_CORRECT — test 7 / test 33.
    await mkManager(`hr1.noPermA.${stamp}@example.com`, tenantA, [
      WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE,
      WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW,
      WORKFORCE_PERMISSIONS.SCHEDULE_MANAGE,
    ]);

    managerTokenA = await scoped(`hr1.mgrA.${stamp}@example.com`, tenantA);
    managerTokenB = await scoped(`hr1.mgrB.${stamp}@example.com`, tenantB);
    noPermTokenA = await scoped(`hr1.noPermA.${stamp}@example.com`, tenantA);

    // Cashier employee (PIN-capable) at branch A, permitted at branch A only.
    const cashierUser = await users.createUser({
      email: `hr1.cashier.${stamp}@example.com`,
      password,
      displayName: 'HR1 Cashier',
    });
    await memberships.grant(cashierUser.id, tenantA, 'active');
    const cashier = await workforceEmployees.create(tenantA, managerUserIdA, {
      code: `HRC${shortStamp}`,
      displayName: 'Cashier One',
      homeBranchId: branchA,
      employmentType: 'full_time',
      userId: cashierUser.id,
    });
    const pins = app.get(PinService);
    await pins.setPin(tenantA, managerUserIdA, cashier.id, PIN_A);

    // Second PIN-capable employee, used for the late-arrival / early-clock-in
    // boundary tests (kept separate so its own attendance state never
    // collides with the primary cashier's).
    const lateUser = await users.createUser({
      email: `hr1.late.${stamp}@example.com`,
      password,
      displayName: 'HR1 Late',
    });
    await memberships.grant(lateUser.id, tenantA, 'active');
    const lateEmployee = await workforceEmployees.create(
      tenantA,
      managerUserIdA,
      {
        code: `HRL${shortStamp}`,
        displayName: 'Late Employee',
        homeBranchId: branchA,
        employmentType: 'part_time',
        userId: lateUser.id,
      },
    );
    await pins.setPin(tenantA, managerUserIdA, lateEmployee.id, PIN_LATE);

    // Third PIN-capable employee, deactivated AFTER PIN login (stale-token
    // scenario — test 31).
    const inactiveUser = await users.createUser({
      email: `hr1.inactive.${stamp}@example.com`,
      password,
      displayName: 'HR1 Inactive',
    });
    await memberships.grant(inactiveUser.id, tenantA, 'active');
    const inactiveEmployee = await workforceEmployees.create(
      tenantA,
      managerUserIdA,
      {
        code: `HRI${shortStamp}`,
        displayName: 'Soon Inactive',
        homeBranchId: branchA,
        employmentType: 'casual',
        userId: inactiveUser.id,
      },
    );
    await pins.setPin(
      tenantA,
      managerUserIdA,
      inactiveEmployee.id,
      PIN_INACTIVE,
    );

    (globalThis as unknown as { __hr1: Record<string, string> }).__hr1 = {
      cashierId: cashier.id,
      lateEmployeeId: lateEmployee.id,
      inactiveEmployeeId: inactiveEmployee.id,
      managerUserIdA,
    };
  }, 90000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const fx = () =>
    (globalThis as unknown as { __hr1: Record<string, string> }).__hr1;

  // =========================================================== EMPLOYEE ===

  describe('Employee', () => {
    it('1: supports every FR-HRM-002 employment type', async () => {
      const types = [
        'full_time',
        'part_time',
        'casual',
        'contractor',
        'trainee',
      ];
      for (const [i, employmentType] of types.entries()) {
        const res = await request(http)
          .post('/workforce/employees')
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({
            code: `ET${i}${shortStamp}`,
            displayName: `Type ${employmentType}`,
            homeBranchId: branchA,
            employmentType,
          })
          .expect(201);
        expect((res.body as { employmentType: string }).employmentType).toBe(
          employmentType,
        );
      }
    });

    it('2: duplicate employee code is rejected', async () => {
      const code = `DUP${shortStamp}`;
      await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code,
          displayName: 'First',
          homeBranchId: branchA,
          employmentType: 'full_time',
        })
        .expect(201);
      await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code,
          displayName: 'Second',
          homeBranchId: branchA,
          employmentType: 'full_time',
        })
        .expect(409);
    });

    it('3: home branch is required and must be valid', async () => {
      await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code: `NB${shortStamp}`,
          displayName: 'No branch',
          employmentType: 'full_time',
        })
        .expect(400);
      await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code: `IB${shortStamp}`,
          displayName: 'Invalid branch',
          homeBranchId: newId(),
          employmentType: 'full_time',
        })
        .expect(404);
    });

    it('4: multi-branch assignment', async () => {
      const create = await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code: `MB${shortStamp}`,
          displayName: 'Multi Branch',
          homeBranchId: branchA,
          employmentType: 'full_time',
          permittedBranchIds: [branchA2],
        })
        .expect(201);
      const id = (create.body as WithId).id;
      const get = await request(http)
        .get(`/workforce/employees/${id}`)
        .set(auth(managerTokenA))
        .expect(200);
      const branchIds = (
        get.body as { branches: { branchId: string }[] }
      ).branches.map((b) => b.branchId);
      expect(branchIds.sort()).toEqual([branchA, branchA2].sort());
    });

    it('5: employee from tenant A is invisible to tenant B', async () => {
      await request(http)
        .get(`/workforce/employees/${fx().cashierId}`)
        .set(auth(managerTokenB))
        .expect(404);
    });

    it('6/7/8: compensation is effective-dated and permission-gated', async () => {
      const empId = fx().cashierId;
      await request(http)
        .post(`/workforce/employees/${empId}/compensation`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({ basis: 'hourly', amountMinorUnits: '5000', currency: 'EGP' })
        .expect(201);
      const later = new Date(Date.now() + 60_000).toISOString();
      await request(http)
        .post(`/workforce/employees/${empId}/compensation`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          basis: 'hourly',
          amountMinorUnits: '6000',
          currency: 'EGP',
          effectiveFrom: later,
        })
        .expect(201);

      // 7: hidden without permission.
      await request(http)
        .get(`/workforce/employees/${empId}/compensation`)
        .set(auth(noPermTokenA))
        .expect(403);

      // 8: visible with permission — resolves the FIRST (still-current) version.
      const res = await request(http)
        .get(`/workforce/employees/${empId}/compensation`)
        .set(auth(managerTokenA))
        .expect(200);
      expect((res.body as { amountMinorUnits: string }).amountMinorUnits).toBe(
        '5000',
      );
    });

    it('9: deactivation', async () => {
      const create = await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code: `DEA${shortStamp}`,
          displayName: 'To Deactivate',
          homeBranchId: branchA,
          employmentType: 'full_time',
        })
        .expect(201);
      const id = (create.body as WithId).id;
      const deact = await request(http)
        .post(`/workforce/employees/${id}/deactivate`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({ status: 'suspended', reason: 'Testing FR-HRM-006' })
        .expect(201);
      expect((deact.body as { status: string }).status).toBe('suspended');

      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: id,
          action: 'EMPLOYEE_DEACTIVATED',
        },
      });
      expect(entry).toBeTruthy();
    });

    it('10: a referenced employee cannot be hard-deleted', async () => {
      await expect(
        admin.employee.delete({ where: { id: fx().cashierId } }),
      ).rejects.toBeTruthy();
    });
  });

  // =========================================================== SCHEDULE ===

  describe('Schedule', () => {
    let scheduleId: string;
    const weekStart = '2026-09-07';

    it('11: weekly schedule creation', async () => {
      const res = await request(http)
        .post('/workforce/schedules')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({ branchId: branchA, weekStartDate: weekStart })
        .expect(201);
      scheduleId = (res.body as WithId).id;
      expect(scheduleId).toBeTruthy();
    });

    it('12/15: scheduled shift creation for a permitted, active employee', async () => {
      const res = await request(http)
        .post(`/workforce/schedules/${scheduleId}/shifts`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          employeeId: fx().cashierId,
          startsAt: '2026-09-07T09:00:00.000Z',
          endsAt: '2026-09-07T17:00:00.000Z',
        })
        .expect(201);
      expect((res.body as WithId).id).toBeTruthy();
    });

    it('13: inactive employee is rejected', async () => {
      const create = await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code: `SI${shortStamp}`,
          displayName: 'Sched Inactive',
          homeBranchId: branchA,
          employmentType: 'full_time',
        })
        .expect(201);
      const id = (create.body as WithId).id;
      await request(http)
        .post(`/workforce/employees/${id}/deactivate`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({ status: 'suspended', reason: 'x' })
        .expect(201);
      await request(http)
        .post(`/workforce/schedules/${scheduleId}/shifts`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          employeeId: id,
          startsAt: '2026-09-08T09:00:00.000Z',
          endsAt: '2026-09-08T17:00:00.000Z',
        })
        .expect(409);
    });

    it('14: non-permitted branch is rejected', async () => {
      const create = await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code: `WB${shortStamp}`,
          displayName: 'Wrong Branch',
          homeBranchId: branchA2,
          employmentType: 'full_time',
        })
        .expect(201);
      const id = (create.body as WithId).id;
      await request(http)
        .post(`/workforce/schedules/${scheduleId}/shifts`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          employeeId: id,
          startsAt: '2026-09-08T09:00:00.000Z',
          endsAt: '2026-09-08T17:00:00.000Z',
        })
        .expect(409);
    });

    it('16: overlapping shifts for the same employee are rejected (§7.3 #26)', async () => {
      await request(http)
        .post(`/workforce/schedules/${scheduleId}/shifts`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          employeeId: fx().cashierId,
          startsAt: '2026-09-07T12:00:00.000Z',
          endsAt: '2026-09-07T14:00:00.000Z',
        })
        .expect(409);
    });

    it('16b: FR-HRM-012 max shift length (12h) is enforced', async () => {
      await request(http)
        .post(`/workforce/schedules/${scheduleId}/shifts`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          employeeId: fx().lateEmployeeId,
          startsAt: '2026-09-09T06:00:00.000Z',
          endsAt: '2026-09-09T19:00:00.000Z',
        })
        .expect(400);
    });

    it('16c: FR-HRM-012 minimum rest between shifts (11h) is enforced', async () => {
      await request(http)
        .post(`/workforce/schedules/${scheduleId}/shifts`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          employeeId: fx().lateEmployeeId,
          startsAt: '2026-09-08T09:00:00.000Z',
          endsAt: '2026-09-08T13:00:00.000Z',
        })
        .expect(201);
      await request(http)
        .post(`/workforce/schedules/${scheduleId}/shifts`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          employeeId: fx().lateEmployeeId,
          startsAt: '2026-09-08T15:00:00.000Z',
          endsAt: '2026-09-08T18:00:00.000Z',
        })
        .expect(409);
    });
  });

  // ========================================================= ATTENDANCE ===

  describe('Attendance', () => {
    let posToken: string;
    let attendanceRecordId: string;

    it('18: POS PIN clock-in', async () => {
      posToken = await pinLogin(tenantA, terminalA, `HRC${shortStamp}`, PIN_A);
      const res = await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(posToken))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(201);
      attendanceRecordId = (res.body as WithId).id;
      expect((res.body as { status: string }).status).toBe('open');
    });

    it('20: duplicate clock-in is blocked', async () => {
      await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(posToken))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(409);
    });

    it('22: clock event retains method/terminal/timestamp', async () => {
      const event = await admin.clockEvent.findFirst({
        where: { attendanceRecordId, eventType: 'clock_in' },
      });
      expect(event?.method).toBe('pos_pin');
      expect(event?.terminalId).toBe(terminalA);
      expect(event?.occurredAt).toBeTruthy();
    });

    it('24: unscheduled clock-in is flagged (no matching scheduled shift)', async () => {
      const record = await admin.attendanceRecord.findUniqueOrThrow({
        where: { id: attendanceRecordId },
      });
      expect(record.unscheduled).toBe(true);
      expect(record.scheduledShiftId).toBeNull();
    });

    it('19/21: clock-out, and a replay with the same Idempotency-Key has no second effect', async () => {
      const key = idemKey();
      const first = await request(http)
        .post('/workforce/attendance/clock-out')
        .set(auth(posToken))
        .set('Idempotency-Key', key)
        .send({})
        .expect(200);
      const second = await request(http)
        .post('/workforce/attendance/clock-out')
        .set(auth(posToken))
        .set('Idempotency-Key', key)
        .send({})
        .expect(200);
      expect(first.body).toEqual(second.body);

      const events = await admin.clockEvent.count({
        where: { attendanceRecordId, eventType: 'clock_out' },
      });
      expect(events).toBe(1);
      const record = await admin.attendanceRecord.findUniqueOrThrow({
        where: { id: attendanceRecordId },
      });
      expect(record.status).toBe('closed');
    });

    it('30: PIN login at a terminal outside the permitted branch is rejected', async () => {
      // The cashier's only permitted branch is A; branch A2 has no terminal
      // of its own in this fixture, so exercise the boundary directly:
      // an employee whose home/permitted branch is A2 cannot authenticate
      // at terminal A (branch A).
      const users = app.get(UsersService);
      const memberships = app.get(MembershipsService);
      const wbUser = await users.createUser({
        email: `hr1.wbp.${stamp}@example.com`,
        password,
        displayName: 'Wrong Branch PIN User',
      });
      await memberships.grant(wbUser.id, tenantA, 'active');
      const create = await request(http)
        .post('/workforce/employees')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          code: `WBP${shortStamp}`,
          displayName: 'Wrong Branch PIN',
          homeBranchId: branchA2,
          employmentType: 'full_time',
          userId: wbUser.id,
        })
        .expect(201);
      const id = (create.body as WithId).id;
      const pins = app.get(PinService);
      await pins.setPin(tenantA, fx().managerUserIdA, id, '9911');
      await request(http)
        .post('/auth/pin')
        .send({
          tenantId: tenantA,
          terminalId: terminalA,
          employeeCode: `WBP${shortStamp}`,
          pin: '9911',
        })
        .expect(401);
    });

    it('31: an employee deactivated AFTER PIN login is rejected at clock-in (stale-token)', async () => {
      const staleToken = await pinLogin(
        tenantA,
        terminalA,
        `HRI${shortStamp}`,
        PIN_INACTIVE,
      );
      await request(http)
        .post(`/workforce/employees/${fx().inactiveEmployeeId}/deactivate`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({ status: 'suspended', reason: 'stale-token test' })
        .expect(201);
      // 403, not 409: `TenantContextService` re-validates the bound
      // employee is still `active` on EVERY POS-session request (live,
      // never trusting the token snapshot) and rejects first, before
      // `AttendanceService.clockIn`'s own `facts.active` check — which
      // therefore acts as defense-in-depth for a path this specific guard
      // does not cover, rather than as the enforcement point reached here.
      await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(staleToken))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(403);
    });

    it('23: mobile GPS shape is persisted where supplied', async () => {
      const posToken2 = await pinLogin(
        tenantA,
        terminalA,
        `HRC${shortStamp}`,
        PIN_A,
      );
      const res = await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(posToken2))
        .set('Idempotency-Key', idemKey())
        .send({ gps: { lat: 30.0444, lng: 31.2357 } })
        .expect(201);
      const id = (res.body as WithId).id;
      const event = await admin.clockEvent.findFirstOrThrow({
        where: { attendanceRecordId: id, eventType: 'clock_in' },
      });
      expect(Number(event.gpsLat)).toBeCloseTo(30.0444, 4);
      expect(Number(event.gpsLng)).toBeCloseTo(31.2357, 4);

      // Clean up: close the record so later tests see a fresh open slot.
      await request(http)
        .post('/workforce/attendance/clock-out')
        .set(auth(posToken2))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(200);
    });

    it('22b/FR-HRM-022: clock-in outside a configured geofence is flagged', async () => {
      // A fresh employee — isolates this test's geofence version from any
      // other AttendanceSettings version another test writes for branchA.
      const emp = await mkPosEmployee('Geofence');
      await request(http)
        .post('/workforce/attendance/settings')
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          branchId: branchA,
          geofenceCenterLat: 30.0444,
          geofenceCenterLng: 31.2357,
          geofenceRadiusMeters: 100,
        })
        .expect(201);

      const pos = await pinLogin(tenantA, terminalA, emp.code, emp.pin);
      // ~1.1km north of the geofence centre — well outside a 100m radius.
      const res = await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(pos))
        .set('Idempotency-Key', idemKey())
        .send({ gps: { lat: 30.0544, lng: 31.2357 } })
        .expect(201);
      expect((res.body as { outsideGeofence: boolean }).outsideGeofence).toBe(
        true,
      );

      await request(http)
        .post('/workforce/attendance/clock-out')
        .set(auth(pos))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(200);
    });

    describe('25/26/28/29: schedule-relative flags and FR-HRM-023 boundary', () => {
      it('25: late arrival beyond grace period is flagged', async () => {
        await request(http)
          .post('/workforce/attendance/settings')
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({ branchId: branchA, graceMinutes: 5 })
          .expect(201);

        const schedule = await request(http)
          .post('/workforce/schedules')
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({ branchId: branchA, weekStartDate: '2026-09-14' })
          .expect(201);

        const emp = await mkPosEmployee('Late25');
        const now = new Date();
        const shiftStart = new Date(now.getTime() - 20 * 60_000); // started 20 min ago
        await request(http)
          .post(`/workforce/schedules/${(schedule.body as WithId).id}/shifts`)
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({
            employeeId: emp.id,
            startsAt: shiftStart.toISOString(),
            endsAt: new Date(shiftStart.getTime() + 8 * 3600_000).toISOString(),
          })
          .expect(201);

        const posLate = await pinLogin(tenantA, terminalA, emp.code, emp.pin);
        const res = await request(http)
          .post('/workforce/attendance/clock-in')
          .set(auth(posLate))
          .set('Idempotency-Key', idemKey())
          .send({})
          .expect(201);
        expect((res.body as { lateArrival: boolean }).lateArrival).toBe(true);
        expect((res.body as { unscheduled: boolean }).unscheduled).toBe(false);

        await request(http)
          .post('/workforce/attendance/clock-out')
          .set(auth(posLate))
          .set('Idempotency-Key', idemKey())
          .send({})
          .expect(200);
      });

      it('26: early departure before the scheduled end is flagged', async () => {
        const schedule = await request(http)
          .post('/workforce/schedules')
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({ branchId: branchA, weekStartDate: '2026-09-21' })
          .expect(201);

        const emp = await mkPosEmployee('Early26');
        const now = new Date();
        const shiftStart = new Date(now.getTime() - 60_000);
        const shiftEnd = new Date(now.getTime() + 4 * 3600_000); // ends 4h from now
        await request(http)
          .post(`/workforce/schedules/${(schedule.body as WithId).id}/shifts`)
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({
            employeeId: emp.id,
            startsAt: shiftStart.toISOString(),
            endsAt: shiftEnd.toISOString(),
          })
          .expect(201);

        const posLate = await pinLogin(tenantA, terminalA, emp.code, emp.pin);
        await request(http)
          .post('/workforce/attendance/clock-in')
          .set(auth(posLate))
          .set('Idempotency-Key', idemKey())
          .send({})
          .expect(201);
        const out = await request(http)
          .post('/workforce/attendance/clock-out')
          .set(auth(posLate))
          .set('Idempotency-Key', idemKey())
          .send({})
          .expect(200);
        expect((out.body as { earlyDeparture: boolean }).earlyDeparture).toBe(
          true,
        );
      });

      it('28/29: FR-HRM-023 early clock-in — just before rejected, exactly at boundary accepted', async () => {
        await request(http)
          .post('/workforce/attendance/settings')
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({ branchId: branchA, earlyClockInMinutes: 15 })
          .expect(201);

        const schedule = (
          await request(http)
            .post('/workforce/schedules')
            .set(auth(managerTokenA))
            .set('Idempotency-Key', idemKey())
            .send({ branchId: branchA, weekStartDate: '2026-09-28' })
            .expect(201)
        ).body as WithId;

        const emp = await mkPosEmployee('Boundary2829');

        // Just-before case: boundary is 3s in the future at request time.
        const startsAtA = new Date(Date.now() + 15 * 60_000 + 3_000);
        await request(http)
          .post(`/workforce/schedules/${schedule.id}/shifts`)
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({
            employeeId: emp.id,
            startsAt: startsAtA.toISOString(),
            endsAt: new Date(startsAtA.getTime() + 4 * 3600_000).toISOString(),
          })
          .expect(201);

        const posLate1 = await pinLogin(tenantA, terminalA, emp.code, emp.pin);
        await request(http)
          .post('/workforce/attendance/clock-in')
          .set(auth(posLate1))
          .set('Idempotency-Key', idemKey())
          .send({})
          .expect(409);

        // Exactly-at-boundary case: exercised at the SERVICE layer with an
        // injected clock, since no HTTP caller can hit a millisecond-exact
        // wall-clock instant (see `ClockInInput.now`'s doc-comment).
        const startsAtB = new Date('2026-10-05T09:00:00.000Z');
        const scheduleB = (
          await request(http)
            .post('/workforce/schedules')
            .set(auth(managerTokenA))
            .set('Idempotency-Key', idemKey())
            .send({ branchId: branchA, weekStartDate: '2026-10-05' })
            .expect(201)
        ).body as WithId;
        await request(http)
          .post(`/workforce/schedules/${scheduleB.id}/shifts`)
          .set(auth(managerTokenA))
          .set('Idempotency-Key', idemKey())
          .send({
            employeeId: emp.id,
            startsAt: startsAtB.toISOString(),
            endsAt: new Date(startsAtB.getTime() + 4 * 3600_000).toISOString(),
          })
          .expect(201);
        const exactBoundary = new Date(startsAtB.getTime() - 15 * 60_000);
        const accepted = await attendanceService.clockIn(
          tenantA,
          fx().managerUserIdA,
          {
            employeeId: emp.id,
            branchId: branchA,
            terminalId: terminalA,
            now: exactBoundary,
          },
        );
        expect(accepted.status).toBe('open');
        // After-boundary sanity: comfortably past the boundary is accepted
        // too. `now` must stay in the same injected timeline as the
        // clock-in above (real wall-clock "now" is still 2026-09-04, long
        // before `exactBoundary`, and would otherwise violate "clock-out
        // after clock-in").
        await attendanceService.clockOut(tenantA, fx().managerUserIdA, {
          employeeId: emp.id,
          terminalId: terminalA,
          now: new Date(exactBoundary.getTime() + 60_000),
        });
      });
    });

    it('27: missing clock-out is flagged via correction, and the detection query finds stale-open records', async () => {
      const emp27 = await mkPosEmployee('Missing27');
      const posLate = await pinLogin(tenantA, terminalA, emp27.code, emp27.pin);
      const clockIn = await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(posLate))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(201);
      const recordId = (clockIn.body as WithId).id;

      // Backdate the clock-in so the detection query (24h+ threshold) finds it.
      await admin.attendanceRecord.update({
        where: { id: recordId },
        data: { clockInAt: new Date(Date.now() - 30 * 3600_000) },
      });
      const stale = await attendanceService.listOpenPastThreshold(
        tenantA,
        branchA,
        24,
      );
      expect(stale.some((r) => r.id === recordId)).toBe(true);

      const correctedOut = new Date(Date.now() - 20 * 3600_000).toISOString();
      const correction = await request(http)
        .post(`/workforce/attendance/${recordId}/correct`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          field: 'clock_out_at',
          correctedValue: correctedOut,
          reason: 'missing clock-out resolved',
        })
        .expect(201);
      expect((correction.body as { field: string }).field).toBe('clock_out_at');

      const record = await admin.attendanceRecord.findUniqueOrThrow({
        where: { id: recordId },
      });
      expect(record.missingClockOut).toBe(true);
      expect(record.status).toBe('closed');
    });
  });

  // ========================================================= CORRECTION ===

  describe('Manual correction (FR-HRM-025)', () => {
    let recordId: string;
    let originalClockIn: string;

    beforeAll(async () => {
      const posToken = await pinLogin(
        tenantA,
        terminalA,
        `HRC${shortStamp}`,
        PIN_A,
      );
      const res = await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(posToken))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(201);
      recordId = (res.body as WithId).id;
      originalClockIn = (res.body as { clockInAt: string }).clockInAt;
      await request(http)
        .post('/workforce/attendance/clock-out')
        .set(auth(posToken))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(200);
    });

    it('32: needs a reason', async () => {
      await request(http)
        .post(`/workforce/attendance/${recordId}/correct`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          field: 'clock_in_at',
          correctedValue: new Date().toISOString(),
          reason: '',
        })
        .expect(400);
    });

    it('33: needs the hr.attendance.correct permission', async () => {
      await request(http)
        .post(`/workforce/attendance/${recordId}/correct`)
        .set(auth(noPermTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          field: 'clock_in_at',
          correctedValue: new Date().toISOString(),
          reason: 'no permission test',
        })
        .expect(403);
    });

    it('34/35: preserves the original value and creates before/after audit evidence', async () => {
      // The immutable clock event, captured BEFORE the correction — its
      // `occurredAt` is DB-`statement_timestamp()`-defaulted independently
      // of `AttendanceRecord.clockInAt` (an app-computed `now`), so the two
      // are never expected to be byte-identical; what must hold is that
      // THIS row is untouched by the correction (test 34's actual claim).
      const clockEventBefore = await admin.clockEvent.findFirstOrThrow({
        where: { attendanceRecordId: recordId, eventType: 'clock_in' },
      });

      const correctedValue = new Date(Date.now() - 3600_000).toISOString();
      const res = await request(http)
        .post(`/workforce/attendance/${recordId}/correct`)
        .set(auth(managerTokenA))
        .set('Idempotency-Key', idemKey())
        .send({
          field: 'clock_in_at',
          correctedValue,
          reason: 'shift started earlier than recorded',
        })
        .expect(201);
      expect((res.body as { originalValue: string }).originalValue).toBe(
        originalClockIn,
      );

      const clockEventAfter = await admin.clockEvent.findFirstOrThrow({
        where: { id: clockEventBefore.id },
      });
      expect(clockEventAfter.occurredAt.toISOString()).toBe(
        clockEventBefore.occurredAt.toISOString(),
      );

      const auditEntry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          action: 'ATTENDANCE_CORRECTED',
          entityId: (res.body as WithId).id,
        },
      });
      expect(auditEntry).toBeTruthy();
      expect(auditEntry?.beforeState).toBeTruthy();
      expect(auditEntry?.afterState).toBeTruthy();
    });

    it('36: cross-tenant correction fails safely', async () => {
      await request(http)
        .post(`/workforce/attendance/${recordId}/correct`)
        .set(auth(managerTokenB))
        .set('Idempotency-Key', idemKey())
        .send({
          field: 'clock_in_at',
          correctedValue: new Date().toISOString(),
          reason: 'cross-tenant attempt',
        })
        .expect(404);
    });
  });

  // ========================================================= CONCURRENCY ===

  describe('Concurrency', () => {
    it('37: two simultaneous clock-ins for the same employee produce exactly one open record', async () => {
      const create = await workforceEmployees.create(
        tenantA,
        fx().managerUserIdA,
        {
          code: `CC1${shortStamp}`,
          displayName: 'Concurrency One',
          homeBranchId: branchA,
          employmentType: 'full_time',
        },
      );
      await admin.employeeBranch
        .create({
          data: { tenantId: tenantA, employeeId: create.id, branchId: branchA },
        })
        .catch(() => undefined);

      const attempt = () =>
        attendanceService
          .clockIn(tenantA, fx().managerUserIdA, {
            employeeId: create.id,
            branchId: branchA,
            terminalId: terminalA,
          })
          .then(() => 'ok' as const)
          .catch(() => 'rejected' as const);

      const results = await Promise.all([attempt(), attempt()]);
      expect(results.filter((r) => r === 'ok').length).toBe(1);
      expect(results.filter((r) => r === 'rejected').length).toBe(1);

      const openCount = await admin.attendanceRecord.count({
        where: { tenantId: tenantA, employeeId: create.id, status: 'open' },
      });
      expect(openCount).toBe(1);
    });

    it('38: two simultaneous clock-outs close exactly once', async () => {
      const create = await workforceEmployees.create(
        tenantA,
        fx().managerUserIdA,
        {
          code: `CC2${shortStamp}`,
          displayName: 'Concurrency Two',
          homeBranchId: branchA,
          employmentType: 'full_time',
        },
      );
      await attendanceService.clockIn(tenantA, fx().managerUserIdA, {
        employeeId: create.id,
        branchId: branchA,
        terminalId: terminalA,
      });

      const attempt = () =>
        attendanceService
          .clockOut(tenantA, fx().managerUserIdA, {
            employeeId: create.id,
            terminalId: terminalA,
          })
          .then(() => 'ok' as const)
          .catch(() => 'rejected' as const);

      const results = await Promise.all([attempt(), attempt()]);
      expect(results.filter((r) => r === 'ok').length).toBe(1);
      expect(results.filter((r) => r === 'rejected').length).toBe(1);

      const closeEvents = await admin.clockEvent.count({
        where: {
          tenantId: tenantA,
          employeeId: create.id,
          eventType: 'clock_out',
        },
      });
      expect(closeEvents).toBe(1);
    });

    it('39: a manual correction race never erases history', async () => {
      const posToken = await pinLogin(
        tenantA,
        terminalA,
        `HRC${shortStamp}`,
        PIN_A,
      );
      const clockIn = await request(http)
        .post('/workforce/attendance/clock-in')
        .set(auth(posToken))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(201);
      const recordId = (clockIn.body as WithId).id;
      await request(http)
        .post('/workforce/attendance/clock-out')
        .set(auth(posToken))
        .set('Idempotency-Key', idemKey())
        .send({})
        .expect(200);

      const attendanceCorrections = app.get(AttendanceCorrectionService);
      const attempt = (minutes: number) =>
        attendanceCorrections.correct(tenantA, fx().managerUserIdA, recordId, {
          field: 'clock_in_at',
          correctedValue: new Date(Date.now() - minutes * 60_000),
          reason: `race attempt ${minutes}`,
        });

      await Promise.all([attempt(10), attempt(20)]);

      const correctionCount = await admin.attendanceCorrection.count({
        where: { attendanceRecordId: recordId },
      });
      expect(correctionCount).toBe(2);
    });
  });
});
