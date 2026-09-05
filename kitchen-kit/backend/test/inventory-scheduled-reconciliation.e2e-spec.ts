import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { ReconciliationService } from './../src/modules/inventory/reconciliation/reconciliation.service';
import {
  INVENTORY_DAILY_RECONCILIATION_JOB,
  INVENTORY_DIVERGENCE_FINDING_CODE,
} from './../src/modules/inventory/reconciliation/daily-reconciliation.job';
import { createMigratorClient } from './rls-admin';
import {
  FIXED_KEY,
  FIXED_NOW,
  TestJobControl,
  bootSchedulerApp,
  clearScheduler,
  createSchedulerTenant,
  onlyJob,
  readFindings,
  readOccurrence,
  readOccurrences,
  runnerOf,
} from './scheduler-fixtures';

/**
 * SCHED-1 — the proving integration: BR-INV-003 / FR-INV-011 / FR-INV-051
 * daily ledger-vs-projection reconciliation, running as a real scheduled job on
 * the durable substrate, against real PostgreSQL.
 *
 *   BR-INV-003  "The sum of all movements for an (item, location) pair SHALL
 *                equal the stock_levels projection for that pair. A
 *                reconciliation job SHALL verify this daily and raise an alert
 *                on any divergence."
 *
 * ── WHAT THIS SUITE IS CAREFUL NOT TO CLAIM ───────────────────────────────
 * It proves SCHEDULING and DETECTION and DURABLE RECORDING. It does not prove
 * alert DELIVERY, because no delivery substrate exists in this repository
 * (governance decision N-A ratified that none is introduced in this phase). The
 * report accompanying this slice keeps BR-INV-003 at PARTIAL for exactly that
 * reason, and nothing here is worded as if the requirement were closed.
 *
 * ── THE DIVERGENCE IS CREATED THROUGH THE OWNER CLIENT, DELIBERATELY ───────
 * There is no supported application path that makes the ledger and the
 * projection disagree — A1-4's concurrency matrix exists precisely to prove
 * there is not. So the incident this job detects is arranged the only way it
 * can occur in production: by something writing `inventory.stock_levels`
 * without a matching movement. Writing it as the owner is the honest simulation
 * of that class of defect.
 */
describe('Inventory scheduled daily reconciliation (e2e)', () => {
  let alpha: INestApplication<App>;
  let bravo: INestApplication<App>;
  let admin: PrismaClient;
  let tenantId: string;
  let locationId: string;
  let itemId: string;
  let uomId: string;
  let actorId: string;

  const JOB = INVENTORY_DAILY_RECONCILIATION_JOB;

  beforeAll(async () => {
    alpha = await bootSchedulerApp();
    bravo = await bootSchedulerApp();
    admin = createMigratorClient(alpha);
    tenantId = await createSchedulerTenant(admin, 'invrecon');

    const ts = Date.now();
    uomId = newId();
    await admin.uom.create({
      data: { id: uomId, dimension: 'mass', code: `kg-${ts}`, name: 'kg' },
    });
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: 'Recon brand' },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `RC${ts % 10000}`,
        name: 'Recon branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    locationId = newId();
    await admin.location.create({
      data: {
        id: locationId,
        tenantId,
        locationType: 'branch',
        refId: branch.id,
        branchId: branch.id,
      },
    });
    itemId = newId();
    await admin.stockItem.create({
      data: {
        id: itemId,
        tenantId,
        sku: `SKU-${ts}`,
        names: { en: 'Flour' },
        baseUnitId: uomId,
      },
    });
    actorId = (
      await admin.user.create({
        data: {
          id: newId(),
          email: `recon.${ts}@example.com`,
          displayName: 'r',
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await admin.$disconnect();
    await alpha.close();
    await bravo.close();
  });

  beforeEach(async () => {
    TestJobControl.reset();
    await clearScheduler(admin, [tenantId]);
    await admin.stockLevel.deleteMany({ where: { tenantId } });
    await admin.stockMovement.deleteMany({ where: { tenantId } });
    await onlyJob(admin, tenantId, JOB);
  });

  /**
   * A consistent pair: one +10 movement and a projection that agrees.
   * `opening_balance` is used because it is the one movement type that requires
   * neither a batch (`ck_batch_required`) nor a reason code
   * (`ck_reason_required`) — the fixture is about the LEDGER FOLD, not about
   * exercising a particular movement type's own rules.
   */
  async function seedConsistent(): Promise<void> {
    await admin.stockMovement.create({
      data: {
        id: newId(),
        occurredAt: new Date('2026-09-02T08:00:00Z'),
        tenantId,
        locationId,
        stockItemId: itemId,
        movementType: 'opening_balance',
        quantity: '10',
        unitId: uomId,
        unitCost: 100n,
        totalCost: 1000n,
        balanceAfter: '10',
        referenceType: 'test',
        referenceId: newId(),
        performedBy: actorId,
      },
    });
    await admin.stockLevel.create({
      data: { tenantId, stockItemId: itemId, locationId, quantityOnHand: '10' },
    });
  }

  /** Break the projection without a matching movement — the incident. */
  const divergeProjection = (quantity: string) =>
    admin.stockLevel.update({
      where: { stockItemId_locationId: { stockItemId: itemId, locationId } },
      data: { quantityOnHand: quantity },
    });

  const tick = (app: INestApplication<App> = alpha, now: Date = FIXED_NOW) =>
    runnerOf(app).runTick({ now, tenantIds: [tenantId], claimBatch: 50 });

  // ── The job runs on the SRS-required daily cadence ────────────────────────

  it('A. runs as a DAILY scheduled occurrence, one per local day, with a durable identity', async () => {
    await seedConsistent();

    await tick(alpha, new Date('2026-09-03T12:00:00Z'));
    await tick(alpha, new Date('2026-09-04T12:00:00Z'));

    const rows = await readOccurrences(admin, tenantId, JOB);
    expect(rows.map((r) => r.occurrenceKey)).toEqual([
      '2026-09-03T03:00',
      '2026-09-04T03:00',
    ]);
    expect(rows.every((r) => r.state === 'succeeded')).toBe(true);
    expect(rows.every((r) => r.outcomeCode === 'ok')).toBe(true);
    // Daily means daily: exactly one occurrence per local calendar day.
    expect(new Set(rows.map((r) => r.occurrenceKey.slice(0, 10))).size).toBe(2);
    // Every occurrence carries the 03:00 UTC slot the default schedule names.
    expect(rows.map((r) => r.scheduledFor.toISOString())).toEqual([
      '2026-09-03T03:00:00.000Z',
      '2026-09-04T03:00:00.000Z',
    ]);
  });

  it('A2. a week of downtime does NOT fabricate occurrences for days it could not verify', async () => {
    await seedConsistent();
    // Returning after a week produces ONE occurrence — the day it can actually
    // verify. Re-running Monday's key today would claim Monday was checked.
    await tick(alpha, new Date('2026-09-10T12:00:00Z'));
    const rows = await readOccurrences(admin, tenantId, JOB);
    expect(rows.map((r) => r.occurrenceKey)).toEqual(['2026-09-10T03:00']);
  });

  it('B. a healthy tenant produces a SUCCEEDED occurrence and NO finding', async () => {
    await seedConsistent();

    const result = await tick();
    expect(result.succeeded).toBe(1);

    const row = await readOccurrence(admin, tenantId, JOB, FIXED_KEY);
    expect(row?.state).toBe('succeeded');
    expect(await readFindings(admin, tenantId, JOB)).toHaveLength(0);
  });

  // ── Detection, through the CANONICAL reconciliation logic ─────────────────

  it('C. DETECTS a ledger-vs-projection divergence and records a critical finding', async () => {
    await seedConsistent();
    await divergeProjection('7');

    await tick();

    const row = await readOccurrence(admin, tenantId, JOB, FIXED_KEY);
    expect(row?.state).toBe('succeeded'); // detection succeeded; the DATA is wrong
    expect(row?.outcomeCode).toBe('ok');

    const findings = await readFindings(admin, tenantId, JOB);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingCode).toBe(INVENTORY_DIVERGENCE_FINDING_CODE);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].occurrenceKey).toBe(FIXED_KEY);
    expect(findings[0].acknowledgedAt).toBeNull();

    const detail = findings[0].detail as {
      divergenceCount: number;
      sampled: number;
      sample: {
        stockItemId: string;
        locationId: string;
        projected: string;
        ledger: string;
      }[];
    };
    expect(detail.divergenceCount).toBe(1);
    expect(detail.sample).toHaveLength(1);
    expect(detail.sample[0].stockItemId).toBe(itemId);
    expect(detail.sample[0].locationId).toBe(locationId);
    // The projection says 7; the ledger folds to 10.
    expect(Number(detail.sample[0].projected)).toBe(7);
    expect(Number(detail.sample[0].ledger)).toBe(10);
  });

  it('D. uses the CANONICAL ReconciliationService — the finding matches the on-demand answer exactly', async () => {
    await seedConsistent();
    await divergeProjection('3.5');

    const onDemand = await alpha.get(ReconciliationService).reconcile(tenantId);
    await tick();

    const findings = await readFindings(admin, tenantId, JOB);
    const detail = findings[0].detail as {
      divergenceCount: number;
      sample: { stockItemId: string; locationId: string; projected: string }[];
    };
    expect(onDemand.reconciled).toBe(false);
    expect(detail.divergenceCount).toBe(onDemand.divergences.length);
    expect(
      detail.sample.map((s) => `${s.stockItemId}:${s.locationId}`),
    ).toEqual(
      onDemand.divergences.map((d) => `${d.stockItemId}:${d.locationId}`),
    );
    expect(Number(detail.sample[0].projected)).toBe(
      Number(onDemand.divergences[0].projected),
    );
  });

  it('E. does NOT "fix" the divergence — the projection and the ledger are left exactly as found', async () => {
    await seedConsistent();
    await divergeProjection('7');

    const levelBefore = await admin.stockLevel.findUnique({
      where: { stockItemId_locationId: { stockItemId: itemId, locationId } },
    });
    const movementsBefore = await admin.stockMovement.count({
      where: { tenantId },
    });

    await tick();

    const levelAfter = await admin.stockLevel.findUnique({
      where: { stockItemId_locationId: { stockItemId: itemId, locationId } },
    });
    expect(levelAfter?.quantityOnHand.toString()).toBe(
      levelBefore?.quantityOnHand.toString(),
    );
    expect(levelAfter?.lastReconciledAt?.toISOString() ?? null).toBe(
      levelBefore?.lastReconciledAt?.toISOString() ?? null,
    );
    // No compensating movement was invented to make the numbers agree.
    expect(await admin.stockMovement.count({ where: { tenantId } })).toBe(
      movementsBefore,
    );
    // The divergence is still detectable afterwards, which is the point.
    const again = await alpha.get(ReconciliationService).reconcile(tenantId);
    expect(again.reconciled).toBe(false);
  });

  it('F. covers EVERY (item, location) pair in the tenant, including a second location', async () => {
    await seedConsistent();
    // A second location that is NOT a branch location — a tenant-owned central
    // kitchen. A per-branch job would miss this entirely; FR-INV-051 says
    // "every (item, location) pair".
    const warehouse = await admin.warehouse.create({
      data: {
        id: newId(),
        tenantId,
        name: `CK warehouse ${Date.now()}`,
        warehouseType: 'central',
      },
    });
    const ck = await admin.centralKitchen.create({
      data: {
        id: newId(),
        tenantId,
        warehouseId: warehouse.id,
        name: `CK ${Date.now()}`,
      },
    });
    const ckLocation = newId();
    await admin.location.create({
      data: {
        id: ckLocation,
        tenantId,
        locationType: 'central_kitchen',
        refId: ck.id,
        centralKitchenId: ck.id,
      },
    });
    await admin.stockLevel.create({
      data: {
        tenantId,
        stockItemId: itemId,
        locationId: ckLocation,
        quantityOnHand: '5',
      },
    });
    // No movements at all for that pair, so the ledger folds to 0 vs 5.

    await tick();

    const findings = await readFindings(admin, tenantId, JOB);
    expect(findings).toHaveLength(1);
    const detail = findings[0].detail as {
      divergenceCount: number;
      sample: { locationId: string }[];
    };
    expect(detail.divergenceCount).toBe(1);
    expect(detail.sample[0].locationId).toBe(ckLocation);

    await admin.stockLevel.deleteMany({
      where: { tenantId, locationId: ckLocation },
    });
    await admin.location.delete({ where: { id: ckLocation } });
    await admin.centralKitchen.delete({ where: { id: ck.id } });
    await admin.warehouse.delete({ where: { id: warehouse.id } });
  });

  // ── Retry / idempotency of the domain effect ──────────────────────────────

  it('G. a RE-RUN of the same occurrence leaves exactly ONE finding row', async () => {
    await seedConsistent();
    await divergeProjection('7');

    await tick();
    const first = await readFindings(admin, tenantId, JOB);
    expect(first).toHaveLength(1);

    // Reset the occurrence to pending, as a lease reclaim would.
    await admin.scheduledJobOccurrence.update({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId,
          jobType: JOB,
          occurrenceKey: FIXED_KEY,
        },
      },
      data: {
        state: 'pending',
        outcomeCode: null,
        completedAt: null,
        nextAttemptAt: new Date(FIXED_NOW.getTime() - 1000),
      },
    });

    await tick();

    const second = await readFindings(admin, tenantId, JOB);
    expect(second).toHaveLength(1);
    // Same row, upserted — not a second row, and not a new id.
    expect(second[0].id).toBe(first[0].id);
    const row = await readOccurrence(admin, tenantId, JOB, FIXED_KEY);
    expect(row?.attempt).toBe(2);
    expect(row?.state).toBe('succeeded');
  });

  it('H. an operator ACKNOWLEDGEMENT survives a re-detection of the same occurrence', async () => {
    await seedConsistent();
    await divergeProjection('7');
    await tick();

    const membershipId = newId();
    await admin.scheduledJobFinding.updateMany({
      where: { tenantId, jobType: JOB },
      data: { acknowledgedAt: new Date(), acknowledgedBy: membershipId },
    });

    await admin.scheduledJobOccurrence.update({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId,
          jobType: JOB,
          occurrenceKey: FIXED_KEY,
        },
      },
      data: {
        state: 'pending',
        outcomeCode: null,
        completedAt: null,
        nextAttemptAt: new Date(FIXED_NOW.getTime() - 1000),
      },
    });
    await tick();

    const findings = await readFindings(admin, tenantId, JOB);
    expect(findings).toHaveLength(1);
    // Re-running attempt 2 must not silently un-acknowledge what a human signed off.
    expect(findings[0].acknowledgedAt).not.toBeNull();
    expect(findings[0].acknowledgedBy).toBe(membershipId);
  });

  // ── Multi-instance ────────────────────────────────────────────────────────

  it('I. two instances reconciling concurrently produce ONE logical reconciliation occurrence', async () => {
    await seedConsistent();
    await divergeProjection('7');

    const [a, b] = await Promise.all([tick(alpha), tick(bravo)]);

    expect(a.claimed + b.claimed).toBe(1);
    expect(a.succeeded + b.succeeded).toBe(1);

    const rows = await readOccurrences(admin, tenantId, JOB);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('succeeded');
    expect(rows[0].attempt).toBe(1);
    expect(rows[0].leaseOwner).toBeNull();

    // One finding, not two — the alert evidence is not duplicated by the race.
    const findings = await readFindings(admin, tenantId, JOB);
    expect(findings).toHaveLength(1);
    const detail = findings[0].detail as { divergenceCount: number };
    expect(detail.divergenceCount).toBe(1);
  });

  it('J. the scheduled job runs under the correct tenant authorization context', async () => {
    // A second tenant with its OWN divergence. Each occurrence must see only
    // its own tenant's pairs — the reconciliation query has no tenant predicate
    // of its own; RLS is what scopes it.
    const otherTenant = await createSchedulerTenant(admin, 'invrecon-other');
    await onlyJob(admin, otherTenant, JOB);
    await seedConsistent();
    await divergeProjection('7');

    await runnerOf(alpha).runTick({
      now: FIXED_NOW,
      tenantIds: [tenantId, otherTenant],
      claimBatch: 50,
    });

    const mine = await readFindings(admin, tenantId, JOB);
    expect(mine).toHaveLength(1);
    expect(
      (mine[0].detail as { divergenceCount: number }).divergenceCount,
    ).toBe(1);

    // The other tenant has no stock at all, so it must report a clean run —
    // NOT this tenant's divergence.
    const theirs = await readFindings(admin, otherTenant, JOB);
    expect(theirs).toHaveLength(0);
    const theirOccurrence = await readOccurrence(
      admin,
      otherTenant,
      JOB,
      FIXED_KEY,
    );
    expect(theirOccurrence?.state).toBe('succeeded');

    await clearScheduler(admin, [otherTenant]);
  });
});
