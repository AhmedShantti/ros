/**
 * Treasury-PRIVATE cash-close policy resolver — P1G-1 migration 33.
 *
 * This is NOT a `contract/` export. It is not a cross-module public
 * interface, because the only consumer inside this slice is Treasury itself
 * (design gate §9.1: "Does Treasury query another module's table? No.").
 * A future CashSession Close (P1G-1) is expected to live in Treasury too and
 * will call this directly; if a genuinely different module ever needs it,
 * that is the point to publish a `contract/` entry, not before.
 *
 * ── R-3(a) — WHICH VERSION GOVERNS A SESSION ────────────────────────────────
 * The caller supplies `asOf`. The ratified rule is that a CashSession is
 * governed by the version effective at the session's OPEN time
 * (`cash_session.opened_at`), resolved lazily — this resolver has no opinion
 * on what `asOf` should be; it only answers "what was effective at this
 * instant for this branch", which is what makes it usable for both R-3(a)'s
 * historical resolution and the write route's "is there already coverage"
 * checks.
 *
 * ── DETERMINISM ──────────────────────────────────────────────────────────
 * `UNIQUE (tenant_id, branch_id, effective_from)` makes ties structurally
 * impossible, so "latest effective_from <= asOf" always has at most one
 * answer for a given `asOf`. Resolving the SAME historical `asOf` twice, from
 * before and after a later version is inserted, MUST return the identical
 * row (FR-PLT-028's "never the current version", taken as the stricter
 * posture per the design gate §5.2) — the query's `effective_from <= asOf`
 * predicate is what guarantees this: a later row's `effective_from` is by
 * construction later than `asOf` and is excluded.
 *
 * ── FR-POS-095 DEFAULT ───────────────────────────────────────────────────
 * `resolveCountMode` never fails closed — SRS states the default is `blind`,
 * so an unconfigured branch reads as `blind`, never as an error. Only the
 * tolerance-dependent `resolve()` returns `null` on no coverage (R-5).
 */

import { Injectable } from '@nestjs/common';
import { CashCountMode, Prisma } from '../../../generated/prisma/client';

export interface ResolveCashClosePolicyInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly asOf: Date;
}

export interface ResolvedCashClosePolicy {
  readonly policyVersionId: string;
  readonly branchId: string;
  readonly effectiveFrom: Date;
  readonly countMode: CashCountMode;
  /** R-1(a): absolute money, minor units. Never a JS `number`. */
  readonly varianceToleranceMinorUnits: bigint;
  readonly currency: string;
  readonly varianceApprovalExpirySeconds: number;
  readonly createdAt: Date;
}

interface ResolvedRow {
  readonly id: string;
  readonly branchId: string;
  readonly effectiveFrom: Date;
  readonly countMode: CashCountMode;
  readonly varianceToleranceMinorUnits: bigint;
  readonly currency: string;
  readonly varianceApprovalExpirySeconds: number;
  readonly createdAt: Date;
}

@Injectable()
export class CashClosePolicyResolver {
  /**
   * Latest version effective at or before `asOf`, for one branch. `null`
   * when the branch has NO version effective at that instant — the
   * caller (a future CashSession Close) MUST fail closed on `null` rather
   * than assume a tolerance (R-5). Never called outside an existing
   * `PrismaService.withAuthContext` scope — `tx`-first, per this
   * repository's universal transactional convention.
   */
  async resolve(
    tx: Prisma.TransactionClient,
    input: ResolveCashClosePolicyInput,
  ): Promise<ResolvedCashClosePolicy | null> {
    const row = await this.selectLatest(tx, input);
    if (!row) return null;
    return {
      policyVersionId: row.id,
      branchId: row.branchId,
      effectiveFrom: row.effectiveFrom,
      countMode: row.countMode,
      varianceToleranceMinorUnits: row.varianceToleranceMinorUnits,
      currency: row.currency,
      varianceApprovalExpirySeconds: row.varianceApprovalExpirySeconds,
      createdAt: row.createdAt,
    };
  }

  /**
   * FR-POS-095 [M] — the count-mode half never fails closed. No applicable
   * policy → `blind`, the SOURCE-STATED default, not an error.
   */
  async resolveCountMode(
    tx: Prisma.TransactionClient,
    input: ResolveCashClosePolicyInput,
  ): Promise<CashCountMode> {
    const row = await this.selectLatest(tx, input);
    return row?.countMode ?? 'blind';
  }

  private async selectLatest(
    tx: Prisma.TransactionClient,
    input: ResolveCashClosePolicyInput,
  ): Promise<ResolvedRow | null> {
    const rows = await tx.$queryRaw<ResolvedRow[]>`
      SELECT
        "id",
        "branch_id" AS "branchId",
        "effective_from" AS "effectiveFrom",
        "count_mode" AS "countMode",
        "variance_tolerance_minor_units" AS "varianceToleranceMinorUnits",
        "currency",
        "variance_approval_expiry_seconds" AS "varianceApprovalExpirySeconds",
        "created_at" AS "createdAt"
      FROM "treasury"."cash_close_policies"
      WHERE "tenant_id" = ${input.tenantId}::uuid
        AND "branch_id" = ${input.branchId}::uuid
        AND "effective_from" <= ${input.asOf}::timestamptz
      ORDER BY "effective_from" DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
}
