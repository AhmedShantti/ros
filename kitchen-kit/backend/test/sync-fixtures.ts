import { INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyApiVersioning } from '../src/common/http/api-versioning';
import { newId } from '../src/common/ids';
import {
  PrismaClient,
  TerminalStatus,
  TerminalType,
} from '../src/generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../src/modules/governance/contract';
import { EmployeesService } from '../src/modules/identity/employees/employees.service';
import { PinService } from '../src/modules/identity/employees/pin.service';
import { MembershipsService } from '../src/modules/identity/memberships/memberships.service';
import { TenantsService } from '../src/modules/identity/tenants/tenants.service';
import { UsersService } from '../src/modules/identity/users/users.service';
import type {
  SyncOperationContext,
  SyncOperationHandler,
  SyncOperationOutcome,
} from '../src/modules/sync/contract';
import { SyncOperationHandlerFor } from '../src/modules/sync/operations/sync-operation-handler.decorator';
import { applySyncBodyLimit } from '../src/modules/sync/sync.bootstrap';

import { hlcNodeFromTerminalId } from '../src/modules/sync/hlc/hlc';

export const DEV_PASSWORD = 's3cure-passphrase';

/**
 * ── THE TEST OPERATION, AND WHY IT IS THIS ONE ────────────────────────────
 * The kernel needs a registered handler to be exercised at all, and the brief
 * forbids exposing a fake production financial operation just to have something
 * to benchmark. This is option (B): an existing, fully-ratified, inexpensive
 * domain operation — appending a `governance.audit_entries` row.
 *
 * That choice does real work for three separate proofs:
 *   1. ATOMICITY — the audit row is a genuine business effect written through
 *      the kernel's own `tx`, so a rolled-back operation must leave neither the
 *      audit row nor the dedup row behind;
 *   2. P-D4-02 — the per-tenant audit hash chain is exactly the serialization
 *      point the audit-contention gate has to measure, and a probe that did not
 *      touch it would measure nothing;
 *   3. REPRESENTATIVE COST — a hash-chained append behind a per-tenant advisory
 *      lock is a realistic per-operation write, not a toy.
 *
 * It is registered ONLY by test modules. `SyncModule` provides no handler, so a
 * production deployment of D4-1A answers every type `unknown_operation_type`.
 */
@SyncOperationHandlerFor('protocol.probe')
@Injectable()
export class SyncProtocolProbeHandler implements SyncOperationHandler {
  readonly operationType = 'protocol.probe';
  readonly supportedSchemaVersions = [1];

  constructor(private readonly audit: AuditService) {}

  async apply(
    context: SyncOperationContext,
  ): Promise<SyncOperationOutcome | void> {
    const payload = (context.payload ?? {}) as { mode?: string; note?: string };

    if (payload.mode === 'throw') {
      // Proves per-operation failure isolation: this rolls back to its own
      // savepoint and leaves its siblings in the same chunk untouched.
      throw new Error('probe: deliberate failure');
    }
    if (payload.mode === 'noop') {
      // Kernel-floor benchmark: the kernel's own writes and nothing else.
      return { detail: { echoedEntityId: context.entityId } };
    }
    if (payload.mode === 'conflict') {
      // D4-1B — proves the `conflict` != `rejected` causal-parent distinction
      // (`operation-scheduler.ts`'s "WHY A CONFLICTED PARENT DEFERS, NOT
      // REJECTS"): a `conflict` settlement is definitive for THIS operation
      // but must NOT propagate as `causal_parent_rejected` to a child.
      return {
        status: 'conflict',
        reasonCode: 'illegal_transition',
        reasonDetail: 'probe: deliberate conflict',
      };
    }

    await this.audit.record(context.tx, {
      tenantId: context.tenantId,
      action: AUDIT_ACTION.SYNC_CLOCK_SKEW_DETECTED,
      entityType: AUDIT_ENTITY.SYNC_DEVICE_STATE,
      entityId: context.entityId,
      actorType: 'terminal',
      terminalId: context.terminalId,
      reasonCode: 'protocol_probe',
      metadata: { opId: context.opId, note: payload.note ?? null },
    });
    return { detail: { echoedEntityId: context.entityId, audited: true } };
  }
}

/**
 * Build a Nest application configured EXACTLY as `main.ts` configures the real
 * one: same versioning, same global pipe, same path-scoped sync body limit.
 * Anything less and the suite would be exercising a different application from
 * the one that ships — which is the whole failure mode `openapi:check` exists
 * to catch elsewhere.
 */
export async function bootstrapSyncApp(): Promise<INestApplication> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
    providers: [SyncProtocolProbeHandler],
  }).compile();
  const app = moduleFixture.createNestApplication();
  applyApiVersioning(app);
  applySyncBodyLimit(app);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  return app;
}

export interface SyncFixture {
  readonly tenantId: string;
  readonly branchId: string;
  /** Active `pos` terminal — the one that syncs. */
  readonly terminalId: string;
  /** A second active terminal in the same branch, for concurrency probes. */
  readonly terminal2Id: string;
  readonly terminal3Id: string;
  /** Registered but `revoked`. */
  readonly revokedTerminalId: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeUserId: string;
  readonly pin: string;
  readonly node: string;
}

export async function createSyncFixture(
  app: INestApplication,
  admin: PrismaClient,
  seed: string,
): Promise<SyncFixture> {
  const tenants = app.get(TenantsService);
  const users = app.get(UsersService);
  const memberships = app.get(MembershipsService);
  const employees = app.get(EmployeesService);
  const pins = app.get(PinService);

  const tenant = await tenants.create({
    slug: `sync-${seed}`,
    legalName: `Sync ${seed}`,
    defaultCurrency: 'EGP',
    countryPackCode: 'EG',
  });
  const tenantId = tenant.id;

  const brand = await admin.brand.create({
    data: { id: newId(), tenantId, name: `Sync Brand ${seed}` },
  });
  const branch = await admin.branch.create({
    data: {
      id: newId(),
      tenantId,
      brandId: brand.id,
      code: `S${seed.slice(-6)}`,
      name: `Sync Branch ${seed}`,
      timezone: 'Africa/Cairo',
      baseCurrency: 'EGP',
      countryCode: 'EG',
    },
  });
  const branchId = branch.id;
  // Every org location entity must have an `org.locations` registry row —
  // `organisation.e2e-spec.ts` asserts that invariant across the WHOLE
  // database, so a fixture that creates a branch without one breaks an
  // unrelated suite rather than its own.
  await admin.location.create({
    data: {
      id: newId(),
      tenantId,
      locationType: 'branch',
      refId: branchId,
      branchId,
    },
  });

  const mkTerminal = (
    terminalType: TerminalType,
    name: string,
    status: TerminalStatus = 'active',
  ) =>
    admin.terminal
      .create({
        data: { id: newId(), tenantId, branchId, name, terminalType, status },
      })
      .then((t) => t.id);

  const terminalId = await mkTerminal('pos', `POS-1-${seed}`);
  const terminal2Id = await mkTerminal('pos', `POS-2-${seed}`);
  const terminal3Id = await mkTerminal('pos', `POS-3-${seed}`);
  const revokedTerminalId = await mkTerminal(
    'pos',
    `POS-REVOKED-${seed}`,
    'revoked',
  );

  const employeeUser = await users.createUser({
    email: `sync.cashier.${seed}@example.com`,
    password: DEV_PASSWORD,
    displayName: 'Cashier',
  });
  await memberships.grant(employeeUser.id, tenantId, 'active');
  const employeeCode = `SY${seed.slice(-6)}`;
  const employee = await employees.create(tenantId, employeeUser.id, {
    code: employeeCode,
    displayName: 'Cashier',
    homeBranchId: branchId,
    userId: employeeUser.id,
  });
  const pin = '4321';
  await pins.setPin(tenantId, employeeUser.id, employee.id, pin);

  return {
    tenantId,
    branchId,
    terminalId,
    terminal2Id,
    terminal3Id,
    revokedTerminalId,
    employeeId: employee.id,
    employeeCode,
    employeeUserId: employeeUser.id,
    pin,
    node: hlcNodeFromTerminalId(terminalId),
  };
}

/**
 * FK-safe teardown.
 *
 * `admin.tenant.deleteMany()` alone is NOT enough and fails silently when
 * wrapped in `.catch()`: `identity.terminals` references `org.branches` with
 * `onDelete: Restrict`, so a tenant delete can be refused by that edge and
 * leave branches behind. Orphaned branches then break
 * `organisation.e2e-spec.ts`'s database-wide "every org location entity has a
 * registry row" invariant — a suite that has nothing to do with sync. Deleting
 * children first, and only then the tenant, keeps the shared test database
 * clean for everyone.
 */
export async function destroySyncFixture(
  admin: PrismaClient,
  fixture: Pick<SyncFixture, 'tenantId'>,
): Promise<void> {
  const { tenantId } = fixture;
  await admin.syncOperation.deleteMany({ where: { tenantId } });
  await admin.syncOperationDedup.deleteMany({ where: { tenantId } });
  await admin.syncBatch.deleteMany({ where: { tenantId } });
  await admin.syncDeviceState.deleteMany({ where: { tenantId } });
  await admin.syncConflictRecord.deleteMany({ where: { tenantId } });
  await admin.syncRevalidationException.deleteMany({ where: { tenantId } });
  await admin.auditEntry.deleteMany({ where: { tenantId } });
  await admin.deviceFingerprint.deleteMany({
    where: { terminal: { tenantId } },
  });
  await admin.session.deleteMany({ where: { terminal: { tenantId } } });
  await admin.terminal.deleteMany({ where: { tenantId } });
  await admin.location.deleteMany({ where: { tenantId } });
  await admin.employeeBranch.deleteMany({ where: { tenantId } });
  await admin.employee.deleteMany({ where: { tenantId } });
  await admin.branch.deleteMany({ where: { tenantId } });
  await admin.brand.deleteMany({ where: { tenantId } });
  await admin.tenant.deleteMany({ where: { id: tenantId } });
}

/** PIN login binds the session to a terminal and mints a `pos`-audience token. */
export async function terminalToken(
  http: App,
  fixture: { tenantId: string; employeeCode: string; pin: string },
  terminalId: string,
): Promise<string> {
  const res = await request(http)
    .post('/auth/pin')
    .send({
      tenantId: fixture.tenantId,
      terminalId,
      employeeCode: fixture.employeeCode,
      pin: fixture.pin,
    })
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

// ────────────────────────────────────────────────────────── envelope builders

export const SYNC_BATCH_PATH = '/v1/sync/batch';

export function hlcOf(
  physicalMs: number,
  logical: number,
  node: string,
): string {
  return `${String(physicalMs).padStart(13, '0')}.${String(logical).padStart(5, '0')}.${node}`;
}

export interface BuildOpOptions {
  readonly opId?: string;
  readonly entityId?: string;
  readonly causedBy?: string | null;
  readonly type?: string;
  readonly schemaVersion?: number;
  readonly physicalMs?: number;
  readonly logical?: number;
  readonly node?: string;
  readonly payload?: Record<string, unknown>;
  readonly actorEmployeeId?: string | null;
  readonly occurredAt?: string;
}

export function buildOperation(node: string, options: BuildOpOptions = {}) {
  const physicalMs = options.physicalMs ?? 1_722_765_753_000;
  return {
    opId: options.opId ?? newId(),
    hlc: hlcOf(physicalMs, options.logical ?? 0, options.node ?? node),
    type: options.type ?? 'protocol.probe',
    entityId: options.entityId ?? newId(),
    causedBy: options.causedBy ?? null,
    actorEmployeeId: options.actorEmployeeId ?? null,
    occurredAt: options.occurredAt ?? new Date(physicalMs).toISOString(),
    schemaVersion: options.schemaVersion ?? 1,
    payload: options.payload ?? { mode: 'noop' },
  };
}

export function buildBatch(
  deviceId: string,
  operations: ReturnType<typeof buildOperation>[],
  batchId = newId(),
) {
  return {
    protocolVersion: 1,
    deviceId,
    batchId,
    lastServerCursor: null,
    operations,
  };
}

export interface OperationResultView {
  opId: string;
  status: string;
  definitive: boolean;
  reasonCode?: string;
  reasonDetail?: string;
  detail?: Record<string, unknown>;
  conflictId?: string;
}

export interface BatchResultView {
  batchId: string;
  replayed: boolean;
  counts: Record<string, number>;
  clockSkewMs: number;
  clockSkewExceededThreshold: boolean;
  results: OperationResultView[];
}

export function byOpId(
  body: BatchResultView,
): Map<string, OperationResultView> {
  return new Map(body.results.map((r) => [r.opId, r]));
}
