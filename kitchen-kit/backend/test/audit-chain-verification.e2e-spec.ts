import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaClient } from './../src/generated/prisma/client';
import { AuditService } from './../src/modules/governance/audit/audit.service';
import { createMigratorClient } from './rls-admin';
import {
  bootSchedulerApp,
  clearScheduler,
  createSchedulerTenant,
  onlyJob,
  readFindings,
  readOccurrence,
  runnerOf,
} from './scheduler-fixtures';

const JOB_TYPE = 'governance.audit_chain_verification';
const FINDING_CODE = 'governance.audit_chain_broken';

/** This job's default schedule fires at 02:00 UTC; these instants are safely after it. */
const DAY_1 = new Date('2026-09-03T12:00:00.000Z');
const DAY_1_KEY = '2026-09-03T02:00';
const DAY_2 = new Date('2026-09-04T12:00:00.000Z');
const DAY_2_KEY = '2026-09-04T02:00';

/**
 * FR-AUD-005 (AUD-1) — the scheduled audit hash-chain verification job, end to
 * end against real PostgreSQL. Reuses the SCHED-1 fixtures (`bootSchedulerApp`,
 * `onlyJob`, etc.) exactly as `scheduler-core.e2e-spec.ts` and
 * `inventory-scheduled-reconciliation.e2e-spec.ts` already do — the substrate
 * itself (exactly-once claim, lease, retry) is proven generically there; this
 * suite proves this JOB's own detection behaviour and its tenant scoping.
 */
describe('Audit chain verification scheduled job (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let audit: AuditService;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    app = await bootSchedulerApp();
    admin = createMigratorClient(app);
    audit = app.get(AuditService);
    tenantA = await createSchedulerTenant(admin, 'audchainA');
    tenantB = await createSchedulerTenant(admin, 'audchainB');
    await onlyJob(admin, tenantA, JOB_TYPE);
    await onlyJob(admin, tenantB, JOB_TYPE);
  }, 90_000);

  afterAll(async () => {
    await clearScheduler(admin, [tenantA, tenantB]);
    await admin.auditEntry.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await admin.$disconnect();
    await app.close();
  });

  /** Write N real, correctly hash-chained entries for a tenant via the canonical writer. */
  async function seedChain(tenantId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await audit.emit({
        tenantId,
        action: 'ROLE_ASSIGNED',
        entityType: 'role_assignment',
        actorType: 'system',
        metadata: { i },
      });
    }
  }

  it('a valid chain: the occurrence succeeds and records no finding', async () => {
    await seedChain(tenantA, 5);

    const result = await runnerOf(app).runTick({
      now: DAY_1,
      tenantIds: [tenantA],
    });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const occurrence = await readOccurrence(
      admin,
      tenantA,
      JOB_TYPE,
      DAY_1_KEY,
    );
    expect(occurrence?.state).toBe('succeeded');
    expect(occurrence?.outcomeCode).toBe('ok');

    const findings = await readFindings(admin, tenantA, JOB_TYPE);
    expect(findings).toEqual([]);
  });

  it('a sabotaged historical link is detected deterministically: exactly one critical finding', async () => {
    // Deterministic sabotage: tamper ONE historical entry's content directly
    // (as the migrator role — ros_app itself cannot UPDATE this table at all,
    // FR-AUD-003). This is content tampering: entry_hash no longer matches a
    // recomputation of the row's own (now-altered) fields.
    const rows = await admin.auditEntry.findMany({
      where: { tenantId: tenantA },
      orderBy: { sequenceNo: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    const victim = rows[0];
    await admin.auditEntry.update({
      where: { id: victim.id },
      data: { afterState: { i: 'TAMPERED' } },
    });

    const result = await runnerOf(app).runTick({
      now: DAY_2,
      tenantIds: [tenantA],
    });
    expect(result.succeeded).toBe(1); // the OCCURRENCE succeeded — detection ran to completion
    expect(result.failed).toBe(0);

    const occurrence = await readOccurrence(
      admin,
      tenantA,
      JOB_TYPE,
      DAY_2_KEY,
    );
    expect(occurrence?.state).toBe('succeeded');

    const findings = await readFindings(admin, tenantA, JOB_TYPE);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].findingCode).toBe(FINDING_CODE);
    const detail = findings[0].detail as {
      tenantId: string;
      brokenAtSequenceNo: string;
      reason: string;
    };
    expect(detail.tenantId).toBe(tenantA);
    expect(detail.brokenAtSequenceNo).toBe(victim.sequenceNo.toString());
    expect(detail.reason).toContain('content tampered');

    // Nothing was mutated by VERIFICATION itself: the chain still has exactly
    // the rows written by seedChain, and the sabotaged row's hash is untouched
    // (only its afterState was — deliberately, by the test's own arrange step,
    // not by the job).
    const afterVerification = await admin.auditEntry.findMany({
      where: { tenantId: tenantA },
    });
    expect(afterVerification).toHaveLength(rows.length);
  });

  it('a duplicate tick over the same occurrence does not duplicate the finding', async () => {
    const before = await readFindings(admin, tenantA, JOB_TYPE);
    expect(before).toHaveLength(1);

    // Same `now` as the previous test -> same occurrence key -> already
    // `succeeded`, so materialize is ON CONFLICT DO NOTHING and claim finds
    // nothing eligible: this tick does NOT re-run the handler at all.
    const result = await runnerOf(app).runTick({
      now: DAY_2,
      tenantIds: [tenantA],
    });
    expect(result.claimed).toBe(0);
    expect(result.succeeded).toBe(0);

    const after = await readFindings(admin, tenantA, JOB_TYPE);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
  });

  it("tenant scope: tenant B's own valid chain is unaffected by tenant A's broken one", async () => {
    await seedChain(tenantB, 3);

    const result = await runnerOf(app).runTick({
      now: DAY_1,
      tenantIds: [tenantB],
    });
    expect(result.succeeded).toBe(1);

    const findingsB = await readFindings(admin, tenantB, JOB_TYPE);
    expect(findingsB).toEqual([]);

    // Tenant A's finding is still exactly the one from before — unaffected by
    // tenant B's independent occurrence.
    const findingsA = await readFindings(admin, tenantA, JOB_TYPE);
    expect(findingsA).toHaveLength(1);
  });
});
