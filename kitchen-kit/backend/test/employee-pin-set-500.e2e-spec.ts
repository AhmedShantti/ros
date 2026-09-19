import { ConflictException } from '@nestjs/common';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { CredentialsService } from './../src/modules/identity/credentials/credentials.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { createMigratorClient } from './rls-admin';

/**
 * EMPLOYEE-PIN-SET-500-P0.
 *
 * Proves the three-phase `PinService.setPin` fix
 * (docs/reports/claude/2026-09-19_EMPLOYEE-PIN-SET-500-P0_investigation.md):
 * a large existing-branch-PIN-credential count no longer produces
 * `PrismaClientKnownRequestError` P2028 (root cause: the FR-SEC-022
 * uniqueness verification loop used to run entirely inside a single
 * 5000ms-default Prisma interactive transaction), while FR-SEC-022
 * uniqueness, concurrency safety, the per-tenant advisory lock, and audit
 * integrity are all still enforced — including for the two race windows a
 * split-into-phases design newly has to defend against (a credential
 * created, or rotated, between the Phase 1 snapshot and the Phase 3 write).
 */

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('EMPLOYEE-PIN-SET-500-P0 — setPin three-phase fix (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let employees: EmployeesService;
  let pins: PinService;
  let creds: CredentialsService;

  let tenantId: string;
  let branchId: string;
  let actorId: string;

  const mkUser = async (email: string) => {
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const u = await users.createUser({ email, password, displayName: 'P' });
    await memberships.grant(u.id, tenantId, 'active');
    return u.id;
  };

  const mkEmployee = async (code: string, userId?: string) =>
    employees.create(tenantId, actorId, {
      code,
      displayName: code,
      homeBranchId: branchId,
      userId,
    });

  /** Directly write a PIN credential (bypassing PinService.setPin) — for
   *  fast test-fixture padding and for simulating a race-window DB change. */
  const writePinCredential = async (userId: string, secretHash: string) =>
    admin.credential.upsert({
      where: { userId_credentialType: { userId, credentialType: 'pin' } },
      create: { id: newId(), userId, credentialType: 'pin', secretHash, pinForTerminal: true },
      update: { secretHash, rotatedAt: new Date() },
    });

  /**
   * A bare padding neighbour, written directly via the migrator client —
   * NO `UsersService.createUser` (which itself hashes a login password with
   * the same expensive Argon2id params — irrelevant noise for a fixture
   * whose only job is to exist as a PIN-holding neighbour) and no
   * `EmployeesService.create` transaction/audit overhead. Keeps the
   * large-N regression fixture's setup cost from itself becoming the
   * bottleneck under a parallel full-suite run.
   */
  const mkPaddingNeighbour = async (code: string, secretHash: string) => {
    const userId = newId();
    await admin.user.create({
      data: {
        id: userId,
        email: `pin500.pad.${code}.${stamp}@example.com`,
        displayName: code,
      },
    });
    const employeeId = newId();
    await admin.employee.create({
      data: { id: employeeId, tenantId, code, displayName: code, homeBranchId: branchId, userId },
    });
    await admin.employeeBranch.create({
      data: { tenantId, employeeId, branchId },
    });
    await writePinCredential(userId, secretHash);
    return { userId, employeeId };
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    admin = createMigratorClient(app);
    employees = app.get(EmployeesService);
    pins = app.get(PinService);
    creds = app.get(CredentialsService);

    const tenants = app.get(TenantsService);
    tenantId = (
      await tenants.create({
        slug: `pin500-${stamp}`,
        legalName: 'Pin500',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: 'Pin500 Brand' },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `P5${stamp % 10000}`,
        name: 'Pin500 Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.location.create({
      data: { id: newId(), tenantId, locationType: 'branch', refId: branch.id, branchId: branch.id },
    });
    branchId = branch.id;
    actorId = await mkUser(`pin500.actor.${stamp}@example.com`);
  }, 90_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  }, 90_000);

  // ---------------------------------------------------------------- 1 -----
  it('large-N regression: 220 pre-existing branch PIN credentials no longer produce P2028 — setPin succeeds', async () => {
    const N = 220;
    // One precomputed decoy hash, reused for every padding row: cheap setup,
    // and correctness doesn't depend on the padding PINs being distinct from
    // EACH OTHER — only from the candidate under test.
    const decoyHash = await creds.hashPassword('700000');
    for (let i = 0; i < N; i += 1) {
      await mkPaddingNeighbour(`P5PAD${i}${stamp % 1000}`, decoyHash);
    }

    const targetUser = await mkUser(`pin500.target.${stamp}@example.com`);
    const target = await mkEmployee(`P5TGT${stamp % 1000}`, targetUser);

    let caught: unknown = null;
    try {
      await pins.setPin(tenantId, actorId, target.id, '9999');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeNull();
    const cred = await admin.credential.findUnique({
      where: { userId_credentialType: { userId: targetUser, credentialType: 'pin' } },
    });
    expect(cred).not.toBeNull();
    expect(cred!.secretHash.startsWith('$argon2')).toBe(true);
  }, 180_000);

  // ---------------------------------------------------------------- 2 -----
  it('existing PIN collision: candidate equal to a Phase-1 neighbour PIN -> 409', async () => {
    const holderUser = await mkUser(`pin500.holder.${stamp}@example.com`);
    const holder = await mkEmployee(`P5HOLD${stamp % 1000}`, holderUser);
    await pins.setPin(tenantId, actorId, holder.id, '2468');

    const candidateUser = await mkUser(`pin500.cand.${stamp}@example.com`);
    const candidate = await mkEmployee(`P5CAND${stamp % 1000}`, candidateUser);

    await expect(pins.setPin(tenantId, actorId, candidate.id, '2468')).rejects.toThrow(
      ConflictException,
    );
    await expect(pins.setPin(tenantId, actorId, candidate.id, '2468')).rejects.toThrow(
      /unique within a branch/i,
    );

    const cred = await admin.credential.findUnique({
      where: { userId_credentialType: { userId: candidateUser, credentialType: 'pin' } },
    });
    expect(cred).toBeNull();
  }, 90_000);

  // ---------------------------------------------------------------- 3 -----
  it('race-window NEW credential: a colliding credential created after Phase 1 is caught by the Phase 3 delta re-check -> 409, no write', async () => {
    // A modest padding set so Phase 1 + Phase 2 (candidate hash + N verifies)
    // takes a comfortable, measurable window — long enough to reliably land
    // the admin write below strictly between Phase 1 and Phase 3.
    const decoyHash = await creds.hashPassword('611111');
    for (let i = 0; i < 25; i += 1) {
      await mkPaddingNeighbour(`P5RNP${i}${stamp % 1000}`, decoyHash);
    }

    const targetUser = await mkUser(`pin500.rn.target.${stamp}@example.com`);
    const target = await mkEmployee(`P5RNTGT${stamp % 1000}`, targetUser);

    const racerUser = await mkUser(`pin500.rn.racer.${stamp}@example.com`);
    await mkEmployee(`P5RNRACE${stamp % 1000}`, racerUser);
    const candidatePin = '834721';
    const candidateHash = await creds.hashPassword(candidatePin);

    const setPinPromise = pins.setPin(tenantId, actorId, target.id, candidatePin);
    // Phase 1 (a handful of fast reads) has certainly completed by 150ms;
    // Phase 2's 25-way Argon2 verify loop has certainly NOT — this write
    // lands squarely in that window, simulating a NEW credential racing in
    // after the Phase 1 snapshot was taken.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writePinCredential(racerUser, candidateHash);

    await expect(setPinPromise).rejects.toThrow(ConflictException);
    await expect(setPinPromise).rejects.toThrow(/unique within a branch/i);

    const cred = await admin.credential.findUnique({
      where: { userId_credentialType: { userId: targetUser, credentialType: 'pin' } },
    });
    expect(cred).toBeNull();
  }, 90_000);

  // ---------------------------------------------------------------- 4 -----
  it('race-window ROTATED credential: an existing neighbour credential rotated to the candidate PIN after Phase 1 is caught by the Phase 3 delta re-check -> 409, no write', async () => {
    const decoyHash = await creds.hashPassword('622222');
    for (let i = 0; i < 25; i += 1) {
      await mkPaddingNeighbour(`P5RRP${i}${stamp % 1000}`, decoyHash);
    }

    const targetUser = await mkUser(`pin500.rr.target.${stamp}@example.com`);
    const target = await mkEmployee(`P5RRTGT${stamp % 1000}`, targetUser);

    // A neighbour who ALREADY holds a (different) PIN at Phase 1 time — its
    // credential ROW exists in the Phase 1 snapshot with the OLD hash.
    const rotatorUser = await mkUser(`pin500.rr.rotator.${stamp}@example.com`);
    await mkEmployee(`P5RRROT${stamp % 1000}`, rotatorUser);
    const oldHash = await creds.hashPassword('555000');
    await writePinCredential(rotatorUser, oldHash);

    const candidatePin = '947210';
    const newHash = await creds.hashPassword(candidatePin);

    const setPinPromise = pins.setPin(tenantId, actorId, target.id, candidatePin);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Same credential ROW, rotated to a DIFFERENT hash after the Phase 1
    // snapshot captured the old one — this is the "existed but hash changed"
    // delta branch, never a timestamp comparison.
    await writePinCredential(rotatorUser, newHash);

    await expect(setPinPromise).rejects.toThrow(ConflictException);

    const cred = await admin.credential.findUnique({
      where: { userId_credentialType: { userId: targetUser, credentialType: 'pin' } },
    });
    expect(cred).toBeNull();
  }, 90_000);

  // ---------------------------------------------------------------- 5 -----
  it('true concurrent collision: two setPin calls with the same candidate PIN and overlapping snapshots -> exactly one succeeds, the other conflicts', async () => {
    const u1 = await mkUser(`pin500.race1.${stamp}@example.com`);
    const u2 = await mkUser(`pin500.race2.${stamp}@example.com`);
    const e1 = await mkEmployee(`P5RACE1${stamp % 1000}`, u1);
    const e2 = await mkEmployee(`P5RACE2${stamp % 1000}`, u2);

    const results = await Promise.allSettled([
      pins.setPin(tenantId, actorId, e1.id, '135790'),
      pins.setPin(tenantId, actorId, e2.id, '135790'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);
  }, 90_000);

  // ---------------------------------------------------------------- 6 -----
  it('non-colliding concurrent assignments both succeed', async () => {
    const u1 = await mkUser(`pin500.ok1.${stamp}@example.com`);
    const u2 = await mkUser(`pin500.ok2.${stamp}@example.com`);
    const e1 = await mkEmployee(`P5OK1${stamp % 1000}`, u1);
    const e2 = await mkEmployee(`P5OK2${stamp % 1000}`, u2);

    const results = await Promise.allSettled([
      pins.setPin(tenantId, actorId, e1.id, '111222'),
      pins.setPin(tenantId, actorId, e2.id, '333444'),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const c1 = await admin.credential.findUnique({
      where: { userId_credentialType: { userId: u1, credentialType: 'pin' } },
    });
    const c2 = await admin.credential.findUnique({
      where: { userId_credentialType: { userId: u2, credentialType: 'pin' } },
    });
    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
  }, 90_000);

  // ---------------------------------------------------------------- 7 -----
  describe('audit integrity', () => {
    it('a successful setPin writes exactly one PIN_SET audit entry', async () => {
      const u = await mkUser(`pin500.audit.ok.${stamp}@example.com`);
      const e = await mkEmployee(`P5AUDOK${stamp % 1000}`, u);

      await pins.setPin(tenantId, actorId, e.id, '246813');

      const rows = await admin.auditEntry.findMany({
        where: { tenantId, action: 'PIN_SET', entityId: e.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe(actorId);
      expect(JSON.stringify(rows[0]!.afterState ?? {})).not.toContain('246813');
    }, 90_000);

    it('a conflict leaves no credential AND no audit entry (no partial write)', async () => {
      const holderUser = await mkUser(`pin500.audit.holder.${stamp}@example.com`);
      const holder = await mkEmployee(`P5AUDH${stamp % 1000}`, holderUser);
      await pins.setPin(tenantId, actorId, holder.id, '975310');

      const loserUser = await mkUser(`pin500.audit.loser.${stamp}@example.com`);
      const loser = await mkEmployee(`P5AUDL${stamp % 1000}`, loserUser);

      await expect(pins.setPin(tenantId, actorId, loser.id, '975310')).rejects.toThrow(
        ConflictException,
      );

      const cred = await admin.credential.findUnique({
        where: { userId_credentialType: { userId: loserUser, credentialType: 'pin' } },
      });
      expect(cred).toBeNull();
      const rows = await admin.auditEntry.findMany({
        where: { tenantId, action: 'PIN_SET', entityId: loser.id },
      });
      expect(rows).toHaveLength(0);
    }, 90_000);
  });
});
