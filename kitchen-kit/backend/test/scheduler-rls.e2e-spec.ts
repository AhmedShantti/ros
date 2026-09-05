import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';
import {
  FIXED_KEY,
  FIXED_NOW,
  TEST_JOB,
  TestJobControl,
  bootSchedulerApp,
  clearScheduler,
  createSchedulerTenant,
  onlyJob,
  readOccurrences,
  runnerOf,
} from './scheduler-fixtures';

/**
 * SCHED-1 — the tenant boundary around the scheduler's own tables.
 *
 * The design question this suite answers is the one a scheduler most easily
 * gets wrong: a background worker has no HTTP request, no JWT and no tenant
 * context handed to it, so it is tempting to give it a privileged connection
 * and let it scan every tenant in one query. This repository forbids that —
 * `FR-PLT-011` is ratified ("the application database role SHALL NOT have
 * BYPASSRLS") — so the substrate instead opens a tenant-scoped transaction per
 * tenant, exactly like a request-path caller.
 *
 * Everything below is exercised through the RLS-constrained runtime role
 * (`ros_app`, via `PrismaService`). The migrator client is used only to arrange
 * fixtures and to observe true row state — never as evidence of isolation.
 */
describe('Scheduler RLS / tenant isolation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService; // ros_app (NOBYPASSRLS)
  let admin: PrismaClient; // ros_migrator (arrange/observe only)
  let tenantA: string;
  let tenantB: string;

  const PLATFORM_TABLES = ['job_schedules', 'job_occurrences', 'job_findings'];

  beforeAll(async () => {
    app = await bootSchedulerApp();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);
    tenantA = await createSchedulerTenant(admin, 'rls-a');
    tenantB = await createSchedulerTenant(admin, 'rls-b');
  }, 90_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    TestJobControl.reset();
    await clearScheduler(admin, [tenantA, tenantB]);
  });

  // ── Schema-level guarantees ───────────────────────────────────────────────

  it('every platform scheduler table has RLS ENABLED and FORCED', async () => {
    const rows = await admin.$queryRawUnsafe<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...PLATFORM_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      // FORCE matters specifically here: without it the table OWNER would
      // bypass its own policies, and a future migration or admin tool running
      // as the owner could silently read across tenants.
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('every platform scheduler table carries all four tenant policies', async () => {
    const rows = await admin.$queryRawUnsafe<
      { relname: string; polname: string }[]
    >(
      `SELECT c.relname, p.polname
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform'
        ORDER BY c.relname, p.polname`,
    );
    for (const table of PLATFORM_TABLES) {
      const names = rows
        .filter((r) => r.relname === table)
        .map((r) => r.polname);
      expect(names.sort()).toEqual(
        [
          `${table}_delete`,
          `${table}_insert`,
          `${table}_select`,
          `${table}_update`,
        ].sort(),
      );
    }
  });

  it('the runtime role has DML but no ownership on the scheduler tables', async () => {
    const rows = await admin.$queryRawUnsafe<
      { table_name: string; privilege_type: string }[]
    >(
      `SELECT table_name, privilege_type
         FROM information_schema.table_privileges
        WHERE table_schema = 'platform' AND grantee = 'ros_app'
        ORDER BY table_name, privilege_type`,
    );
    for (const table of PLATFORM_TABLES) {
      const privileges = rows
        .filter((r) => r.table_name === table)
        .map((r) => r.privilege_type)
        .sort();
      expect(privileges).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });

  // ── Runtime isolation as ros_app ──────────────────────────────────────────

  it("tenant A's context cannot SEE tenant B's occurrences", async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    await onlyJob(admin, tenantB, TEST_JOB.BASIC);
    await runnerOf(app).runTick({
      now: FIXED_NOW,
      tenantIds: [tenantA, tenantB],
      claimBatch: 50,
    });

    // Both really exist, observed as the owner.
    expect(await readOccurrences(admin, tenantA, TEST_JOB.BASIC)).toHaveLength(
      1,
    );
    expect(await readOccurrences(admin, tenantB, TEST_JOB.BASIC)).toHaveLength(
      1,
    );

    const seenByA = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
      tx.scheduledJobOccurrence.findMany({}),
    );
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((o) => o.tenantId === tenantA)).toBe(true);
    expect(seenByA.some((o) => o.tenantId === tenantB)).toBe(false);
  });

  it("tenant A's context cannot SEE tenant B's findings", async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    await onlyJob(admin, tenantB, TEST_JOB.BASIC);
    await runnerOf(app).runTick({
      now: FIXED_NOW,
      tenantIds: [tenantA, tenantB],
      claimBatch: 50,
    });

    const findingsForA = await prisma.withAuthContext(
      { tenantId: tenantA },
      (tx) => tx.scheduledJobFinding.findMany({}),
    );
    expect(findingsForA.length).toBeGreaterThan(0);
    expect(findingsForA.every((f) => f.tenantId === tenantA)).toBe(true);
  });

  it('a query with NO tenant context sees NOTHING — the policies fail closed', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    await runnerOf(app).runTick({
      now: FIXED_NOW,
      tenantIds: [tenantA],
      claimBatch: 50,
    });
    expect(await readOccurrences(admin, tenantA, TEST_JOB.BASIC)).toHaveLength(
      1,
    );

    // This is the SPECIFIC property that makes a per-tenant worker safe: a
    // worker that forgot its tenant context reads an empty set, not the fleet.
    const withoutContext = await prisma.withAuthContext({}, (tx) =>
      tx.scheduledJobOccurrence.findMany({}),
    );
    expect(withoutContext).toEqual([]);
    const schedules = await prisma.withAuthContext({}, (tx) =>
      tx.scheduledJobSchedule.findMany({}),
    );
    expect(schedules).toEqual([]);
    const findings = await prisma.withAuthContext({}, (tx) =>
      tx.scheduledJobFinding.findMany({}),
    );
    expect(findings).toEqual([]);
  });

  it("the scheduler's own CLAIM under tenant A cannot claim tenant B's occurrence", async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    await onlyJob(admin, tenantB, TEST_JOB.BASIC);

    // Materialise for BOTH tenants, then tick for A only.
    await admin.scheduledJobOccurrence.createMany({
      data: [tenantA, tenantB].map((tenantId) => ({
        tenantId,
        jobType: TEST_JOB.BASIC,
        occurrenceKey: FIXED_KEY,
        scheduledFor: new Date('2026-09-03T03:00:00Z'),
        maxAttempts: 3,
        nextAttemptAt: new Date('2026-09-03T03:00:00Z'),
      })),
    });

    const result = await runnerOf(app).runTick({
      now: FIXED_NOW,
      tenantIds: [tenantA],
      claimBatch: 50,
    });
    expect(result.claimed).toBe(1);

    const b = await admin.scheduledJobOccurrence.findUnique({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId: tenantB,
          jobType: TEST_JOB.BASIC,
          occurrenceKey: FIXED_KEY,
        },
      },
    });
    // Untouched: still pending, attempt 0, no lease.
    expect(b?.state).toBe('pending');
    expect(b?.attempt).toBe(0);
    expect(b?.leaseOwner).toBeNull();
    expect(TestJobControl.executionsFor(TEST_JOB.BASIC, tenantB)).toHaveLength(
      0,
    );
  });

  it("writing another tenant's row is refused by the INSERT policy, not merely by application code", async () => {
    await expect(
      prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
        tx.scheduledJobOccurrence.create({
          data: {
            tenantId: tenantB,
            jobType: TEST_JOB.BASIC,
            occurrenceKey: FIXED_KEY,
            scheduledFor: new Date('2026-09-03T03:00:00Z'),
            maxAttempts: 3,
            nextAttemptAt: new Date('2026-09-03T03:00:00Z'),
          },
        }),
      ),
    ).rejects.toThrow();

    expect(
      await admin.scheduledJobOccurrence.count({
        where: { tenantId: tenantB },
      }),
    ).toBe(0);
  });

  it("updating another tenant's occurrence under tenant A's context affects nothing", async () => {
    await admin.scheduledJobOccurrence.create({
      data: {
        tenantId: tenantB,
        jobType: TEST_JOB.BASIC,
        occurrenceKey: FIXED_KEY,
        scheduledFor: new Date('2026-09-03T03:00:00Z'),
        maxAttempts: 3,
        nextAttemptAt: new Date('2026-09-03T03:00:00Z'),
      },
    });

    const updated = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
      tx.scheduledJobOccurrence.updateMany({
        where: { jobType: TEST_JOB.BASIC, occurrenceKey: FIXED_KEY },
        data: { state: 'succeeded' },
      }),
    );
    expect(updated.count).toBe(0);

    const b = await admin.scheduledJobOccurrence.findUnique({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId: tenantB,
          jobType: TEST_JOB.BASIC,
          occurrenceKey: FIXED_KEY,
        },
      },
    });
    expect(b?.state).toBe('pending');
  });

  it('a finding cannot exist without its occurrence — the composite FK is enforced', async () => {
    await expect(
      admin.scheduledJobFinding.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          jobType: TEST_JOB.BASIC,
          occurrenceKey: '2026-01-01T03:00',
          severity: 'critical',
          findingCode: 'orphan.finding',
          detail: {},
        },
      }),
    ).rejects.toThrow();
  });
});
