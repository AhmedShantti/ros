import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { IDENTITY_PERMISSIONS } from './../src/modules/identity/authz/permissions.constants';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { createMigratorClient } from './rls-admin';
import {
  BatchResultView,
  SyncFixture,
  bootstrapSyncApp,
  buildBatch,
  buildOperation,
  byOpId,
  createSyncFixture,
  destroySyncFixture,
} from './sync-fixtures';

/**
 * D4-1B — LOSSLESS REVOKED-TERMINAL RECOVERY (D1-1 GD-D1-07 hard gate).
 *
 * Both routes here are exercised as an ADMIN, never as the revoked terminal
 * itself — see `SyncRecoveryService`'s docblock for why a terminal-
 * authenticated recovery route is unreachable in the exact case it exists
 * for (a non-active terminal cannot mint a new PIN session, and even a
 * pre-revocation token cannot outlast a long offline window).
 */
describe('Sync lossless revoked-terminal recovery (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let fx: SyncFixture;

  const seed = `rec${Date.now()}`;
  const password = 's3cure-passphrase';

  let managerToken: string;
  let plainToken: string;

  const login = async (email: string, tenantId: string): Promise<string> => {
    const loginRes = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set(
        'Authorization',
        `Bearer ${(loginRes.body as { accessToken: string }).accessToken}`,
      )
      .send({ tenantId })
      .expect(200);
    return (sel.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    fx = await createSyncFixture(app, admin, seed);

    await app.get(PermissionsService).ensureIdentityPermissions();
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const managerEmail = `sync.recovery.manager.${seed}@example.com`;
    const managerUser = await users.createUser({
      email: managerEmail,
      password,
      displayName: 'Recovery Manager',
    });
    const managerMembership = await memberships.grant(
      managerUser.id,
      fx.tenantId,
      'active',
    );
    const managerRole = await roles.createTenantRole(fx.tenantId, {
      name: `recovery-manager-${seed}`,
    });
    await roles.addPermissions(fx.tenantId, managerRole.id, [
      IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
    ]);
    await membershipRoles.create(fx.tenantId, null, {
      membershipId: managerMembership.id,
      roleId: managerRole.id,
      scope: { type: 'tenant' },
    });
    managerToken = await login(managerEmail, fx.tenantId);

    const plainEmail = `sync.recovery.plain.${seed}@example.com`;
    const plainUser = await users.createUser({
      email: plainEmail,
      password,
      displayName: 'No Permission',
    });
    await memberships.grant(plainUser.id, fx.tenantId, 'active');
    plainToken = await login(plainEmail, fx.tenantId);
  }, 90_000);

  afterAll(async () => {
    await destroySyncFixture(admin, fx);
    await admin.$disconnect();
    await app.close();
  });

  const issueGrant = (bearer: string, body: Record<string, unknown>) =>
    request(http)
      .post('/v1/sync/recovery/grants')
      .set('Authorization', `Bearer ${bearer}`)
      .send(body);

  const uploadRecoveryBatch = (
    bearer: string,
    grantId: string,
    body: unknown,
  ) =>
    request(http)
      .post(`/v1/sync/recovery/${grantId}/batch`)
      .set('Authorization', `Bearer ${bearer}`)
      .send(body as object);

  it('refuses to grant recovery for an ACTIVE terminal — ordinary sync already accepts its backlog', async () => {
    await issueGrant(managerToken, {
      terminalId: fx.terminalId,
      reason: 'test: active terminal should be refused',
    }).expect(409);
  });

  it('403s grant issuance without identity.terminal.manage', async () => {
    await issueGrant(plainToken, {
      terminalId: fx.revokedTerminalId,
      reason: 'test: no permission',
    }).expect(403);
  });

  it('grants, uploads, and processes a revoked terminal’s backlog losslessly — without restoring its ordinary operating authority', async () => {
    const grantRes = await issueGrant(managerToken, {
      terminalId: fx.revokedTerminalId,
      reason: 'device recovered from courier; backlog must not be lost',
    }).expect(201);
    const grant = grantRes.body as {
      id: string;
      terminalId: string;
      branchId: string;
      status: string;
    };
    expect(grant.terminalId).toBe(fx.revokedTerminalId);
    expect(grant.branchId).toBe(fx.branchId);
    expect(grant.status).toBe('pending');

    // A SECOND grant for the same still-pending terminal is refused — bounded
    // to ONE open recovery window per terminal, not an open-ended surface.
    await issueGrant(managerToken, {
      terminalId: fx.revokedTerminalId,
      reason: 'second grant should be refused while one is pending',
    }).expect(409);

    const op1 = buildOperation(fx.node, {
      payload: { mode: 'audit', note: 'recovered-sale-1' },
      actorEmployeeId: fx.employeeId,
    });
    const op2 = buildOperation(fx.node, {
      logical: 1,
      payload: { mode: 'audit', note: 'recovered-sale-2' },
      actorEmployeeId: fx.employeeId,
    });
    const batch = buildBatch(fx.revokedTerminalId, [op1, op2]);

    const uploadRes = await uploadRecoveryBatch(
      managerToken,
      grant.id,
      batch,
    ).expect(200);
    const results = byOpId(uploadRes.body as BatchResultView);
    expect(results.get(op1.opId)?.status).toBe('accepted');
    expect(results.get(op2.opId)?.status).toBe('accepted');

    // LOSSLESS: both operations left a genuine, dedup-registered effect.
    const dedupRows = await prisma.withAuthContext(
      { tenantId: fx.tenantId },
      (tx) =>
        tx.syncOperationDedup.findMany({
          where: { tenantId: fx.tenantId, opId: { in: [op1.opId, op2.opId] } },
        }),
    );
    expect(dedupRows).toHaveLength(2);
    expect(dedupRows.every((r) => r.status === 'accepted')).toBe(true);

    // NOT RESTORED: the terminal is still `revoked` — recovery never flips it.
    const terminal = await admin.terminal.findUnique({
      where: { id: fx.revokedTerminalId },
    });
    expect(terminal?.status).toBe('revoked');

    // AUDITED: grant issuance, batch acceptance, batch completion.
    const auditActions = (
      await prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
        tx.auditEntry.findMany({
          where: { tenantId: fx.tenantId, entityId: grant.id },
          select: { action: true },
        }),
      )
    ).map((r) => r.action);
    expect(auditActions).toEqual(
      expect.arrayContaining([
        'TERMINAL_RECOVERY_GRANTED',
        'TERMINAL_RECOVERY_BATCH_ACCEPTED',
        'TERMINAL_RECOVERY_BATCH_PROCESSED',
      ]),
    );

    // A RETRY of the exact same batch is a resubmission, not a second use —
    // still accepted, no duplicate effect (D4-1A's own batch-replay contract).
    const retryRes = await uploadRecoveryBatch(
      managerToken,
      grant.id,
      batch,
    ).expect(200);
    expect((retryRes.body as BatchResultView).replayed).toBe(true);
    const dedupRowsAfterRetry = await prisma.withAuthContext(
      { tenantId: fx.tenantId },
      (tx) =>
        tx.syncOperationDedup.count({
          where: { tenantId: fx.tenantId, opId: { in: [op1.opId, op2.opId] } },
        }),
    );
    expect(dedupRowsAfterRetry).toBe(2);

    // A DIFFERENT batch under the SAME (now-consumed) grant is refused — the
    // grant is bounded to the ONE logical batch it was consumed for.
    const otherBatch = buildBatch(fx.revokedTerminalId, [
      buildOperation(fx.node, { logical: 9, payload: { mode: 'noop' } }),
    ]);
    await uploadRecoveryBatch(managerToken, grant.id, otherBatch).expect(409);

    // Ordinary sync remains refused throughout — recovery is a SEPARATE,
    // narrower channel, not a side-door back to normal operating authority.
    await request(http)
      .post('/v1/sync/batch')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(buildBatch(fx.revokedTerminalId, [buildOperation(fx.node)]))
      .expect((res) => expect(res.status).not.toBe(200));
  });

  it('409s an upload against an expired grant, and never applies its operations', async () => {
    // A NEW grant on the same revoked terminal is legal once the previous
    // test's grant already reached `consumed` — the "one pending grant"
    // bound only blocks a SECOND concurrently-PENDING grant.
    const grantRes = await issueGrant(managerToken, {
      terminalId: fx.revokedTerminalId,
      reason: 'expiry test',
    }).expect(201);
    const grant = grantRes.body as { id: string };

    // Force expiry deterministically rather than waiting out the minimum TTL.
    await admin.syncRecoveryGrant.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const op = buildOperation(fx.node, {
      logical: 20,
      payload: { mode: 'audit', note: 'should never apply' },
      actorEmployeeId: fx.employeeId,
    });
    await uploadRecoveryBatch(
      managerToken,
      grant.id,
      buildBatch(fx.revokedTerminalId, [op]),
    ).expect(409);

    const dedupRow = await prisma.withAuthContext(
      { tenantId: fx.tenantId },
      (tx) =>
        tx.syncOperationDedup.findFirst({
          where: { tenantId: fx.tenantId, opId: op.opId },
        }),
    );
    expect(dedupRow).toBeNull();
  });

  it('404s an upload against an unknown grantId, and 403s a manager without the permission at the grant’s branch', async () => {
    const grantRes = await issueGrant(managerToken, {
      terminalId: fx.revokedTerminalId,
      reason: 'permission re-check test',
    }).expect(201);
    const grant = grantRes.body as { id: string };

    await uploadRecoveryBatch(
      managerToken,
      '00000000-0000-4000-8000-000000000000',
      buildBatch(fx.revokedTerminalId, [buildOperation(fx.node)]),
    ).expect(404);

    // The SAME live-authorization primitive PermissionGuard uses is re-run at
    // upload time, not just at grant-issuance time.
    await uploadRecoveryBatch(
      plainToken,
      grant.id,
      buildBatch(fx.revokedTerminalId, [buildOperation(fx.node)]),
    ).expect(403);
  });
});
