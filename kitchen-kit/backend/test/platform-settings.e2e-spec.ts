import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { newId } from './../src/common/ids';
import { IDENTITY_PERMISSIONS } from './../src/modules/identity/authz/permissions.constants';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * FULL-SRS-PLT-SETTINGS-RESOLVER-P1 — FR-PLT-025/026/027.
 *
 * Authority: `docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md`.
 * SRS §6.4: Platform Default -> Country Pack -> Tenant -> Brand -> Branch ->
 * Terminal. Letters A-S below refer to that report's TESTS section; S itself
 * (module-boundary suite remains clean) is proved by
 * `src/modules/module-boundaries.spec.ts` and
 * `src/modules/authorization-coverage.spec.ts`, not repeated here.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const shortStamp = stamp.toString().slice(-6);

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}

interface EffectiveSettingBody {
  hasEffectiveValue: boolean;
  effectiveValue: unknown;
  effectiveSourceLevel: string | null;
  effectiveSourceTargetId: string | null;
  isLocked: boolean;
  lockedAtLevel: string | null;
  lockedByTargetId: string | null;
}
interface InspectorLevelBody {
  level: string;
  eligible: boolean;
  targetId: string | null;
  configuredValue: unknown;
  locked: boolean;
  isEffectiveSource: boolean;
  shadowedByLowerOverride: boolean;
  blockedByHigherLock: boolean;
}
interface InspectorBody {
  effective: EffectiveSettingBody;
  levels: InspectorLevelBody[];
}
const effBody = (res: { body: unknown }): EffectiveSettingBody =>
  res.body as EffectiveSettingBody;
const inspBody = (res: { body: unknown }): InspectorBody =>
  res.body as InspectorBody;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Platform settings resolver (e2e) — FR-PLT-025/026/027', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let appPrisma: PrismaService;

  let tenantA: string;
  let tenantB: string;
  let brandA1: string;
  let brandA2: string;
  let branchA1: string;
  let branchA2: string;
  let terminalA1: string;
  let brandB: string;
  let branchB: string;

  let ownerTokenA: string;
  let noPermTokenA: string;
  let ownerTokenB: string;

  const scoped = async (email: string, tenantId: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .send({ tenantId })
      .expect(200);
    return (sel.body as Tokens).accessToken;
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();
    appPrisma = app.get(PrismaService);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    tenantA = (
      await tenants.create({
        slug: `plt-a-${stamp}`,
        legalName: 'PLT Tenant A',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `plt-b-${stamp}`,
        legalName: 'PLT Tenant B',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mk = async (
      email: string,
      tenantId: string,
      codes: string[],
    ): Promise<void> => {
      const u = await users.createUser({ email, password, displayName: 'P' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length > 0) {
        const role = await roles.createTenantRole(tenantId, {
          name: `plt-role-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.create(tenantId, null, {
          membershipId: m.id,
          roleId: role.id,
          scope: { type: 'tenant' },
        });
      }
    };

    const emailOwnerA = `plt.ownerA.${stamp}@example.com`;
    const emailNoPermA = `plt.noPermA.${stamp}@example.com`;
    const emailOwnerB = `plt.ownerB.${stamp}@example.com`;

    await mk(emailOwnerA, tenantA, [
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.TENANT_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
    ]);
    await mk(emailNoPermA, tenantA, []);
    await mk(emailOwnerB, tenantB, [
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.TENANT_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
    ]);

    ownerTokenA = await scoped(emailOwnerA, tenantA);
    noPermTokenA = await scoped(emailNoPermA, tenantA);
    ownerTokenB = await scoped(emailOwnerB, tenantB);

    const mkBrand = async (token: string, name: string): Promise<string> => {
      const res = await request(http)
        .post('/org/brands')
        .set(auth(token))
        .send({ name })
        .expect(201);
      return (res.body as WithId).id;
    };
    const mkBranch = async (
      token: string,
      brandId: string,
      code: string,
    ): Promise<string> => {
      const res = await request(http)
        .post('/org/branches')
        .set(auth(token))
        .send({
          brandId,
          code,
          name: `Branch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        })
        .expect(201);
      return (res.body as WithId).id;
    };

    brandA1 = await mkBrand(ownerTokenA, `Brand A1 ${shortStamp}`);
    brandA2 = await mkBrand(ownerTokenA, `Brand A2 ${shortStamp}`);
    branchA1 = await mkBranch(ownerTokenA, brandA1, `PLTA1${shortStamp}`);
    branchA2 = await mkBranch(ownerTokenA, brandA2, `PLTA2${shortStamp}`);
    brandB = await mkBrand(ownerTokenB, `Brand B ${shortStamp}`);
    branchB = await mkBranch(ownerTokenB, brandB, `PLTB${shortStamp}`);

    const terminalRes = await request(http)
      .post('/auth/terminals')
      .set(auth(ownerTokenA))
      .send({
        branchId: branchA1,
        name: `T1-${shortStamp}`,
        terminalType: 'pos',
      })
      .expect(201);
    terminalA1 = (terminalRes.body as WithId).id;
  }, 60000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  let keyCounter = 0;
  const nextKey = () => `test.plt_key_${stamp}_${++keyCounter}`;

  const resolveKey = (
    token: string,
    settingKey: string,
    q: { brandId?: string; branchId?: string; terminalId?: string } = {},
  ) =>
    request(http)
      .get('/platform/settings/resolve')
      .query({ settingKey, ...q })
      .set(auth(token));

  const inspectKey = (
    token: string,
    settingKey: string,
    q: { brandId?: string; branchId?: string; terminalId?: string } = {},
  ) =>
    request(http)
      .get('/platform/settings/inspect')
      .query({ settingKey, ...q })
      .set(auth(token));

  let idemCounter = 0;
  const idemKey = () => `plt-${stamp}-${++idemCounter}`;

  const putTenant = (
    token: string,
    settingKey: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .put(`/platform/settings/tenant/${settingKey}`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send(body);
  const putBrand = (
    token: string,
    brandId: string,
    settingKey: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .put(`/platform/settings/brand/${brandId}/${settingKey}`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send(body);
  const putBranch = (
    token: string,
    branchId: string,
    settingKey: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .put(`/platform/settings/branch/${branchId}/${settingKey}`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send(body);
  const putTerminal = (
    token: string,
    terminalId: string,
    settingKey: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .put(`/platform/settings/terminal/${terminalId}/${settingKey}`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send(body);
  const deleteBranch = (token: string, branchId: string, settingKey: string) =>
    request(http)
      .delete(`/platform/settings/branch/${branchId}/${settingKey}`)
      .set(auth(token));

  // ==================================================================== A
  it('A: platform default resolves when nothing overrides', async () => {
    const key = nextKey();
    await appPrisma.platformDefaultSetting.create({
      data: {
        id: newId(),
        settingKey: key,
        value: { hello: 'platform-default' },
        createdBy: (
          await admin.membership.findFirstOrThrow({
            where: { tenantId: tenantA },
          })
        ).userId,
      },
    });

    const res = await resolveKey(ownerTokenA, key).expect(200);
    expect(effBody(res).hasEffectiveValue).toBe(true);
    expect(effBody(res).effectiveSourceLevel).toBe('platform');
    expect(effBody(res).effectiveValue).toEqual({ hello: 'platform-default' });
    expect(effBody(res).isLocked).toBe(false);
  });

  // ==================================================================== B
  // The composition rule itself ("a lower level overrides a higher one") is
  // level-agnostic and is proven generically by test C-F below (same
  // `computeEffective` walk `country_pack` goes through). What is specific
  // to `country_pack` is whether `COUNTRY_PACK_SETTING_FACT_QUERY` actually
  // produces a value for a supported key — that requires a genuinely
  // ACTIVATED, signature-verified Country Pack, which no e2e suite in this
  // repository loads (`COUNTRY_PACK_DIR` is unset by default, deliberately —
  // see `country-pack.loader.ts`'s own docblock: "unconfigured ... activates
  // nothing"). That half is proven at the unit level instead — see
  // `src/modules/localisation/country-pack/country-pack-setting-fact.query.service.spec.ts`.
  // This e2e test proves the OTHER honest half: with no pack activated, the
  // Country Pack tier correctly contributes nothing (never fabricates a
  // value) and resolution falls through to Platform Default.
  it('B: with no Country Pack activated, the tier honestly contributes nothing and platform default resolves', async () => {
    const key = 'payments.cash_rounding_policy';
    const creator = await admin.membership.findFirstOrThrow({
      where: { tenantId: tenantA },
    });
    await appPrisma.platformDefaultSetting.upsert({
      where: { settingKey: key },
      create: {
        id: newId(),
        settingKey: key,
        value: { fromPlatformDefault: true },
        createdBy: creator.userId,
      },
      update: { value: { fromPlatformDefault: true } },
    });

    const res = await resolveKey(ownerTokenA, key).expect(200);
    expect(effBody(res).effectiveSourceLevel).toBe('platform');
    expect(effBody(res).effectiveValue).toEqual({ fromPlatformDefault: true });

    const inspected = await inspectKey(ownerTokenA, key).expect(200);
    const cpView = inspBody(inspected).levels.find(
      (l) => l.level === 'country_pack',
    );
    expect(cpView?.eligible).toBe(true);
    expect(cpView?.configuredValue).toBeNull();
  });

  // ==================================================================== C-F
  it('C-F: tenant -> brand -> branch -> terminal, each overriding the level above', async () => {
    const key = nextKey();

    await putTenant(ownerTokenA, key, { value: { tier: 'tenant' } }).expect(
      200,
    );
    let res = await resolveKey(ownerTokenA, key, { branchId: branchA1 }).expect(
      200,
    );
    expect(effBody(res).effectiveSourceLevel).toBe('tenant');
    expect(effBody(res).effectiveValue).toEqual({ tier: 'tenant' });

    await putBrand(ownerTokenA, brandA1, key, {
      value: { tier: 'brand' },
    }).expect(200);
    res = await resolveKey(ownerTokenA, key, { branchId: branchA1 }).expect(
      200,
    );
    expect(effBody(res).effectiveSourceLevel).toBe('brand');
    expect(effBody(res).effectiveValue).toEqual({ tier: 'brand' });

    await putBranch(ownerTokenA, branchA1, key, {
      value: { tier: 'branch' },
    }).expect(200);
    res = await resolveKey(ownerTokenA, key, { branchId: branchA1 }).expect(
      200,
    );
    expect(effBody(res).effectiveSourceLevel).toBe('branch');
    expect(effBody(res).effectiveValue).toEqual({ tier: 'branch' });

    await putTerminal(ownerTokenA, terminalA1, key, {
      value: { tier: 'terminal' },
    }).expect(200);
    res = await resolveKey(ownerTokenA, key, { terminalId: terminalA1 }).expect(
      200,
    );
    expect(effBody(res).effectiveSourceLevel).toBe('terminal');
    expect(effBody(res).effectiveValue).toEqual({ tier: 'terminal' });
  });

  // ==================================================================== G
  it('G: tenant lock blocks brand/branch/terminal overrides', async () => {
    const key = nextKey();
    await putTenant(ownerTokenA, key, {
      value: { tier: 'tenant-locked' },
      locked: true,
    }).expect(200);

    // Lower-level writes beneath the lock are rejected (test I lives here
    // too — the write itself must fail, not merely be shadowed on read).
    await putBrand(ownerTokenA, brandA1, key, {
      value: { tier: 'brand' },
    }).expect(409);
    await putBranch(ownerTokenA, branchA1, key, {
      value: { tier: 'branch' },
    }).expect(409);
    await putTerminal(ownerTokenA, terminalA1, key, {
      value: { tier: 'terminal' },
    }).expect(409);

    const res = await resolveKey(ownerTokenA, key, {
      terminalId: terminalA1,
    }).expect(200);
    expect(effBody(res).effectiveSourceLevel).toBe('tenant');
    expect(effBody(res).effectiveValue).toEqual({ tier: 'tenant-locked' });
    expect(effBody(res).isLocked).toBe(true);
    expect(effBody(res).lockedAtLevel).toBe('tenant');
  });

  // ==================================================================== H
  it('H: branch lock blocks terminal override', async () => {
    const key = nextKey();
    await putTenant(ownerTokenA, key, { value: { tier: 'tenant' } }).expect(
      200,
    );
    await putBrand(ownerTokenA, brandA1, key, {
      value: { tier: 'brand' },
    }).expect(200);
    await putBranch(ownerTokenA, branchA1, key, {
      value: { tier: 'branch-locked' },
      locked: true,
    }).expect(200);

    await putTerminal(ownerTokenA, terminalA1, key, {
      value: { tier: 'terminal' },
    }).expect(409);

    const res = await resolveKey(ownerTokenA, key, {
      terminalId: terminalA1,
    }).expect(200);
    expect(effBody(res).effectiveSourceLevel).toBe('branch');
    expect(effBody(res).effectiveValue).toEqual({ tier: 'branch-locked' });
    expect(effBody(res).isLocked).toBe(true);
    expect(effBody(res).lockedAtLevel).toBe('branch');
  });

  // ==================================================================== J
  it('J: removing an override restores inheritance', async () => {
    const key = nextKey();
    await putTenant(ownerTokenA, key, { value: { tier: 'tenant' } }).expect(
      200,
    );
    await putBranch(ownerTokenA, branchA1, key, {
      value: { tier: 'branch' },
    }).expect(200);

    let res = await resolveKey(ownerTokenA, key, { branchId: branchA1 }).expect(
      200,
    );
    expect(effBody(res).effectiveSourceLevel).toBe('branch');

    await deleteBranch(ownerTokenA, branchA1, key).expect(204);

    res = await resolveKey(ownerTokenA, key, { branchId: branchA1 }).expect(
      200,
    );
    expect(effBody(res).effectiveSourceLevel).toBe('tenant');
    expect(effBody(res).effectiveValue).toEqual({ tier: 'tenant' });

    // Unsetting a second time (nothing left to remove) is a clean 404, not a
    // silent no-op.
    await deleteBranch(ownerTokenA, branchA1, key).expect(404);
  });

  // ==================================================================== K-M
  it('K-M: inspector identifies the effective source, lists every level, and marks shadowed vs lock-blocked entries', async () => {
    const key = nextKey();
    await putTenant(ownerTokenA, key, { value: { tier: 'tenant' } }).expect(
      200,
    );
    await putBrand(ownerTokenA, brandA1, key, {
      value: { tier: 'brand' },
    }).expect(200);

    const res = await inspectKey(ownerTokenA, key, {
      branchId: branchA1,
    }).expect(200);
    expect(inspBody(res).effective.effectiveSourceLevel).toBe('brand');
    expect(inspBody(res).levels).toHaveLength(6);
    expect(inspBody(res).levels.map((l) => l.level)).toEqual([
      'platform',
      'country_pack',
      'tenant',
      'brand',
      'branch',
      'terminal',
    ]);

    const tenantView = inspBody(res).levels.find((l) => l.level === 'tenant');
    expect(tenantView?.configuredValue).toEqual({ tier: 'tenant' });
    expect(tenantView?.shadowedByLowerOverride).toBe(true);
    expect(tenantView?.isEffectiveSource).toBe(false);

    const brandView = inspBody(res).levels.find((l) => l.level === 'brand');
    expect(brandView?.isEffectiveSource).toBe(true);
    expect(brandView?.shadowedByLowerOverride).toBe(false);
    expect(brandView?.blockedByHigherLock).toBe(false);

    // Lock-blocked case: the SRS §6.4 worked example (platform-settings
    // report §3) is "tenant C, locked ... branch D EXISTS ... branch D does
    // NOT win" — the lower row exists independently of the lock, so it must
    // be written BEFORE the tenant lock is applied (a write beneath an
    // already-locked ancestor is itself rejected — see test G/I).
    const lockedKey = nextKey();
    await putBranch(ownerTokenA, branchA1, lockedKey, {
      value: { tier: 'branch-preexisting' },
    }).expect(200);
    await putTenant(ownerTokenA, lockedKey, {
      value: { tier: 'tenant-locked' },
      locked: true,
    }).expect(200);
    const inspected = await inspectKey(ownerTokenA, lockedKey, {
      branchId: branchA1,
    }).expect(200);
    const branchView = inspBody(inspected).levels.find(
      (l) => l.level === 'branch',
    );
    expect(branchView?.configuredValue).toEqual({
      tier: 'branch-preexisting',
    });
    expect(branchView?.blockedByHigherLock).toBe(true);
    expect(branchView?.isEffectiveSource).toBe(false);
    expect(inspBody(inspected).effective.effectiveSourceLevel).toBe('tenant');
  });

  // ==================================================================== N
  it('N: cross-tenant target ids rejected', async () => {
    const key = nextKey();
    await resolveKey(ownerTokenA, key, { brandId: brandB }).expect(404);
    await resolveKey(ownerTokenA, key, { branchId: branchB }).expect(404);
    await putBrand(ownerTokenA, brandB, key, { value: 1 }).expect(404);
    await putBranch(ownerTokenA, branchB, key, { value: 1 }).expect(404);
  });

  // ==================================================================== O
  it('O: branch/brand/terminal hierarchy mismatch rejected', async () => {
    const key = nextKey();
    // branchA2's real parent is brandA2, not brandA1.
    await resolveKey(ownerTokenA, key, {
      brandId: brandA1,
      branchId: branchA2,
    }).expect(404);
    // terminalA1's real parent is branchA1, not branchA2.
    await resolveKey(ownerTokenA, key, {
      branchId: branchA2,
      terminalId: terminalA1,
    }).expect(404);
  });

  // ==================================================================== P
  it('P: unauthorized actor cannot mutate settings', async () => {
    const key = nextKey();
    await putTenant(noPermTokenA, key, { value: 1 }).expect(403);
    await putBranch(noPermTokenA, branchA1, key, { value: 1 }).expect(403);
  });

  // ==================================================================== Q
  it('Q: no HTTP route exists to mutate platform-level defaults (any tenant actor, including this one)', async () => {
    const key = nextKey();
    // DOCUMENTED GAP, not a bug: see the design report's
    // BLOCKERS_OR_UNCERTAINTIES for why a Platform-Default write route is
    // out of scope this slice — this repository has no cross-tenant
    // "platform administrator" actor to guard such a route with.
    await request(http)
      .put(`/platform/settings/platform/${key}`)
      .set(auth(ownerTokenA))
      .send({ value: 1 })
      .expect(404);
  });

  // ==================================================================== R
  it('R: RLS protects tenant-scoped setting rows', async () => {
    const key = nextKey();
    await putTenant(ownerTokenA, key, { value: { secret: 'a' } }).expect(200);

    const seenByOwn = await appPrisma.withAuthContext(
      { tenantId: tenantA },
      (tx) => tx.settingValue.findMany({ where: { settingKey: key } }),
    );
    expect(seenByOwn).toHaveLength(1);

    const seenByOther = await appPrisma.withAuthContext(
      { tenantId: tenantB },
      (tx) => tx.settingValue.findMany({ where: { settingKey: key } }),
    );
    expect(seenByOther).toHaveLength(0);
  });
});
