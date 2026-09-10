import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { COUNTRY_PACK_SETTING_FACT_QUERY } from './../src/modules/localisation/contract';
import type {
  CountryPackSettingFact,
  CountryPackSettingFactInput,
  CountryPackSettingFactQuery,
} from './../src/modules/localisation/contract';
import { withCurrency } from './../src/modules/localisation/country-pack/country-pack.fixture';
import {
  generateReleaseKey,
  signPackDocument,
} from './../src/modules/localisation/country-pack/country-pack.signing.fixture';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import { SettingsInspectorService } from './../src/modules/platform-settings/settings-inspector.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * FULL-SRS-PLT-SETTINGS-CORRECTION-P1C §7 — real Country Pack activation for
 * two distinct, generic (non-Egypt) jurisdiction codes, proving
 * branch-accurate resolution. `COUNTRY_PACK_DIR`/`COUNTRY_PACK_TRUST_MANIFEST`
 * must be set BEFORE the Nest app boots (`CountryPackLoader.onModuleInit`
 * reads them once, at startup) — this runs before `Test.createTestingModule`
 * compiles below. Every other e2e suite in this repository leaves both unset
 * (`COUNTRY_PACK_DIR` "unconfigured ... activates nothing" per its own
 * docblock); this is the first to genuinely activate signed packs, using the
 * SAME ephemeral in-memory Ed25519 signing fixtures
 * `country-pack.registry.spec.ts` already uses — no private key is committed
 * or written to disk, only the resulting PUBLIC key (in the trust manifest)
 * and the signed pack documents.
 */
function activateTwoJurisdictionPacksBeforeBoot(): {
  readonly jurisdictionX: string;
  readonly jurisdictionY: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'plt-country-packs-'));
  const releaseKey = generateReleaseKey(`plt-settings-test-${stamp}`);

  // Two-letter, deliberately non-Egypt, non-real-country codes — SRS §6.4's
  // resolver treats a jurisdiction code as an opaque key (CR-03: "a KEY —
  // never a branch condition"), so any two distinct codes prove branch
  // accuracy equally well.
  const jurisdictionX = 'ZX';
  const jurisdictionY = 'ZY';

  const packX = signPackDocument(
    withCurrency(
      { code: 'XPA', cashRounding: { enabled: false } },
      {
        code: jurisdictionX,
        version: '1.0',
        // FR-PLT-026 / P2A-R1 clause 1 — jurisdiction X's pack locks the one
        // supported Country-Pack settings key, so the resolver e2e suite can
        // prove country_pack-level locking end-to-end (see the dedicated
        // "Country-Pack lock" test below).
        settingsLocks: ['payments.cash_rounding_policy'],
      },
    ),
    releaseKey,
  );
  const packY = signPackDocument(
    withCurrency(
      { code: 'XPB', cashRounding: { enabled: true, stepMinorUnits: 50 } },
      { code: jurisdictionY, version: '1.0' },
    ),
    releaseKey,
  );

  writeFileSync(join(dir, 'zx.pack.json'), JSON.stringify(packX));
  writeFileSync(join(dir, 'zy.pack.json'), JSON.stringify(packY));

  const trustManifestPath = join(dir, 'trust-manifest.json');
  writeFileSync(
    trustManifestPath,
    JSON.stringify({ keys: [releaseKey.trusted('active')] }),
  );

  process.env.COUNTRY_PACK_DIR = dir;
  process.env.COUNTRY_PACK_TRUST_MANIFEST = trustManifestPath;

  return { jurisdictionX, jurisdictionY };
}

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
interface ErrorBody {
  message: string;
}
const effBody = (res: { body: unknown }): EffectiveSettingBody =>
  res.body as EffectiveSettingBody;
const inspBody = (res: { body: unknown }): InspectorBody =>
  res.body as InspectorBody;
const errBody = (res: { body: unknown }): ErrorBody => res.body as ErrorBody;

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

  // FULL-SRS-PLT-SETTINGS-CORRECTION-P1C §7 — multi-country branch-accuracy
  // fixture. tenantC's OWN default is jurisdiction X; branchCX also sits in
  // X (so the tenant-default fallback and a branch-accurate resolve agree,
  // proving the fallback still works); branchCY sits in a DIFFERENT
  // jurisdiction Y, proving branch-accurate resolution actually overrides
  // the tenant default rather than merely happening to match it.
  let jurisdictionXCode: string;
  let jurisdictionYCode: string;
  let tenantC: string;
  let brandC: string;
  let branchCX: string;
  let branchCY: string;
  let terminalCX: string;
  let terminalCY: string;
  let ownerTokenC: string;

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
    const { jurisdictionX, jurisdictionY } =
      activateTwoJurisdictionPacksBeforeBoot();
    jurisdictionXCode = jurisdictionX;
    jurisdictionYCode = jurisdictionY;

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
    tenantC = (
      await tenants.create({
        slug: `plt-c-${stamp}`,
        legalName: 'PLT Tenant C',
        defaultCurrency: 'EGP',
        countryPackCode: jurisdictionXCode,
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
    const emailOwnerC = `plt.ownerC.${stamp}@example.com`;

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
    await mk(emailOwnerC, tenantC, [
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.TENANT_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
    ]);

    ownerTokenA = await scoped(emailOwnerA, tenantA);
    noPermTokenA = await scoped(emailNoPermA, tenantA);
    ownerTokenB = await scoped(emailOwnerB, tenantB);
    ownerTokenC = await scoped(emailOwnerC, tenantC);

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
      countryCode = 'EG',
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
          countryCode,
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

    brandC = await mkBrand(ownerTokenC, `Brand C ${shortStamp}`);
    branchCX = await mkBranch(
      ownerTokenC,
      brandC,
      `PLTCX${shortStamp}`,
      jurisdictionXCode,
    );
    branchCY = await mkBranch(
      ownerTokenC,
      brandC,
      `PLTCY${shortStamp}`,
      jurisdictionYCode,
    );

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

    const terminalCYRes = await request(http)
      .post('/auth/terminals')
      .set(auth(ownerTokenC))
      .send({
        branchId: branchCY,
        name: `TCY-${shortStamp}`,
        terminalType: 'pos',
      })
      .expect(201);
    terminalCY = (terminalCYRes.body as WithId).id;

    const terminalCXRes = await request(http)
      .post('/auth/terminals')
      .set(auth(ownerTokenC))
      .send({
        branchId: branchCX,
        name: `TCX-${shortStamp}`,
        terminalType: 'pos',
      })
      .expect(201);
    terminalCX = (terminalCXRes.body as WithId).id;
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
  // value). Pre-P2C1-R1 this fell through to Platform Default; POST-P2C1-R1,
  // `payments.cash_rounding_policy` is provider-exclusive, so `platform` is
  // ALSO ineligible for it (see Case A/B above) — a configured Platform
  // Default row for this key is now correctly INERT, exactly like a stale
  // tenant/brand/branch/terminal row, and resolution genuinely has no
  // effective value at all. This is the platform-level half of P2C1-R1 §5's
  // stale-row-behaviour requirement.
  it('B: with no Country Pack activated, the tier honestly contributes nothing, and a configured Platform Default is inert (payments.cash_rounding_policy is provider-exclusive, P2C1-R1)', async () => {
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
    expect(effBody(res).hasEffectiveValue).toBe(false);
    expect(effBody(res).effectiveSourceLevel).toBeNull();

    const inspected = await inspectKey(ownerTokenA, key).expect(200);
    const byLevel = new Map(
      inspBody(inspected).levels.map((l) => [l.level, l]),
    );
    // country_pack: eligible (the key IS supported), honestly unconfigured
    // (no pack activated for tenantA's jurisdiction in this e2e run).
    expect(byLevel.get('country_pack')?.eligible).toBe(true);
    expect(byLevel.get('country_pack')?.configuredValue).toBeNull();
    // platform: provider-exclusive — ineligible REGARDLESS of the row this
    // test just configured; it is never read, never reported.
    expect(byLevel.get('platform')?.eligible).toBe(false);
    expect(byLevel.get('platform')?.configuredValue).toBeNull();
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

  // ============================================== P1C item 6 — Platform-Default lock
  it('Platform-Default lock blocks every lower level, both on read and on write, and the inspector shows it (CORRECTION-P1C item 6)', async () => {
    const key = nextKey();

    // A tenant-level value already exists BEFORE the platform lock is
    // applied — proving "existing lower-level rows must not affect
    // effective resolution" (FR-PLT-026), not merely "a write beneath an
    // already-locked ancestor is rejected" (that is proven separately, on
    // the WRITE side, below).
    await putTenant(ownerTokenA, key, {
      value: { tier: 'tenant-preexisting' },
    }).expect(200);

    const creator = await admin.membership.findFirstOrThrow({
      where: { tenantId: tenantA },
    });
    await appPrisma.platformDefaultSetting.create({
      data: {
        id: newId(),
        settingKey: key,
        value: { tier: 'platform-locked' },
        locked: true,
        createdBy: creator.userId,
      },
    });

    // Resolve: the platform lock wins outright, the pre-existing tenant row
    // never applies.
    const resolved = await resolveKey(ownerTokenA, key, {
      branchId: branchA1,
    }).expect(200);
    expect(effBody(resolved).effectiveSourceLevel).toBe('platform');
    expect(effBody(resolved).effectiveValue).toEqual({
      tier: 'platform-locked',
    });
    expect(effBody(resolved).isLocked).toBe(true);
    expect(effBody(resolved).lockedAtLevel).toBe('platform');

    // Inspector: every lower level (tenant included, even though it has a
    // real configured row) is reported blocked, never the effective source.
    const inspected = await inspectKey(ownerTokenA, key, {
      branchId: branchA1,
    }).expect(200);
    expect(inspBody(inspected).effective.effectiveSourceLevel).toBe('platform');
    const platformView = inspBody(inspected).levels.find(
      (l) => l.level === 'platform',
    );
    expect(platformView?.isEffectiveSource).toBe(true);
    expect(platformView?.locked).toBe(true);
    const tenantView = inspBody(inspected).levels.find(
      (l) => l.level === 'tenant',
    );
    expect(tenantView?.configuredValue).toEqual({ tier: 'tenant-preexisting' });
    expect(tenantView?.blockedByHigherLock).toBe(true);
    expect(tenantView?.isEffectiveSource).toBe(false);
    // branch has no configured row of its own in this scenario — "blocked"
    // only describes a level that HAS a value the lock prevented from
    // winning (mirrors test K-M's own convention); with nothing configured
    // there, `eligible` is still true but there is nothing to be blocked.
    const branchView = inspBody(inspected).levels.find(
      (l) => l.level === 'branch',
    );
    expect(branchView?.eligible).toBe(true);
    expect(branchView?.configuredValue).toBeNull();
    expect(branchView?.blockedByHigherLock).toBe(false);

    // Write: a NEW override beneath the platform lock is rejected
    // server-side, exactly like a tenant/branch lock already proves for the
    // levels below THEM (tests G/H) — the SAME generic check, now proven
    // for the platform level specifically.
    await putBrand(ownerTokenA, brandA1, key, {
      value: { tier: 'brand' },
    }).expect(409);
    await putBranch(ownerTokenA, branchA1, key, {
      value: { tier: 'branch-2' },
    }).expect(409);
  });

  // ============================================== P1C item 7 — branch-accurate Country Pack
  it('Country-Pack resolution is branch-accurate, not tenant-default-only (CORRECTION-P1C item 7)', async () => {
    const key = 'payments.cash_rounding_policy';

    // branchCX sits in the SAME jurisdiction as tenantC's own default (X) —
    // a sanity check that branch-accurate resolution still agrees with the
    // tenant default when they happen to match.
    const resolvedX = await resolveKey(ownerTokenC, key, {
      branchId: branchCX,
    }).expect(200);
    expect(effBody(resolvedX).effectiveSourceLevel).toBe('country_pack');
    const valueX = effBody(resolvedX).effectiveValue as {
      currencyCode: string;
      cashRoundingEnabled: boolean;
    };
    expect(valueX.currencyCode).toBe('XPA');
    expect(valueX.cashRoundingEnabled).toBe(false);

    // branchCY sits in a DIFFERENT jurisdiction (Y) — this is the actual
    // bug fix under test: resolving for branchCY must return Y's pack, NOT
    // tenantC's own default (X).
    const resolvedY = await resolveKey(ownerTokenC, key, {
      branchId: branchCY,
    }).expect(200);
    expect(effBody(resolvedY).effectiveSourceLevel).toBe('country_pack');
    expect(effBody(resolvedY).effectiveSourceTargetId).toBe(jurisdictionYCode);
    const valueY = effBody(resolvedY).effectiveValue as {
      currencyCode: string;
      cashRoundingEnabled: boolean;
      cashRoundingStepMinorUnits: string | null;
    };
    expect(valueY.currencyCode).toBe('XPB');
    expect(valueY.cashRoundingEnabled).toBe(true);
    expect(valueY.cashRoundingStepMinorUnits).toBe('50');
    // Proves this is genuinely branch-sourced, not the tenant default X.
    expect(valueY.currencyCode).not.toBe(valueX.currencyCode);

    // Tenant/brand-only (no branch in scope) — the honest fallback still
    // resolves the TENANT's own default (X), never Y.
    const resolvedTenantOnly = await resolveKey(ownerTokenC, key).expect(200);
    expect(effBody(resolvedTenantOnly).effectiveSourceTargetId).toBe(
      jurisdictionXCode,
    );

    // Terminal scope: terminalCY belongs to branchCY (not passed explicitly
    // here) — proves the terminal->branch derivation
    // (`SettingsScopeService.deriveScope`) feeds the SAME branch-accurate
    // jurisdiction, not a terminal-blind tenant fallback.
    const resolvedTerminal = await resolveKey(ownerTokenC, key, {
      terminalId: terminalCY,
    }).expect(200);
    expect(effBody(resolvedTerminal).effectiveSourceTargetId).toBe(
      jurisdictionYCode,
    );
    const terminalValue = effBody(resolvedTerminal).effectiveValue as {
      cashRoundingEnabled: boolean;
    };
    expect(terminalValue.cashRoundingEnabled).toBe(true);
  });

  // ============================================== P2C1-R1 Case A
  it('P2C1-R1 Case A: payments.cash_rounding_policy is provider-exclusive even when the active Country Pack declares NO settingsLocks', async () => {
    const key = 'payments.cash_rounding_policy';

    // jurisdiction Y's activated pack declares NO settingsLocks for this
    // key (see activateTwoJurisdictionPacksBeforeBoot above) — the
    // strongest possible proof that write-rejection is caused by
    // provider-exclusivity, never by an FR-PLT-026 lock: there is no lock
    // here at all.
    const resolved = await resolveKey(ownerTokenC, key, {
      branchId: branchCY,
    }).expect(200);
    expect(effBody(resolved).effectiveSourceLevel).toBe('country_pack');
    expect(effBody(resolved).isLocked).toBe(false);
    expect(effBody(resolved).lockedAtLevel).toBeNull();

    const inspected = await inspectKey(ownerTokenC, key, {
      branchId: branchCY,
    }).expect(200);
    const byLevel = new Map(
      inspBody(inspected).levels.map((l) => [l.level, l]),
    );
    expect(byLevel.get('country_pack')?.eligible).toBe(true);
    expect(byLevel.get('country_pack')?.isEffectiveSource).toBe(true);
    expect(byLevel.get('country_pack')?.locked).toBe(false);
    for (const level of ['platform', 'tenant', 'brand', 'branch', 'terminal']) {
      expect(byLevel.get(level)?.eligible).toBe(false);
    }

    // Writes at every generic level reject 409 — due to
    // provider-exclusivity, never a Country-Pack lock (this jurisdiction's
    // pack declares none). The message identifies provider-exclusivity and
    // never uses the word "locked".
    const messageRe = /exclusively governed by the Country Pack/;
    const tenantWrite = await putTenant(ownerTokenC, key, {
      value: { tier: 'tenant' },
    }).expect(409);
    expect(errBody(tenantWrite).message).toMatch(messageRe);
    expect(errBody(tenantWrite).message).not.toMatch(/locked/i);

    const brandWrite = await putBrand(ownerTokenC, brandC, key, {
      value: { tier: 'brand' },
    }).expect(409);
    expect(errBody(brandWrite).message).toMatch(messageRe);
    expect(errBody(brandWrite).message).not.toMatch(/locked/i);

    const branchWrite = await putBranch(ownerTokenC, branchCY, key, {
      value: { tier: 'branch' },
    }).expect(409);
    expect(errBody(branchWrite).message).toMatch(messageRe);
    expect(errBody(branchWrite).message).not.toMatch(/locked/i);

    const terminalWrite = await putTerminal(ownerTokenC, terminalCY, key, {
      value: { tier: 'terminal' },
    }).expect(409);
    expect(errBody(terminalWrite).message).toMatch(messageRe);
    expect(errBody(terminalWrite).message).not.toMatch(/locked/i);

    // unset/DELETE rejects for the same reason too — proving the
    // provider-exclusivity check runs BEFORE the "no existing override"
    // 404 path, even though no write could ever have created a row to
    // unset in the first place.
    const deleteResp = await deleteBranch(ownerTokenC, branchCY, key).expect(
      409,
    );
    expect(errBody(deleteResp).message).toMatch(messageRe);
    expect(errBody(deleteResp).message).not.toMatch(/locked/i);
  });

  // ============================================== P2C1-R1 Case B (supersedes FULL-SRS-PLT-COUNTRY-PACK-LOCK-P2B)
  it('P2C1-R1 Case B: payments.cash_rounding_policy is STILL provider-exclusive when the active Country Pack DOES declare settingsLocks — the READ honestly reflects the signed lock, but the WRITE rejection is not, by itself, proof of lock causality (see Case C)', async () => {
    const key = 'payments.cash_rounding_policy';

    // jurisdiction X's activated pack declares
    // `settingsLocks: ['payments.cash_rounding_policy']` (see
    // `activateTwoJurisdictionPacksBeforeBoot` above) — branchCX/tenantC
    // both sit in jurisdiction X. The READ side is unaffected by P2C1-R1:
    // isLocked/lockedAtLevel still honestly reflect the pack's own signed
    // settingsLocks declaration.
    const resolved = await resolveKey(ownerTokenC, key, {
      branchId: branchCX,
    }).expect(200);
    expect(effBody(resolved).effectiveSourceLevel).toBe('country_pack');
    expect(effBody(resolved).isLocked).toBe(true);
    expect(effBody(resolved).lockedAtLevel).toBe('country_pack');

    // Write: tenant/brand/branch/terminal writes for this key still reject
    // 409 here — but this is NOT, by itself, proof of Country-Pack lock
    // causality: Case A above already proves provider-exclusivity alone
    // rejects the identical write for a jurisdiction whose pack declares
    // NO lock at all. The message here still identifies
    // provider-exclusivity, not a lock, because that check fires first and
    // unconditionally. Independent, causally-isolated proof that the
    // GENERIC country_pack lock-walk mechanism itself works is Case C
    // below, using a synthetic, non-production key.
    const messageRe = /exclusively governed by the Country Pack/;
    const tenantWrite = await putTenant(ownerTokenC, key, {
      value: { tier: 'tenant' },
    }).expect(409);
    expect(errBody(tenantWrite).message).toMatch(messageRe);
    await putBrand(ownerTokenC, brandC, key, {
      value: { tier: 'brand' },
    }).expect(409);
    await putBranch(ownerTokenC, branchCX, key, {
      value: { tier: 'branch' },
    }).expect(409);
    await putTerminal(ownerTokenC, terminalCX, key, {
      value: { tier: 'terminal' },
    }).expect(409);

    // Stale-row behaviour (P2C1-R1 §5): a pre-existing branch-level row for
    // this key — inserted directly, bypassing the (now always-rejecting)
    // admin write path — is completely INERT: the branch level is
    // `eligible: false` regardless of the row's physical existence, so it
    // is never `blockedByHigherLock` (that would imply the resolver even
    // looked at it) and never reports the stale value back. This is a
    // STRONGER guarantee than "blocked": the row is structurally
    // invisible, not merely outranked.
    const creator = await admin.membership.findFirstOrThrow({
      where: { tenantId: tenantC },
    });
    await appPrisma.withAuthContext({ tenantId: tenantC }, (tx) =>
      tx.settingValue.create({
        data: {
          id: newId(),
          tenantId: tenantC,
          level: 'branch',
          targetId: branchCX,
          settingKey: key,
          value: { tier: 'branch-preexisting' },
          createdBy: creator.userId,
        },
      }),
    );

    const inspected = await inspectKey(ownerTokenC, key, {
      branchId: branchCX,
    }).expect(200);
    expect(inspBody(inspected).effective.effectiveSourceLevel).toBe(
      'country_pack',
    );
    const cpView = inspBody(inspected).levels.find(
      (l) => l.level === 'country_pack',
    );
    expect(cpView?.isEffectiveSource).toBe(true);
    expect(cpView?.locked).toBe(true);

    for (const level of ['platform', 'tenant', 'brand', 'branch', 'terminal']) {
      const view = inspBody(inspected).levels.find((l) => l.level === level);
      expect(view?.eligible).toBe(false);
      expect(view?.configuredValue).toBeNull();
      expect(view?.blockedByHigherLock).toBe(false);
      expect(view?.isEffectiveSource).toBe(false);
    }

    // Terminal-scoped case: branch-jurisdiction derivation
    // (`terminalCX -> branchCX -> jurisdiction X`,
    // `SettingsScopeService.deriveScope`) composes correctly with the
    // Country-Pack lock, and with provider-exclusivity.
    const resolvedTerminal = await resolveKey(ownerTokenC, key, {
      terminalId: terminalCX,
    }).expect(200);
    expect(effBody(resolvedTerminal).effectiveSourceLevel).toBe('country_pack');
    expect(effBody(resolvedTerminal).isLocked).toBe(true);
    expect(effBody(resolvedTerminal).lockedAtLevel).toBe('country_pack');
  });
});

/**
 * P2C1-R1 Case C — independent proof that the GENERIC `country_pack`-level
 * lock-walk mechanism (`SettingsResolverService.computeEffective`, via
 * `SettingsInspectorService`) causally stops lower resolution, decoupled
 * from provider-exclusivity and from any real production Country-Pack key.
 * Now that `payments.cash_rounding_policy` is provider-exclusive (Case A/B
 * above), it can no longer serve as this proof — every write for it is
 * rejected regardless of lock state. This describe block boots its OWN,
 * SEPARATE Nest application with `COUNTRY_PACK_SETTING_FACT_QUERY`
 * DI-overridden to a TEST-ONLY fake reporting a synthetic, non-production
 * settingKey as configured+locked at `country_pack` and explicitly NOT
 * provider-exclusive — proving the lock-walk stop on its own. The
 * synthetic key is never added to `COUNTRY_PACK_SETTING_KEYS` and never
 * touches the real Country-Pack parser's closed vocabulary; the override
 * is scoped to this second, isolated app instance and cannot affect the
 * shared app/describe block above.
 */
describe('Country-Pack lock causality (FR-PLT-026), independent of provider-exclusivity (P2C1-R1 Case C)', () => {
  const SYNTHETIC_LOCKED_KEY = `test.plt_lock_causality_${Date.now()}`;

  class FakeAlwaysLockedCountryPackSettingFactQuery implements CountryPackSettingFactQuery {
    getSettingFact(
      input: CountryPackSettingFactInput,
    ): CountryPackSettingFact | null | undefined {
      if (input.settingKey === SYNTHETIC_LOCKED_KEY) {
        return { value: { synthetic: true }, locked: true };
      }
      return undefined;
    }
    supportedSettingKeys(): readonly string[] {
      return [SYNTHETIC_LOCKED_KEY];
    }
    isProviderExclusive(): boolean {
      return false;
    }
  }

  let causalityApp: INestApplication<App>;
  let causalityPrisma: PrismaService;
  let tenantD: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_SETTING_FACT_QUERY)
      .useValue(new FakeAlwaysLockedCountryPackSettingFactQuery())
      .compile();
    causalityApp = moduleFixture.createNestApplication();
    await causalityApp.init();
    causalityPrisma = causalityApp.get(PrismaService);

    const permissions = causalityApp.get(PermissionsService);
    await permissions.ensureIdentityPermissions();

    const tenants = causalityApp.get(TenantsService);
    tenantD = (
      await tenants.create({
        slug: `plt-lockcause-${Date.now()}`,
        legalName: 'PLT Lock-Causality Tenant',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
  }, 60000);

  afterAll(async () => {
    await causalityApp.close();
  });

  it('country_pack-level lock stops lower resolution for a synthetic, non-production key — independent of provider-exclusivity', async () => {
    // Pre-seed a tenant-level SettingValue row DIRECTLY (bypassing the
    // admin write path, which would itself now reject any write beneath
    // an already-locked country_pack level — the same "pre-existing row"
    // technique Case B and the Platform-Default-lock test use).
    const users = causalityApp.get(UsersService);
    const creator = await users.createUser({
      email: `plt-lockcause-${Date.now()}@example.com`,
      password: 's3cure-passphrase',
      displayName: 'Lock Causality Seed',
    });
    await causalityPrisma.withAuthContext({ tenantId: tenantD }, (tx) =>
      tx.settingValue.create({
        data: {
          id: newId(),
          tenantId: tenantD,
          level: 'tenant',
          targetId: tenantD,
          settingKey: SYNTHETIC_LOCKED_KEY,
          value: { tier: 'tenant-preexisting' },
          createdBy: creator.id,
        },
      }),
    );

    const inspector = causalityApp.get(SettingsInspectorService);
    const result = await inspector.inspect(tenantD, {
      settingKey: SYNTHETIC_LOCKED_KEY,
    });

    expect(result.effective.effectiveSourceLevel).toBe('country_pack');
    expect(result.effective.isLocked).toBe(true);
    expect(result.effective.lockedAtLevel).toBe('country_pack');

    const tenantView = result.levels.find((l) => l.level === 'tenant');
    expect(tenantView?.configuredValue).toEqual({
      tier: 'tenant-preexisting',
    });
    expect(tenantView?.blockedByHigherLock).toBe(true);
    expect(tenantView?.isEffectiveSource).toBe(false);
  });
});
