/**
 * Cash-close policy administration write — P1G-1 migration 33.
 *
 * Authority: `docs/reports/claude/2026-08-30_P1G1_variance-settings-final-design-gate.md`
 * §9/§18/§19/§20, corrected/ratified by the "P1G-1 Cash-Close Policy
 * Ratification — 2026-08-30" register entry (R-1(a)..R-5, C-1, C-2).
 *
 * Creates exactly ONE new IMMUTABLE version row. There is no update, no
 * patch, no delete — a changed configuration is always a NEW row
 * (§5.3/§20). `ros_app` holds no UPDATE/DELETE grant on the table at all, so
 * this service could not mutate a prior version even if it tried.
 *
 * ── ID GENERATION (§18) ──────────────────────────────────────────────────
 * Server-generated ULID-as-UUID (`newId()`), the same convention
 * `BranchesService.create` uses. This is an ADMINISTRATIVE/server write, not
 * an FR-OFF-015 device-created entity — no offline terminal ever originates
 * a policy version, so there is no client permanent-id protocol to honour
 * here (unlike `CashMovementsService`, which the design gate does NOT apply
 * to this route). `Idempotency-Key` (mandatory, FR-API-020) is the retry
 * protection, exactly as `BranchesService`/`OrdersService` rely on for their
 * own server-id creates layered under the SAME global interceptor.
 *
 * ── CURRENCY (§17/§21, corrected at acceptance closure) ─────────────────────
 * NEVER accepted from the request body. Derived from Organisation's PUBLIC
 * `BRANCH_CURRENCY_QUERY` contract (`organisation/contract/branch-currency.query.ts`),
 * called with the SAME transaction this service is already inside — never a
 * second transaction, never a direct `tx.branch.*` query. `org.branches` is
 * Organisation-owned data (SRS §5.2.3: "a module MUST NOT query another
 * module's tables"); a direct Prisma query against it is a boundary
 * violation even when no PRIVATE Organisation TypeScript file is imported —
 * `module-boundaries.spec.ts` only proves import-boundary compliance, not
 * table-ownership compliance, and cannot see a bare Branch-model lookup at
 * all. The FIRST implementation of this service queried the Branch model
 * directly (following an existing, still-unresolved precedent in
 * `CashSessionsService.open`, out of this correction's fence); this was
 * corrected before FINAL ACCEPTANCE.
 *
 * ── "EFFECTIVE IMMEDIATELY" (§7) ─────────────────────────────────────────
 * When the caller omits `effectiveFrom`, the raw INSERT passes SQL `NULL`
 * for that column and `COALESCE(NULL::timestamptz, statement_timestamp())`
 * resolves it — DATABASE time, never `new Date()` in this process. When the
 * caller supplies an explicit `effectiveFrom`, it is used as given and the
 * DB's `ck_ccp_no_backdating` CHECK (`effective_from >= created_at`, with
 * `created_at` always DB-defaulted and un-writable by `ros_app`) is the
 * actual security boundary — an app-side "is this in the past" check below
 * is a friendly 400 only, never the enforcement.
 */

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { CashCountMode, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { BRANCH_CURRENCY_QUERY } from '../../organisation/contract';
import type { BranchCurrencyQuery } from '../../organisation/contract';

/**
 * `tx.$queryRaw` failures surface as `PrismaClientKnownRequestError` code
 * `P2010` ("raw query failed") — NOT the `P2002`/`P2003` shape Prisma's own
 * query builder produces. The underlying Postgres SQLSTATE is nested at
 * `err.meta.driverAdapterError.cause.originalCode` (empirically verified;
 * exact precedent: `governance/approvals/approvals.service.ts`'s
 * `isRowLevelSecurityViolation`). Matched defensively on BOTH the structured
 * `meta` shape and the message text, so a future driver-adapter upgrade that
 * changes the `meta` shape still degrades to a correct classification.
 */
function rawQueryOriginalCode(err: unknown): string | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const meta = err.meta as
    { driverAdapterError?: { cause?: { originalCode?: string } } } | undefined;
  return meta?.driverAdapterError?.cause?.originalCode;
}

/** SQLSTATE 23505 — the `uq_ccp_branch_effective_from` race (test 21). */
function isUniqueViolation(err: unknown): boolean {
  return (
    rawQueryOriginalCode(err) === '23505' ||
    (err instanceof Error &&
      /duplicate key value violates unique constraint/i.test(err.message))
  );
}

export interface CreateCashClosePolicyInput {
  readonly branchId: string;
  /** Absolute minor units, as an exact non-negative integer string. */
  readonly varianceToleranceMinorUnits: string;
  readonly varianceApprovalExpirySeconds: number;
  readonly countMode?: CashCountMode;
  /** ISO-8601. Omitted = effective immediately (DB time). */
  readonly effectiveFrom?: string;
}

export interface CashClosePolicyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly effectiveFrom: Date;
  readonly countMode: CashCountMode;
  readonly varianceToleranceMinorUnits: bigint;
  readonly currency: string;
  readonly varianceApprovalExpirySeconds: number;
  readonly createdBy: string;
  readonly createdAt: Date;
}

@Injectable()
export class CashClosePolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(BRANCH_CURRENCY_QUERY)
    private readonly branchCurrency: BranchCurrencyQuery,
  ) {}

  async create(
    tenantId: string,
    actorUserId: string,
    input: CreateCashClosePolicyInput,
  ): Promise<CashClosePolicyRecord> {
    const tolerance = this.parseTolerance(input.varianceToleranceMinorUnits);
    const expirySeconds = this.parseExpirySeconds(
      input.varianceApprovalExpirySeconds,
    );
    const countMode = input.countMode ?? 'blind';
    const effectiveFrom = this.parseEffectiveFrom(input.effectiveFrom);

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        // Organisation's PUBLIC contract, SAME transaction (SRS §5.5.1) —
        // never a direct `tx.branch.*` query (SRS §5.2.3). `null` covers
        // both an unknown id and a genuinely cross-tenant one (RLS makes
        // the row invisible regardless of the WHERE clause).
        const branch = await this.branchCurrency.find(tx, {
          tenantId,
          branchId: input.branchId,
        });
        if (!branch) {
          throw new NotFoundException('Branch not found.');
        }

        const id = newId();
        let inserted: CashClosePolicyRecord[];
        try {
          inserted = await tx.$queryRaw<CashClosePolicyRecord[]>`
            INSERT INTO "treasury"."cash_close_policies" (
              "id", "tenant_id", "branch_id", "effective_from", "count_mode",
              "variance_tolerance_minor_units", "currency",
              "variance_approval_expiry_seconds", "created_by"
            ) VALUES (
              ${id}::uuid, ${tenantId}::uuid, ${branch.branchId}::uuid,
              COALESCE(${effectiveFrom}::timestamptz, statement_timestamp()),
              ${countMode}::"treasury"."CashCountMode",
              ${tolerance}, ${branch.baseCurrency},
              ${expirySeconds}, ${actorUserId}::uuid
            )
            RETURNING
              "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
              "effective_from" AS "effectiveFrom", "count_mode" AS "countMode",
              "variance_tolerance_minor_units" AS "varianceToleranceMinorUnits",
              "currency",
              "variance_approval_expiry_seconds" AS "varianceApprovalExpirySeconds",
              "created_by" AS "createdBy", "created_at" AS "createdAt"
          `;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException(
              'A cash-close policy version with this exact effective time ' +
                'already exists for this branch.',
            );
          }
          throw error;
        }
        const policy = inserted[0];

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CASH_CLOSE_POLICY_VERSION_CREATED,
          entityType: AUDIT_ENTITY.CASH_CLOSE_POLICY,
          actorType: 'user',
          actorId: actorUserId,
          entityId: policy.id,
          metadata: {
            branchId: policy.branchId,
            effectiveFrom: policy.effectiveFrom.toISOString(),
            countMode: policy.countMode,
            varianceToleranceMinorUnits:
              policy.varianceToleranceMinorUnits.toString(),
            currency: policy.currency,
            varianceApprovalExpirySeconds: policy.varianceApprovalExpirySeconds,
          },
        });

        return policy;
      },
    );
  }

  /** Non-negative integer minor units (R-1(a) — zero tolerance is valid). */
  private parseTolerance(raw: string): bigint {
    if (!/^\d{1,18}$/.test(raw)) {
      throw new BadRequestException(
        'varianceToleranceMinorUnits must be a non-negative whole number of ' +
          'minor units expressed as a string, e.g. "500" for 5.00.',
      );
    }
    return BigInt(raw);
  }

  /** Positive integer seconds (R-4(a) — no default, must be > 0). */
  private parseExpirySeconds(raw: number): number {
    if (!Number.isInteger(raw) || raw <= 0) {
      throw new BadRequestException(
        'varianceApprovalExpirySeconds must be a positive whole number of seconds.',
      );
    }
    return raw;
  }

  /**
   * `undefined` -> SQL NULL (effective immediately, DB time). A supplied
   * value that is not a valid ISO instant is rejected at the edge; a
   * supplied value that IS a valid instant but lies in the past is also
   * rejected here as a friendly 400 — the actual security boundary is the
   * DB's `ck_ccp_no_backdating` CHECK (C-2), not this app-side comparison.
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
}
