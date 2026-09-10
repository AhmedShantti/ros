/**
 * ServiceChargePolicy administration — P2D (ratified P2D-R1).
 *
 * Creates exactly ONE new IMMUTABLE version row per call. There is no
 * update, no patch — a changed configuration is always a NEW row
 * (P2A-R1 clause 12); `ros_app` holds no UPDATE grant on the table at all,
 * so this service could not mutate a prior version even if it tried.
 * Cancellation removes a still-FUTURE version only (P2A-R1 clause 11); the
 * DB's RLS `DELETE` predicate — not this service's own pre-check — is the
 * actual enforcement boundary.
 */

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  Prisma,
  ServiceChargePolicyLevel,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import {
  BRANCH_BRAND_QUERY,
  ORGANISATION_PERMISSIONS,
} from '../../organisation/contract';
import type { BranchBrandQuery } from '../../organisation/contract';
import { SCOPE_AUTHORIZATION } from '../../identity/contract';
import type {
  ScopeAuthorizationActor,
  ScopeAuthorizationPort,
  TargetScope,
} from '../../identity/contract';
import {
  ResolvedServiceChargePolicyVersion,
  ServiceChargePolicyResolver,
} from './service-charge-policy.resolver';
import {
  ServiceChargePolicyRule,
  ServiceChargePolicyRuleValidationError,
  parseServiceChargePolicyRules,
} from './service-charge-policy-rules';

/**
 * `tx.$queryRaw` failures surface as `PrismaClientKnownRequestError` code
 * `P2010` — the exact `CashClosePolicyService`/`governance/approvals`
 * precedent for classifying a raw-query unique-constraint violation.
 */
function rawQueryOriginalCode(err: unknown): string | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const meta = err.meta as
    { driverAdapterError?: { cause?: { originalCode?: string } } } | undefined;
  return meta?.driverAdapterError?.cause?.originalCode;
}

/** SQLSTATE 23505 — the `uq_scp_scope_effective_from` race. */
function isUniqueViolation(err: unknown): boolean {
  return (
    rawQueryOriginalCode(err) === '23505' ||
    (err instanceof Error &&
      /duplicate key value violates unique constraint/i.test(err.message))
  );
}

export interface CreateServiceChargePolicyInput {
  readonly level: ServiceChargePolicyLevel;
  readonly targetId: string;
  /** Raw, unvalidated — parsed/validated by `parseServiceChargePolicyRules`. */
  readonly rules: unknown;
  readonly locked?: boolean;
  /** ISO-8601. Omitted = effective immediately (DB time). */
  readonly effectiveFrom?: string;
}

export interface ServiceChargePolicyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly level: ServiceChargePolicyLevel;
  readonly targetId: string;
  readonly rules: readonly ServiceChargePolicyRule[];
  readonly locked: boolean;
  readonly effectiveFrom: Date;
  readonly createdBy: string;
  readonly createdAt: Date;
}

interface InsertedRow {
  readonly id: string;
  readonly tenantId: string;
  readonly level: ServiceChargePolicyLevel;
  readonly targetId: string;
  readonly rules: unknown;
  readonly locked: boolean;
  readonly effectiveFrom: Date;
  readonly createdBy: string;
  readonly createdAt: Date;
}

@Injectable()
export class ServiceChargePolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
    @Inject(SCOPE_AUTHORIZATION)
    private readonly scopeAuthorization: ScopeAuthorizationPort,
    private readonly resolver: ServiceChargePolicyResolver,
  ) {}

  async create(
    tenantId: string,
    actorUserId: string,
    input: CreateServiceChargePolicyInput,
  ): Promise<ServiceChargePolicyRecord> {
    const rules = this.parseRules(input.rules);
    const locked = input.locked ?? false;
    const effectiveFrom = this.parseEffectiveFrom(input.effectiveFrom);

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        await this.validateTarget(tx, tenantId, input.level, input.targetId);

        const id = newId();
        let inserted: InsertedRow[];
        try {
          inserted = await tx.$queryRaw<InsertedRow[]>`
            INSERT INTO "sales"."service_charge_policies" (
              "id", "tenant_id", "level", "target_id", "rules", "locked",
              "effective_from", "created_by"
            ) VALUES (
              ${id}::uuid, ${tenantId}::uuid,
              ${input.level}::"sales"."ServiceChargePolicyLevel",
              ${input.targetId}::uuid, ${JSON.stringify(rules)}::jsonb,
              ${locked},
              COALESCE(${effectiveFrom}::timestamptz, statement_timestamp()),
              ${actorUserId}::uuid
            )
            RETURNING
              "id", "tenant_id" AS "tenantId", "level",
              "target_id" AS "targetId", "rules", "locked",
              "effective_from" AS "effectiveFrom",
              "created_by" AS "createdBy", "created_at" AS "createdAt"
          `;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException(
              'A service-charge policy version with this exact effective ' +
                'time already exists for this scope.',
            );
          }
          throw error;
        }
        const policy = inserted[0];

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.SERVICE_CHARGE_POLICY_VERSION_CREATED,
          entityType: AUDIT_ENTITY.SERVICE_CHARGE_POLICY,
          actorType: 'user',
          actorId: actorUserId,
          entityId: policy.id,
          metadata: {
            level: policy.level,
            targetId: policy.targetId,
            locked: policy.locked,
            effectiveFrom: policy.effectiveFrom.toISOString(),
            ruleCount: rules.length,
          },
        });

        return this.toRecord(policy, rules);
      },
    );
  }

  /**
   * P2A-R1 clause 11 — cancel a still-FUTURE version. Authorization is
   * based on the ROW's OWN scope (never the client's claim about it):
   * `tenant`/`brand` require `TENANT_MANAGE`, `branch` requires
   * `BRANCH_MANAGE` (P2D-R1 clause 11), checked via `ScopeAuthorizationPort`
   * — the published "second, in-transaction authorization decision the
   * route-level guard cannot express" primitive (`identity/contract`),
   * exactly `DiscountsService`'s own precedent for a permission that
   * depends on data only knowable after a read.
   */
  async cancel(
    tenantId: string,
    actorUserId: string,
    auth: ScopeAuthorizationActor,
    versionId: string,
  ): Promise<void> {
    await this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const existing = await tx.serviceChargePolicy.findUnique({
          where: { id: versionId },
          select: {
            id: true,
            level: true,
            targetId: true,
            effectiveFrom: true,
          },
        });
        // Cross-tenant is invisible under RLS -> 404, never 403 (never an
        // existence oracle).
        if (!existing) {
          throw new NotFoundException(
            'Service-charge policy version not found.',
          );
        }

        const target: TargetScope =
          existing.level === 'branch'
            ? { type: 'branch', branchId: existing.targetId }
            : existing.level === 'brand'
              ? { type: 'brand', brandId: existing.targetId }
              : { type: 'tenant' };
        const requiredCode =
          existing.level === 'branch'
            ? ORGANISATION_PERMISSIONS.BRANCH_MANAGE
            : ORGANISATION_PERMISSIONS.TENANT_MANAGE;
        await this.scopeAuthorization.assertAuthorized(
          auth,
          { codes: [requiredCode], mode: 'all' },
          target,
          tx,
        );

        // Friendly pre-check ONLY — the RLS DELETE predicate
        // (`effective_from > statement_timestamp()`) is the real boundary,
        // re-evaluated fresh at the DELETE below.
        if (existing.effectiveFrom.getTime() <= Date.now()) {
          throw new ConflictException(
            'That service-charge policy version is already effective and ' +
              'can no longer be cancelled.',
          );
        }

        const deleted = await tx.$queryRaw<
          { id: string; level: string; targetId: string }[]
        >`
          DELETE FROM "sales"."service_charge_policies"
          WHERE "id" = ${versionId}::uuid AND "tenant_id" = ${tenantId}::uuid
          RETURNING "id", "level", "target_id" AS "targetId"
        `;
        if (deleted.length === 0) {
          // Race: became effective between the pre-check and the DELETE —
          // the RLS predicate made the DELETE affect zero rows. Never
          // reported as a false success, and no audit event is written.
          throw new ConflictException(
            'That service-charge policy version could not be cancelled ' +
              '(it may have just become effective).',
          );
        }

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.SERVICE_CHARGE_POLICY_VERSION_CANCELLED,
          entityType: AUDIT_ENTITY.SERVICE_CHARGE_POLICY,
          actorType: 'user',
          actorId: actorUserId,
          entityId: versionId,
          metadata: { level: deleted[0].level, targetId: deleted[0].targetId },
        });
      },
    );
  }

  /**
   * The currently-resolved (tenant -> brand -> branch) version for a
   * hierarchy context, or `null` if nothing is configured anywhere in
   * scope — GOLDEN-PATH read, mirrors `CashClosePolicyService.getCurrent`.
   * `brandId`/`branchId` are validated (existence, tenant ownership,
   * hierarchy consistency) exactly like the write paths.
   */
  async getCurrent(
    tenantId: string,
    actorUserId: string,
    scope: { brandId?: string; branchId?: string },
  ): Promise<ResolvedServiceChargePolicyVersion | null> {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const { brandId, branchId } = await this.deriveHierarchyContext(
          tx,
          scope,
        );
        const breakdown = await this.resolver.resolve(tx, {
          tenantId,
          brandId,
          branchId,
          at: new Date(),
        });
        return breakdown.winner;
      },
    );
  }

  /**
   * All versions for ONE exact (level, targetId) scope, newest first —
   * the minimum surface needed to make cancellation usable: `resolve`
   * only ever shows the CURRENTLY winning version, so a future-scheduled
   * version (not yet effective) would otherwise be undiscoverable, and an
   * admin could never learn the id a cancel call needs. Exposes only the
   * same safe configuration facts `resolve` already does.
   */
  async listVersions(
    tenantId: string,
    actorUserId: string,
    level: ServiceChargePolicyLevel,
    targetId: string,
  ): Promise<readonly ServiceChargePolicyRecord[]> {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        await this.validateTarget(tx, tenantId, level, targetId);
        const rows = await tx.serviceChargePolicy.findMany({
          where: { tenantId, level, targetId },
          orderBy: { effectiveFrom: 'desc' },
        });
        return rows.map((row) =>
          this.toRecord(row, parseServiceChargePolicyRules(row.rules)),
        );
      },
    );
  }

  private parseRules(raw: unknown): readonly ServiceChargePolicyRule[] {
    try {
      return parseServiceChargePolicyRules(raw);
    } catch (error) {
      if (error instanceof ServiceChargePolicyRuleValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * `undefined` -> SQL NULL (effective immediately, DB time). A supplied
   * value that is not a valid ISO instant is rejected at the edge; a
   * supplied value that IS a valid instant but lies in the past is also
   * rejected here as a friendly 400 — the actual security boundary is the
   * DB's `ck_scp_no_backdating` CHECK, not this app-side comparison.
   */
  private parseEffectiveFrom(raw: string | undefined): Date | null {
    if (raw === undefined) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        'effectiveFrom must be a valid ISO-8601 date-time.',
      );
    }
    if (parsed.getTime() < Date.now()) {
      throw new BadRequestException(
        'effectiveFrom must not be in the past. Omit it to activate ' +
          'immediately, or supply a present/future instant.',
      );
    }
    return parsed;
  }

  /**
   * FR-PLT-025-adjacent target validation, reusing the PUBLISHED
   * Organisation contract (`BRANCH_BRAND_QUERY`) — never a private
   * `SettingsScopeService`/Organisation-internal import. Fail-closed 404
   * for a foreign tenant / unknown brand / unknown branch, identical
   * posture to `SettingsAdminService.validateTarget`.
   */
  private async validateTarget(
    tx: Prisma.TransactionClient,
    tenantId: string,
    level: ServiceChargePolicyLevel,
    targetId: string,
  ): Promise<void> {
    if (level === 'tenant') {
      if (targetId !== tenantId) {
        throw new NotFoundException(
          "targetId must be the caller's own tenant.",
        );
      }
      return;
    }
    if (level === 'brand') {
      const visible = await this.branchBrand.brandIsVisible(tx, targetId);
      if (!visible) throw new NotFoundException('Brand not found.');
      return;
    }
    const facts = await this.branchBrand.findBranchAuthorizationFacts(
      tx,
      targetId,
    );
    if (!facts) throw new NotFoundException('Branch not found.');
  }

  /**
   * Derive/validate a `{ brandId, branchId }` hierarchy context for a READ
   * request: a supplied `branchId` derives its own `brandId` (and a
   * caller-supplied `brandId` that contradicts it is rejected, never
   * silently overwritten — the `SettingsScopeService.deriveScope`
   * precedent) — mirrors §5's "branch/brand hierarchy mismatch" fail-closed
   * requirement.
   */
  private async deriveHierarchyContext(
    tx: Prisma.TransactionClient,
    scope: { brandId?: string; branchId?: string },
  ): Promise<{ brandId: string | null; branchId: string | null }> {
    if (scope.branchId) {
      const facts = await this.branchBrand.findBranchAuthorizationFacts(
        tx,
        scope.branchId,
      );
      if (!facts) throw new NotFoundException('Branch not found.');
      if (scope.brandId && scope.brandId !== facts.brandId) {
        throw new NotFoundException(
          'That branch does not belong to the supplied brand.',
        );
      }
      return { brandId: facts.brandId, branchId: scope.branchId };
    }
    if (scope.brandId) {
      const visible = await this.branchBrand.brandIsVisible(tx, scope.brandId);
      if (!visible) throw new NotFoundException('Brand not found.');
      return { brandId: scope.brandId, branchId: null };
    }
    return { brandId: null, branchId: null };
  }

  private toRecord(
    row: {
      id: string;
      tenantId: string;
      level: ServiceChargePolicyLevel;
      targetId: string;
      locked: boolean;
      effectiveFrom: Date;
      createdBy: string;
      createdAt: Date;
    },
    rules: readonly ServiceChargePolicyRule[],
  ): ServiceChargePolicyRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      level: row.level,
      targetId: row.targetId,
      rules,
      locked: row.locked,
      effectiveFrom: row.effectiveFrom,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }
}
