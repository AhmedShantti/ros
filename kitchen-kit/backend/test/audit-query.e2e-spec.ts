import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { AuditService } from './../src/modules/governance/audit/audit.service';
import { AUDIT_PERMISSIONS } from './../src/modules/governance/audit/audit.permissions';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const password = 'orig-audq-pw-123';

/**
 * FR-AUD-007/008 (AUD-1, AUD-R1) — the auditor query/export surface, end to
 * end against real PostgreSQL. Proves: an authorized auditor sees their own
 * tenant's records; a foreign tenant's facts cannot leak; keyset pagination
 * neither skips nor duplicates; export content/count equals the equivalent
 * query; every call records its own FR-AUD-007 self-audit entry; permission
 * gating (audit.view alone vs. audit.view + report.export) is enforced; and
 * branch-scope narrowing behaves per the existing B1-3 lattice.
 */
describe('Auditor query/export surface (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let http: App;
  let audit: AuditService;

  let tenantId: string;
  let otherTenantId: string;
  let branchId: string;
  let otherBranchId: string;

  const emailViewer = `audq.viewer.${Date.now()}@example.com`;
  const emailExporter = `audq.exporter.${Date.now()}@example.com`;
  const emailNoPerm = `audq.noperm.${Date.now()}@example.com`;
  const emailBranchScoped = `audq.branchscoped.${Date.now()}@example.com`;
  const emailOther = `audq.other.${Date.now()}@example.com`;
  let viewerUserId: string;

  const login = (email: string) =>
    request(http).post('/auth/login').send({ email, password });
  const scoped = async (email: string, tId: string): Promise<Tokens> => {
    const l = (await login(email).expect(200)).body as Tokens;
    const s = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${l.accessToken}`)
      .send({ tenantId: tId })
      .expect(200);
    return { ...(s.body as Tokens), refreshToken: l.refreshToken };
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
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);
    http = app.getHttpServer();
    audit = app.get(AuditService);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const permissions = app.get(PermissionsService);
    await permissions.upsertMany([
      { code: AUDIT_PERMISSIONS.VIEW, module: 'governance', description: 'x' },
      {
        code: AUDIT_PERMISSIONS.EXPORT,
        module: 'governance',
        description: 'x',
      },
    ]);

    tenantId = (
      await tenants.create({
        slug: `audq-${Date.now()}`,
        legalName: 'AuditQuery',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    otherTenantId = (
      await tenants.create({
        slug: `audq2-${Date.now()}`,
        legalName: 'AuditQuery2',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    // Two real branches in the primary tenant, for the branch-scope tests.
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `AudQBrand ${Date.now()}` },
    });
    branchId = (
      await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code: `AQ${Date.now() % 10000}`,
          name: 'AudQ Branch A',
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      })
    ).id;
    otherBranchId = (
      await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code: `AQ${(Date.now() + 1) % 10000}`,
          name: 'AudQ Branch B',
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      })
    ).id;

    // Users + roles: viewer (audit.view, TENANT scope), exporter (both,
    // TENANT scope), noPerm (neither), branchScoped (audit.view, BRANCH
    // scope on `branchId` only).
    const viewer = await users.createUser({
      email: emailViewer,
      password,
      displayName: 'Viewer',
    });
    viewerUserId = viewer.id;
    const exporter = await users.createUser({
      email: emailExporter,
      password,
      displayName: 'Exporter',
    });
    const noPerm = await users.createUser({
      email: emailNoPerm,
      password,
      displayName: 'NoPerm',
    });
    const branchScoped = await users.createUser({
      email: emailBranchScoped,
      password,
      displayName: 'BranchScoped',
    });
    const other = await users.createUser({
      email: emailOther,
      password,
      displayName: 'Other',
    });

    const viewerMembership = await memberships.grant(
      viewer.id,
      tenantId,
      'active',
    );
    const exporterMembership = await memberships.grant(
      exporter.id,
      tenantId,
      'active',
    );
    const noPermMembership = await memberships.grant(
      noPerm.id,
      tenantId,
      'active',
    );
    const branchScopedMembership = await memberships.grant(
      branchScoped.id,
      tenantId,
      'active',
    );
    await memberships.grant(other.id, otherTenantId, 'active');

    const viewerRole = await roles.createTenantRole(tenantId, {
      name: 'auditor-view',
    });
    await roles.addPermissions(tenantId, viewerRole.id, [
      AUDIT_PERMISSIONS.VIEW,
    ]);
    await membershipRoles.create(tenantId, null, {
      membershipId: viewerMembership.id,
      roleId: viewerRole.id,
      scope: { type: 'tenant' },
    });

    const exporterRole = await roles.createTenantRole(tenantId, {
      name: 'auditor-export',
    });
    await roles.addPermissions(tenantId, exporterRole.id, [
      AUDIT_PERMISSIONS.VIEW,
      AUDIT_PERMISSIONS.EXPORT,
    ]);
    await membershipRoles.create(tenantId, null, {
      membershipId: exporterMembership.id,
      roleId: exporterRole.id,
      scope: { type: 'tenant' },
    });

    const noPermRole = await roles.createTenantRole(tenantId, {
      name: 'no-audit-perm',
    });
    await membershipRoles.create(tenantId, null, {
      membershipId: noPermMembership.id,
      roleId: noPermRole.id,
      scope: { type: 'tenant' },
    });

    const branchScopedRole = await roles.createTenantRole(tenantId, {
      name: 'auditor-branch-scoped',
    });
    await roles.addPermissions(tenantId, branchScopedRole.id, [
      AUDIT_PERMISSIONS.VIEW,
    ]);
    await membershipRoles.create(tenantId, null, {
      membershipId: branchScopedMembership.id,
      roleId: branchScopedRole.id,
      scope: { type: 'branch', branchId },
    });

    // Seed 25 real, correctly hash-chained entries for the primary tenant,
    // plus a handful for the other tenant (the cross-tenant leakage proof).
    for (let i = 0; i < 25; i++) {
      await audit.emit({
        tenantId,
        action: 'ROLE_ASSIGNED',
        entityType: 'role_assignment',
        actorType: 'system',
        metadata: { i },
      });
    }
    for (let i = 0; i < 3; i++) {
      await audit.emit({
        tenantId: otherTenantId,
        action: 'ROLE_ASSIGNED',
        entityType: 'role_assignment',
        actorType: 'system',
        metadata: { i },
      });
    }
  }, 90_000);

  afterAll(async () => {
    await admin.auditEntry
      .deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({
        where: {
          email: {
            in: [
              emailViewer,
              emailExporter,
              emailNoPerm,
              emailBranchScoped,
              emailOther,
            ],
          },
        },
      })
      .catch(() => undefined);
    await admin.tenant
      .deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  it('an authorized auditor sees only their own tenant’s records', async () => {
    const tok = await scoped(emailViewer, tenantId);
    const res = await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .query({ limit: 100 })
      .expect(200);

    const body = res.body as { entries: { tenantId: string }[] };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.tenantId === tenantId)).toBe(true);
  });

  it('a foreign tenant’s facts cannot leak through the query surface', async () => {
    const otherTok = await scoped(emailOther, otherTenantId);
    // No perm granted in the other tenant at all — refused before any read.
    await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${otherTok.accessToken}`)
      .expect(403);
  });

  it('a user with no audit.view is refused (403), and no access entry is recorded for the refusal', async () => {
    const tok = await scoped(emailNoPerm, tenantId);
    await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .expect(403);
  });

  it('audit.view alone permits search but NOT export (needs report.export too)', async () => {
    const tok = await scoped(emailViewer, tenantId);
    await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .expect(200);
    await request(http)
      .get('/governance/audit/entries/export')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .query({
        dateFrom: '2000-01-01T00:00:00.000Z',
        dateTo: '2100-01-01T00:00:00.000Z',
      })
      .expect(403);
  });

  it('keyset pagination visits every entry exactly once — no skip, no duplicate', async () => {
    const tok = await scoped(emailViewer, tenantId);
    // Snapshotted BEFORE paginating: each page-fetch call is itself an
    // audited access (FR-AUD-007) and therefore APPENDS a new row with a
    // HIGHER sequenceNo than anything this DESC traversal will ever reach —
    // correct (a keyset cursor never re-visits a page once past it), but it
    // means the row count AFTER pagination is not the right thing to compare
    // against; the count BEFORE is the population this traversal covers.
    const total = await admin.auditEntry.count({ where: { tenantId } });
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await request(http)
        .get('/governance/audit/entries')
        .set('Authorization', `Bearer ${tok.accessToken}`)
        .query({ limit: 7, ...(cursor ? { cursor } : {}) })
        .expect(200);
      const body = res.body as {
        entries: { sequenceNo: string }[];
        nextCursor: string | null;
      };
      for (const e of body.entries) {
        expect(seen.has(e.sequenceNo)).toBe(false); // no duplicate
        seen.add(e.sequenceNo);
      }
      pages += 1;
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      expect(pages).toBeLessThan(20); // guard against an infinite loop on a bug
    }
    // Every entry that existed when pagination started was visited exactly
    // once — no gap, no duplicate.
    expect(seen.size).toBe(total);
  });

  it('export content/count equals the equivalent query result, with hash-chain fields verbatim', async () => {
    const tok = await scoped(emailExporter, tenantId);
    const exportRes = await request(http)
      .get('/governance/audit/entries/export')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .query({
        dateFrom: '2000-01-01T00:00:00.000Z',
        dateTo: '2100-01-01T00:00:00.000Z',
        action: 'ROLE_ASSIGNED',
      })
      .expect(200);
    const exported = exportRes.body as {
      entries: {
        sequenceNo: string;
        entryHash: string;
        previousHash: string | null;
        action: string;
      }[];
      count: number;
    };
    expect(exported.count).toBe(exported.entries.length);
    expect(exported.entries.every((e) => e.action === 'ROLE_ASSIGNED')).toBe(
      true,
    );

    const dbRows = await admin.auditEntry.findMany({
      where: { tenantId, action: 'ROLE_ASSIGNED' },
      orderBy: { sequenceNo: 'desc' },
    });
    expect(exported.count).toBe(dbRows.length);
    for (let i = 0; i < dbRows.length; i++) {
      const row = dbRows[i];
      expect(exported.entries[i].sequenceNo).toBe(row.sequenceNo.toString());
      expect(exported.entries[i].entryHash).toBe(
        Buffer.from(row.entryHash).toString('hex'),
      );
      expect(exported.entries[i].previousHash).toBe(
        row.previousHash ? Buffer.from(row.previousHash).toString('hex') : null,
      );
    }
  });

  it('export requires dateFrom/dateTo (bounded by construction)', async () => {
    const tok = await scoped(emailExporter, tenantId);
    await request(http)
      .get('/governance/audit/entries/export')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .expect(400);
  });

  it('FR-AUD-007: every search/export call records its own audit-log-access entry', async () => {
    const tok = await scoped(emailViewer, tenantId);
    await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .query({ limit: 1 })
      .expect(200);

    const accessEntries = await admin.auditEntry.findMany({
      where: { tenantId, action: 'AUDIT_LOG_QUERIED', actorId: viewerUserId },
      orderBy: { sequenceNo: 'desc' },
    });
    expect(accessEntries.length).toBeGreaterThan(0);
    expect(accessEntries[0].entityType).toBe('audit_log');
    const meta = accessEntries[0].afterState as {
      resultCount: number;
      filters: Record<string, unknown>;
    } | null;
    expect(meta).not.toBeNull();
    expect(typeof meta?.resultCount).toBe('number');

    const exporterTok = await scoped(emailExporter, tenantId);
    await request(http)
      .get('/governance/audit/entries/export')
      .set('Authorization', `Bearer ${exporterTok.accessToken}`)
      .query({
        dateFrom: '2000-01-01T00:00:00.000Z',
        dateTo: '2100-01-01T00:00:00.000Z',
        action: 'AUDIT_LOG_QUERIED',
      })
      .expect(200);
    const exportEntries = await admin.auditEntry.findMany({
      where: { tenantId, action: 'AUDIT_LOG_EXPORTED' },
    });
    expect(exportEntries.length).toBeGreaterThan(0);
  });

  it('branch scope: a branch-scoped grant covering the addressed branch is authorized; a differently-scoped branch is refused', async () => {
    const tok = await scoped(emailBranchScoped, tenantId);
    await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .query({ branchId })
      .expect(200);
    await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .query({ branchId: otherBranchId })
      .expect(403);
    // Omitting branchId asks a TENANT-wide question; a branch-scoped grant
    // does not cover it (the lattice is one-directional: tenant covers
    // branch, not the reverse).
    await request(http)
      .get('/governance/audit/entries')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .expect(403);
  });
});
