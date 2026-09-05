import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { newId } from '../../../common/ids';
import { Prisma, Tenant, User } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { TAX_CLASS_PROVISIONER } from '../../localisation/tax/tax-class.port';
import type { TaxClassProvisioner } from '../../localisation/tax/tax-class.port';
import { AccessTokenService } from '../auth/access-token.service';
import { AuthTokens } from '../auth/auth.types';
import { AuthorizationSnapshotService } from '../authz/authorization-snapshot.service';
import {
  ALL_PERMISSION_CODES,
  ALL_PERMISSION_DEFS,
} from '../authz/permission-catalog';
import { PermissionsService } from '../authz/permissions.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  generateRefreshToken,
  hashRefreshToken,
} from '../sessions/refresh-token';
import { TenantSummary, toTenantSummary } from '../tenants/tenant.view';
import { toSafeUser } from '../users/user.view';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { RegisterTenantDto } from './dto/register-tenant.dto';

/**
 * SIGNUP-1 — no existing default-region/currency/timezone governance
 * mechanism exists in this repository (checked `src/config/env.validation.ts`
 * — no such env var), and the frontend signup form collects none of these.
 * This is a single hardcoded platform default (NOT per-tenant configurable),
 * matching the one fixture convention already used throughout
 * `seed-dev-data.ts` and the e2e suite. Documented as a known deviation —
 * revisit when multi-region/multi-country signup is actually required.
 * Also note: no country pack is actually ACTIVATED in a normal running
 * process today regardless of this code (pre-existing gap, see
 * `seed-dev-data.ts`'s own "Known limitation" section) — so tax classes will
 * not be provisioned for a signed-up tenant either way; this is not something
 * this slice can or needs to fix.
 */
const DEFAULT_SIGNUP_COUNTRY_PACK_CODE = 'EG';
const DEFAULT_SIGNUP_CURRENCY = 'EGP';
const DEFAULT_SIGNUP_TIMEZONE = 'Africa/Cairo';
const DEFAULT_BRANCH_NAME = 'Main';

export interface RegistrationOutcome {
  status: 'created';
  email: string;
  auth: AuthTokens;
  tenant: TenantSummary;
  membership: { membershipId: string; status: 'active' };
}

/** Kebab-case slug from a business name, with a short random suffix so a
 *  collision is astronomically unlikely without needing a DB round-trip per
 *  attempt; retried on the rare unique-constraint race regardless. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'tenant';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Branch code — immutable, embedded in offline order numbers (FR-POS-002),
 *  so it must fit `VarChar(16)` and use a safe character set. */
function branchCode(name: string): string {
  const code = name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 16);
  return code || 'MAIN';
}

/**
 * Tenant self-service signup (FR-PLT-020, SIGNUP-1). Public, atomic, and
 * production-safe on a schema-only database (no dependency on
 * `seed-dev-data.ts`).
 *
 * The whole operation is ONE `withAuthContext` transaction — every entity is
 * created with a pre-generated id (this repository's own convention — ids are
 * always caller-supplied, never DB-generated) so the tenant/user context can
 * be established before either row exists. `PrismaService.withAuthContext`
 * does not support nested interactive transactions, so this method
 * deliberately does NOT call `TenantsService.create` / `UsersService.
 * createUser` / `BranchesService.create` / `BrandsService.create` /
 * `RolesService` / `MembershipRolesService` (each opens its own transaction);
 * it replicates their exact write shape and audit calls directly against the
 * transaction client instead — the same pattern this repository already uses
 * for `BranchesService.create`'s own composition with `LocationsService.
 * register`.
 *
 * Starter menu/catalogue provisioning is DEFERRED for this slice (see the
 * SIGNUP-1 report) — a signed-up tenant has a working branch but no menu yet.
 */
@Injectable()
export class RegistrationsService {
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsService,
    private readonly permissions: PermissionsService,
    private readonly tokens: AccessTokenService,
    private readonly snapshots: AuthorizationSnapshotService,
    private readonly audit: AuditService,
    @Inject(TAX_CLASS_PROVISIONER)
    private readonly taxClasses: TaxClassProvisioner,
    config: ConfigService,
  ) {
    this.accessTtlSeconds = Math.floor(
      parseDurationMs(config.getOrThrow<string>('JWT_ACCESS_TTL')) / 1000,
    );
    this.refreshTtlMs = parseDurationMs(
      config.getOrThrow<string>('JWT_REFRESH_TTL'),
    );
  }

  async register(dto: RegisterTenantDto): Promise<RegistrationOutcome> {
    if (dto.roleKey !== 'owner') {
      throw new BadRequestException(
        'Self-service signup currently supports only roleKey "owner" (creating a ' +
          'new tenant). Joining an existing organisation in another role requires ' +
          'an administrator invitation flow, which is not implemented in this slice.',
      );
    }

    const email = UsersService.normalizeEmail(dto.email);
    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email already registered.');
    }

    // Idempotent, production-safe permission bootstrap — the permission
    // catalog is global/non-RLS-scoped (ADR 0001), so this is safe to run
    // ahead of the tenant-scoped transaction below. This is what lets the
    // first legitimate signup succeed on a schema-only database with no
    // dependency on `seed-dev-data.ts`.
    await this.permissions.upsertMany(ALL_PERMISSION_DEFS);

    const tenantId = newId();
    const userId = newId();
    const membershipId = newId();
    const roleId = newId();
    const brandId = newId();
    const branchId = newId();
    const membershipRoleId = newId();
    const locationId = newId();
    const sessionId = newId();

    const branchName = dto.scopeName?.trim() || DEFAULT_BRANCH_NAME;
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);

    let createdTenant: Tenant | null = null;
    let createdUser: User | null = null;

    try {
      await this.prisma.withAuthContext(
        { userId, tenantId },
        async (tx) => {
          const slug = await this.generateUniqueSlug(tx, dto.organisation);

          // User must exist before Tenant: `tenants.owner_user_id` carries an
          // FK to `users.id`.
          const user = await tx.user.create({
            data: {
              id: userId,
              email,
              displayName: dto.fullName,
              phone: dto.phone ?? null,
              preferredLocale: 'ar',
            },
          });
          createdUser = user;
          await this.credentials.createPasswordCredential(
            tx,
            userId,
            dto.password,
          );

          const tenant = await tx.tenant.create({
            data: {
              id: tenantId,
              slug,
              legalName: dto.organisation,
              defaultCurrency: DEFAULT_SIGNUP_CURRENCY,
              countryPackCode: DEFAULT_SIGNUP_COUNTRY_PACK_CODE,
              defaultLocale: 'ar',
              ownerUserId: userId,
              status: 'active',
            },
          });
          createdTenant = tenant;

          await tx.membership.create({
            data: { id: membershipId, userId, tenantId, status: 'active' },
          });

          await tx.role.create({
            data: {
              id: roleId,
              tenantId,
              name: 'Owner',
              description: 'Full access — created at self-service signup.',
              isSystem: false,
            },
          });
          for (const code of ALL_PERMISSION_CODES) {
            const permission = await tx.permission.findUnique({
              where: { code },
            });
            if (!permission) continue; // defensive: upsertMany ran just above
            await tx.rolePermission.upsert({
              where: {
                roleId_permissionId: { roleId, permissionId: permission.id },
              },
              update: {},
              create: { roleId, permissionId: permission.id },
            });
          }

          await tx.membershipRole.create({
            data: {
              id: membershipRoleId,
              tenantId,
              membershipId,
              roleId,
              scopeType: 'tenant',
              scopeBrandId: null,
              scopeBranchId: null,
              origin: 'explicit',
            },
          });
          await tx.membership.update({
            where: { id: membershipId },
            data: { authzEpoch: { increment: 1 } },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.ROLE_ASSIGNED,
            entityType: AUDIT_ENTITY.ROLE_ASSIGNMENT,
            actorType: 'user',
            actorId: userId,
            entityId: membershipRoleId,
            metadata: {
              membershipId,
              roleId,
              scopeType: 'tenant',
              scopeBrandId: null,
              scopeBranchId: null,
              origin: 'explicit',
            },
          });

          const brand = await tx.brand.create({
            data: { id: brandId, tenantId, name: dto.organisation },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRAND_CREATED,
            entityType: AUDIT_ENTITY.BRAND,
            actorType: 'user',
            actorId: userId,
            entityId: brandId,
            metadata: { name: brand.name },
          });

          const branch = await tx.branch.create({
            data: {
              id: branchId,
              tenantId,
              brandId,
              code: branchCode(branchName),
              name: branchName,
              timezone: DEFAULT_SIGNUP_TIMEZONE,
              baseCurrency: DEFAULT_SIGNUP_CURRENCY,
              countryCode: DEFAULT_SIGNUP_COUNTRY_PACK_CODE,
            },
          });
          // Mirrors `BranchesService.create`'s own invariant: a branch can
          // never exist without its `org.locations` registry row.
          await tx.location.createMany({
            data: [
              {
                id: locationId,
                tenantId,
                locationType: 'branch',
                refId: branchId,
                branchId,
                warehouseId: null,
                centralKitchenId: null,
              },
            ],
            skipDuplicates: true,
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.BRANCH_CREATED,
            entityType: AUDIT_ENTITY.BRANCH,
            actorType: 'user',
            actorId: userId,
            entityId: branchId,
            metadata: { code: branch.code, name: branch.name, brandId },
          });

          // Session created with its membership already bound — this is what
          // lets signup skip the ordinary login -> `/auth/tenant` round-trip.
          await tx.session.create({
            data: {
              id: sessionId,
              userId,
              membershipId,
              refreshTokenHash,
              expiresAt: new Date(Date.now() + this.refreshTtlMs),
              ipAddress: null,
              userAgent: null,
            },
          });

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.TENANT_CREATED,
            entityType: AUDIT_ENTITY.TENANT,
            actorType: 'user',
            actorId: userId,
            entityId: tenantId,
            metadata: {
              legalName: dto.organisation,
              slug,
              countryPackCode: DEFAULT_SIGNUP_COUNTRY_PACK_CODE,
            },
          });
        },
      );
    } catch (err) {
      // Unique-violation race on the email (or, in principle, the slug):
      // matches `UsersService.createUser`'s own second-layer catch. The whole
      // transaction rolled back — no tenant/user/branch row was left behind.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered.');
      }
      throw err;
    }

    // Best-effort, out-of-transaction — mirrors `TenantsService.create`'s own
    // existing non-atomic pattern for this specific side-effect: a tenant
    // must still be creatable when no signed pack is activated for its
    // jurisdiction (see the module docblock above).
    try {
      await this.taxClasses.provisionForTenant(
        tenantId,
        DEFAULT_SIGNUP_COUNTRY_PACK_CODE,
      );
    } catch {
      // best-effort only — menu items then carry no tax class, which is the
      // existing, correct, non-silent degradation.
    }

    const snapshot = await this.snapshots.build(userId, tenantId, membershipId);
    const accessToken = await this.tokens.sign({
      sub: userId,
      sid: sessionId,
      tid: tenantId,
      mid: membershipId,
      scp: [...snapshot.scp],
      pbr: snapshot.pbr,
      epo: snapshot.epo,
    });

    await this.audit.emit({
      tenantId,
      action: AUDIT_ACTION.TENANT_SELECTED,
      entityType: AUDIT_ENTITY.TENANT,
      actorType: 'user',
      actorId: userId,
      entityId: tenantId,
      metadata: { membershipId, sessionId, viaSignup: true },
    });

    if (!createdUser || !createdTenant) {
      // Unreachable in practice (the transaction above either populates both
      // or throws), but keeps the return type honest without a non-null cast.
      throw new ConflictException('Signup failed unexpectedly.');
    }

    return {
      status: 'created',
      email,
      auth: {
        tokenType: 'Bearer',
        accessToken,
        refreshToken,
        expiresIn: this.accessTtlSeconds,
        user: toSafeUser(createdUser),
      },
      tenant: toTenantSummary(createdTenant),
      membership: { membershipId, status: 'active' },
    };
  }

  /** Server-generated, unique tenant slug — no existing generator in this
   *  repository (every current caller supplies an already-unique string). */
  private async generateUniqueSlug(
    tx: Prisma.TransactionClient,
    name: string,
  ): Promise<string> {
    const base = slugify(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const existing = await tx.tenant.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    return `${base}-${randomSuffix()}-${randomSuffix()}`;
  }
}
