import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
}

const password = 's3cure-passphrase';
const stamp = Date.now();

/**
 * FR-SEC-020 / FR-SEC-021 / FR-SEC-022 — PIN authentication, plus the D-2
 * amendment substrate (Employee, permitted branches, Terminal→Branch binding).
 */
describe('PIN authentication (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let employees: EmployeesService;
  let pins: PinService;

  let tenantA: string;
  let tenantB: string;
  let branchA1: string;
  let branchA2: string;
  let branchB: string;
  let terminalA1: string;
  let terminalA2: string;
  let terminalB: string;
  let actorA: string;

  // employee in branchA1 only
  let empAlice: string;
  let aliceUser: string;
  // employee in branchA2 only
  let empBob: string;
  // employee in BOTH A1 and A2
  let empCarol: string;

  const mkBranch = async (tenantId: string, code: string): Promise<string> => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `PinBrand ${code}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code,
        name: `PinBranch ${code}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
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
    return branch.id;
  };

  const mkTerminal = async (
    tenantId: string,
    branchId: string,
    name: string,
  ): Promise<string> => {
    const t = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId,
        branchId,
        name,
        terminalType: 'pos',
        status: 'active',
      },
    });
    return t.id;
  };

  const mkUser = async (email: string, tenantId: string): Promise<string> => {
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const u = await users.createUser({ email, password, displayName: 'P' });
    await memberships.grant(u.id, tenantId, 'active');
    return u.id;
  };

  const pinLogin = (body: Record<string, unknown>) =>
    request(http).post('/auth/pin').send(body);

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
    employees = app.get(EmployeesService);
    pins = app.get(PinService);

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `pina-${stamp}`,
        legalName: 'PinA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `pinb-${stamp}`,
        legalName: 'PinB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    branchA1 = await mkBranch(tenantA, `P1${stamp % 10000}`);
    branchA2 = await mkBranch(tenantA, `P2${stamp % 10000}`);
    branchB = await mkBranch(tenantB, `PB${stamp % 10000}`);

    terminalA1 = await mkTerminal(tenantA, branchA1, 'A1-POS');
    terminalA2 = await mkTerminal(tenantA, branchA2, 'A2-POS');
    terminalB = await mkTerminal(tenantB, branchB, 'B-POS');

    actorA = await mkUser(`pin.actor.${stamp}@example.com`, tenantA);
    aliceUser = await mkUser(`pin.alice.${stamp}@example.com`, tenantA);
    const bobUser = await mkUser(`pin.bob.${stamp}@example.com`, tenantA);
    const carolUser = await mkUser(`pin.carol.${stamp}@example.com`, tenantA);

    empAlice = (
      await employees.create(tenantA, actorA, {
        code: `ALICE${stamp % 1000}`,
        displayName: 'Alice',
        homeBranchId: branchA1,
        userId: aliceUser,
      })
    ).id;
    empBob = (
      await employees.create(tenantA, actorA, {
        code: `BOB${stamp % 1000}`,
        displayName: 'Bob',
        homeBranchId: branchA2,
        userId: bobUser,
      })
    ).id;
    empCarol = (
      await employees.create(tenantA, actorA, {
        code: `CAROL${stamp % 1000}`,
        displayName: 'Carol',
        homeBranchId: branchA1,
        userId: carolUser,
        permittedBranchIds: [branchA2],
      })
    ).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // ------------------------------------------------- Employee substrate ---
  describe('Employee / User / branch substrate (D-2 amendment)', () => {
    it('links at most one User per Employee (SRS §7.3 #25)', async () => {
      await expect(
        employees.create(tenantA, actorA, {
          code: `DUP${stamp % 1000}`,
          displayName: 'Dup',
          homeBranchId: branchA1,
          userId: aliceUser,
        }),
      ).rejects.toThrow(/at most one/i);
    });

    it('an employee may have no User at all (SRS §14)', async () => {
      const e = await employees.create(tenantA, actorA, {
        code: `NOUSER${stamp % 1000}`,
        displayName: 'No User',
        homeBranchId: branchA1,
      });
      expect(e.userId).toBeNull();
    });

    it('the home branch is always a permitted branch', async () => {
      const permitted = await employees.permittedBranchIds(tenantA, empAlice);
      expect(permitted).toContain(branchA1);
    });

    it('supports multiple permitted branches (FR-HRM-005)', async () => {
      const permitted = await employees.permittedBranchIds(tenantA, empCarol);
      expect(permitted).toEqual(expect.arrayContaining([branchA1, branchA2]));
    });

    it('rejects a home branch from another tenant (404 under RLS)', async () => {
      await expect(
        employees.create(tenantA, actorA, {
          code: `XT${stamp % 1000}`,
          displayName: 'Cross',
          homeBranchId: branchB,
        }),
      ).rejects.toThrow(/Branch not found/);
    });

    it('cannot be read across tenants', async () => {
      const seen = await employees.list(tenantB);
      expect(seen.map((e) => e.id)).not.toContain(empAlice);
    });

    it('the DATABASE refuses a cross-tenant home branch even without the service', async () => {
      await expect(
        admin.employee.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            code: `DBX${stamp % 1000}`,
            displayName: 'DB cross',
            homeBranchId: branchB, // tenant B's branch
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------ Terminal → Branch ---
  describe('Terminal → Branch integrity (FR-SEC-021 trust)', () => {
    it('the DATABASE refuses a terminal bound to another tenant’s branch', async () => {
      await expect(
        admin.terminal.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchB,
            name: 'X-POS',
            terminalType: 'pos',
          },
        }),
      ).rejects.toThrow();
    });

    it('the DATABASE refuses a terminal bound to a non-existent branch', async () => {
      await expect(
        admin.terminal.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: newId(),
            name: 'Y-POS',
            terminalType: 'pos',
          },
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------- PIN storage ---
  describe('PIN storage and shape (FR-SEC-020 / FR-SEC-022)', () => {
    it('accepts a 4-digit PIN', async () => {
      await expect(
        pins.setPin(tenantA, actorA, empAlice, '1234'),
      ).resolves.toBeUndefined();
    });

    it('accepts an 8-digit PIN', async () => {
      await expect(
        pins.setPin(tenantA, actorA, empBob, '87654321'),
      ).resolves.toBeUndefined();
    });

    it('rejects a PIN outside 4–8 digits', async () => {
      await expect(
        pins.setPin(tenantA, actorA, empAlice, '123'),
      ).rejects.toThrow(/4 to 8 digits/);
      await expect(
        pins.setPin(tenantA, actorA, empAlice, '123456789'),
      ).rejects.toThrow(/4 to 8 digits/);
    });

    it('rejects a non-digit PIN', async () => {
      await expect(
        pins.setPin(tenantA, actorA, empAlice, 'abcd'),
      ).rejects.toThrow(/4 to 8 digits/);
    });

    it('stores the PIN only as a salted Argon2 hash — never in plaintext', async () => {
      const cred = await admin.credential.findFirst({
        where: { userId: aliceUser, credentialType: 'pin' },
      });
      expect(cred).not.toBeNull();
      expect(cred!.secretHash.startsWith('$argon2')).toBe(true);
      expect(cred!.secretHash).not.toContain('1234');
      // Salted: the same PIN for another employee yields a different hash.
      await pins.setPin(tenantA, actorA, empCarol, '4321');
      const other = await admin.credential.findFirst({
        where: { credentialType: 'pin', userId: { not: aliceUser } },
      });
      expect(other!.secretHash).not.toBe(cred!.secretHash);
    });

    it('never writes the PIN into the audit payload', async () => {
      const rows = await admin.auditEntry.findMany({
        where: { tenantId: tenantA, action: 'PIN_SET' },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(JSON.stringify(r.afterState ?? {})).not.toContain('1234');
        expect(JSON.stringify(r.beforeState ?? {})).not.toContain('1234');
      }
    });

    it('an employee with no linked user cannot hold a PIN', async () => {
      const e = await employees.create(tenantA, actorA, {
        code: `NOPIN${stamp % 1000}`,
        displayName: 'No PIN',
        homeBranchId: branchA1,
      });
      await expect(pins.setPin(tenantA, actorA, e.id, '5555')).rejects.toThrow(
        /no linked user/i,
      );
    });
  });

  // ------------------------------------------- FR-SEC-022 branch uniqueness ---
  describe('branch PIN uniqueness (FR-SEC-022)', () => {
    it('rejects a duplicate PIN within the same branch', async () => {
      // Alice holds 1234 in branchA1; Carol is also permitted in branchA1.
      await expect(
        pins.setPin(tenantA, actorA, empCarol, '1234'),
      ).rejects.toThrow(/unique within a branch/i);
    });

    it('permits the same PIN in disjoint branches', async () => {
      // Bob is only in branchA2, where nobody holds 1234.
      await expect(
        pins.setPin(tenantA, actorA, empBob, '1234'),
      ).resolves.toBeUndefined();
    });

    it('concurrent assignment cannot introduce a branch collision', async () => {
      const u1 = await mkUser(`pin.c1.${stamp}@example.com`, tenantA);
      const u2 = await mkUser(`pin.c2.${stamp}@example.com`, tenantA);
      const e1 = await employees.create(tenantA, actorA, {
        code: `CC1${stamp % 1000}`,
        displayName: 'C1',
        homeBranchId: branchA2,
        userId: u1,
      });
      const e2 = await employees.create(tenantA, actorA, {
        code: `CC2${stamp % 1000}`,
        displayName: 'C2',
        homeBranchId: branchA2,
        userId: u2,
      });

      // Both race to claim the same PIN in the same branch. The per-tenant
      // advisory lock serialises them, so exactly one may win.
      const results = await Promise.allSettled([
        pins.setPin(tenantA, actorA, e1.id, '9090'),
        pins.setPin(tenantA, actorA, e2.id, '9090'),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
    });
  });

  // --------------------------------------------------- FR-SEC-021 login ---
  describe('PIN authentication (FR-SEC-021)', () => {
    it('authenticates with the correct PIN on a permitted-branch terminal', async () => {
      const res = await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '1234',
      }).expect(200);
      expect((res.body as Tokens).accessToken).toBeTruthy();
    });

    it('rejects a wrong PIN', async () => {
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '0000',
      }).expect(401);
    });

    it('rejects a terminal in a branch the employee is not permitted in', async () => {
      // Alice is permitted only in branchA1; terminalA2 lives in branchA2.
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA2,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '1234',
      }).expect(401);
    });

    it('rejects a revoked terminal immediately', async () => {
      const revoked = await mkTerminal(tenantA, branchA1, 'REVOKED');
      await admin.terminal.update({
        where: { id: revoked },
        data: { status: 'revoked' },
      });
      await pinLogin({
        tenantId: tenantA,
        terminalId: revoked,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '1234',
      }).expect(401);
    });

    it('rejects an unregistered terminal id', async () => {
      await pinLogin({
        tenantId: tenantA,
        terminalId: newId(),
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '1234',
      }).expect(401);
    });

    it('enforces the tenant boundary: tenant B terminal, tenant A employee', async () => {
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalB,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '1234',
      }).expect(401);
    });

    it('rejects a malformed PIN at the DTO boundary', async () => {
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: 'abcd',
      }).expect(400);
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '12',
      }).expect(400);
    });

    it('rejects unknown fields (global whitelist)', async () => {
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '1234',
        rogue: true,
      }).expect(400);
    });
  });

  // ------------------------------------------------ FR-SEC-022 lockout ---
  describe('lockout (FR-SEC-022)', () => {
    it('locks after the configured number of failures and then rejects the CORRECT PIN', async () => {
      const u = await mkUser(`pin.lock.${stamp}@example.com`, tenantA);
      const e = await employees.create(tenantA, actorA, {
        code: `LOCK${stamp % 1000}`,
        displayName: 'Lock',
        homeBranchId: branchA1,
        userId: u,
      });
      await pins.setPin(tenantA, actorA, e.id, '7777');

      const attempt = (pin: string) =>
        pinLogin({
          tenantId: tenantA,
          terminalId: terminalA1,
          employeeCode: `LOCK${stamp % 1000}`,
          pin,
        });

      // Configured threshold (env.validation default 5, documented as an
      // implementation-level value — FR-SEC-022 states no number).
      const threshold = 5;
      for (let i = 0; i < threshold; i++) {
        await attempt('0000').expect(401);
      }

      const cred = await admin.credential.findFirst({
        where: { userId: u, credentialType: 'pin' },
      });
      expect(cred!.lockedUntil).not.toBeNull();

      // The CORRECT PIN is now refused — the lock, not the PIN, decides.
      await attempt('7777').expect(401);
    });

    it('the failure counter increments before the threshold', async () => {
      const u = await mkUser(`pin.count.${stamp}@example.com`, tenantA);
      const e = await employees.create(tenantA, actorA, {
        code: `CNT${stamp % 1000}`,
        displayName: 'Count',
        homeBranchId: branchA2,
        userId: u,
      });
      await pins.setPin(tenantA, actorA, e.id, '6666');
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA2,
        employeeCode: `CNT${stamp % 1000}`,
        pin: '0001',
      }).expect(401);

      const cred = await admin.credential.findFirst({
        where: { userId: u, credentialType: 'pin' },
      });
      expect(cred!.failedAttempts).toBe(1);
      expect(cred!.lockedUntil).toBeNull();
    });

    it('a successful authentication clears the counter', async () => {
      const u = await mkUser(`pin.clear.${stamp}@example.com`, tenantA);
      const e = await employees.create(tenantA, actorA, {
        code: `CLR${stamp % 1000}`,
        displayName: 'Clear',
        homeBranchId: branchA1,
        userId: u,
      });
      await pins.setPin(tenantA, actorA, e.id, '8181');

      // One failure, then a success — the counter must be back to zero.
      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `CLR${stamp % 1000}`,
        pin: '0002',
      }).expect(401);
      const afterFail = await admin.credential.findFirst({
        where: { userId: u, credentialType: 'pin' },
      });
      expect(afterFail!.failedAttempts).toBe(1);

      await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `CLR${stamp % 1000}`,
        pin: '8181',
      }).expect(200);
      const afterOk = await admin.credential.findFirst({
        where: { userId: u, credentialType: 'pin' },
      });
      expect(afterOk!.failedAttempts).toBe(0);
      expect(afterOk!.lockedUntil).toBeNull();
    });
  });

  // ------------------------------------- FR-SEC-021 no dashboard access ---
  describe('PIN sessions are POS-only (FR-SEC-021)', () => {
    let posToken: string;

    beforeAll(async () => {
      const res = await pinLogin({
        tenantId: tenantA,
        terminalId: terminalA1,
        employeeCode: `ALICE${stamp % 1000}`,
        pin: '1234',
      }).expect(200);
      posToken = (res.body as Tokens).accessToken;
    });

    it('cannot reach a back-office endpoint', async () => {
      await request(http)
        .get('/auth/me')
        .set('Authorization', `Bearer ${posToken}`)
        .expect(403);
    });

    it('cannot reach catalogue management endpoints', async () => {
      await request(http)
        .get('/catalogue/price-lists')
        .set('Authorization', `Bearer ${posToken}`)
        .expect(403);
    });

    it('cannot reach organisation endpoints', async () => {
      await request(http)
        .get('/org/brands')
        .set('Authorization', `Bearer ${posToken}`)
        .expect(403);
    });

    it('carries the terminal and POS audience in the token', () => {
      const [, payload] = posToken.split('.');
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { typ?: string; trm?: string; tid?: string };
      expect(claims.typ).toBe('pos');
      expect(claims.trm).toBe(terminalA1);
      expect(claims.tid).toBe(tenantA);
    });
  });
});
