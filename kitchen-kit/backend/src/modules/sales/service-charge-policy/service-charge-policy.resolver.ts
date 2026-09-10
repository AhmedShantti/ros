/**
 * ServiceChargePolicy point-in-time resolver — P2D (ratified P2D-R1).
 *
 * NOT `platform-settings`' generic `SettingsResolverService` — a separate,
 * Sales-owned, three-level (tenant/brand/branch) resolver over this
 * module's own immutable table, never `platform.setting_values`. The
 * precedence/lock ALGORITHM mirrors `SettingsResolverService.computeEffective`
 * structurally (P2A-R1 clause 9: "walked high-to-low exactly as
 * SettingsResolverService.computeEffective already walks"), but is a
 * SEPARATE implementation over a genuinely different data shape/source —
 * duplicating the ~10-line walk is more honest than forcing a shared
 * abstraction across two different tables (P2C2 §9).
 *
 * ── R-3(a)-SHAPED GOVERNING-INSTANT CONTRACT ────────────────────────────────
 * The caller supplies `at`. This resolver has no opinion on what `at`
 * should be — it only answers "what was effective at this instant for this
 * hierarchy", exactly the `CashClosePolicyResolver` precedent. `Order`
 * pinning (`OrdersService.create`) is the one caller that must use
 * `Order.openedAt` specifically (P2D-R1 clause 7) — that rule lives at the
 * CALL SITE, not here.
 */

import { Injectable } from '@nestjs/common';
import {
  Prisma,
  ServiceChargePolicyLevel,
} from '../../../generated/prisma/client';
import {
  ServiceChargePolicyRule,
  parseServiceChargePolicyRules,
} from './service-charge-policy-rules';

export interface ResolveServiceChargePolicyInput {
  readonly tenantId: string;
  /** `null` when no brand is in scope for this request. */
  readonly brandId: string | null;
  /** `null` when no branch is in scope for this request. */
  readonly branchId: string | null;
  readonly at: Date;
}

/** One resolved, immutable policy VERSION — never the whole rule-matching result. */
export interface ResolvedServiceChargePolicyVersion {
  readonly id: string;
  readonly level: ServiceChargePolicyLevel;
  readonly targetId: string;
  readonly rules: readonly ServiceChargePolicyRule[];
  readonly locked: boolean;
  readonly effectiveFrom: Date;
  readonly createdAt: Date;
}

/**
 * One level's raw fetch result, before the precedence/lock walk —
 * `SettingLevelEntry`'s shape, narrowed to the three real levels this
 * table has.
 */
export interface ServiceChargePolicyBreakdownEntry {
  readonly level: ServiceChargePolicyLevel;
  /** `false` when the caller did not supply an id deep enough to reach this level (no brandId/branchId in scope). */
  readonly eligible: boolean;
  readonly targetId: string | null;
  /**
   * `null` when unconfigured at this level at `at` — NEVER conflated with
   * a genuinely configured version whose `rules` happens to be `[]`
   * (P2D-R1 clause 3: an empty rule-set IS a configured version).
   */
  readonly version: ResolvedServiceChargePolicyVersion | null;
}

export interface ServiceChargePolicyBreakdown {
  readonly entries: readonly ServiceChargePolicyBreakdownEntry[];
  /** The winning version, or `null` if nothing is configured anywhere in scope. */
  readonly winner: ResolvedServiceChargePolicyVersion | null;
}

interface ResolvedRow {
  readonly id: string;
  readonly level: ServiceChargePolicyLevel;
  readonly targetId: string;
  readonly rules: unknown;
  readonly locked: boolean;
  readonly effectiveFrom: Date;
  readonly createdAt: Date;
}

/**
 * PURE — the precedence/lock walk, decoupled from all I/O so it can be
 * unit-tested directly against synthetic entries (no database, no wall
 * clock). Mirrors `SettingsResolverService.computeEffective`'s own walk:
 * the first eligible, CONFIGURED version becomes (so far) the winner; a
 * lower eligible, configured version overrides it; the walk STOPS the
 * instant it passes a configured, LOCKED version — nothing lower may then
 * win.
 */
export function computeWinningVersion(
  entries: readonly ServiceChargePolicyBreakdownEntry[],
): ResolvedServiceChargePolicyVersion | null {
  let winner: ResolvedServiceChargePolicyVersion | null = null;
  for (const entry of entries) {
    if (!entry.eligible || entry.version === null) continue;
    winner = entry.version;
    if (entry.version.locked) break;
  }
  return winner;
}

@Injectable()
export class ServiceChargePolicyResolver {
  /**
   * Resolve the full tenant -> brand -> branch breakdown for one hierarchy
   * context at one instant. Never called outside an existing
   * `PrismaService.withAuthContext` scope — `tx`-first, this repository's
   * universal transactional convention.
   */
  async resolve(
    tx: Prisma.TransactionClient,
    input: ResolveServiceChargePolicyInput,
  ): Promise<ServiceChargePolicyBreakdown> {
    const entries: ServiceChargePolicyBreakdownEntry[] = [
      await this.fetchLevel(
        tx,
        'tenant',
        input.tenantId,
        input.tenantId,
        input.at,
      ),
      input.brandId
        ? await this.fetchLevel(
            tx,
            'brand',
            input.tenantId,
            input.brandId,
            input.at,
          )
        : { level: 'brand', eligible: false, targetId: null, version: null },
      input.branchId
        ? await this.fetchLevel(
            tx,
            'branch',
            input.tenantId,
            input.branchId,
            input.at,
          )
        : { level: 'branch', eligible: false, targetId: null, version: null },
    ];
    return { entries, winner: computeWinningVersion(entries) };
  }

  private async fetchLevel(
    tx: Prisma.TransactionClient,
    level: ServiceChargePolicyLevel,
    tenantId: string,
    targetId: string,
    at: Date,
  ): Promise<ServiceChargePolicyBreakdownEntry> {
    const version = await this.selectLatest(tx, {
      tenantId,
      level,
      targetId,
      at,
    });
    return { level, eligible: true, targetId, version };
  }

  /**
   * Latest version effective at or before `at`, for one (level, target).
   * `null` when nothing is configured there at that instant — the caller
   * (this class's own `resolve`, or a future P2E consumer) must fail
   * closed rather than assume a value.
   */
  private async selectLatest(
    tx: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly level: ServiceChargePolicyLevel;
      readonly targetId: string;
      readonly at: Date;
    },
  ): Promise<ResolvedServiceChargePolicyVersion | null> {
    const rows = await tx.$queryRaw<ResolvedRow[]>`
      SELECT
        "id",
        "level",
        "target_id" AS "targetId",
        "rules",
        "locked",
        "effective_from" AS "effectiveFrom",
        "created_at" AS "createdAt"
      FROM "sales"."service_charge_policies"
      WHERE "tenant_id" = ${input.tenantId}::uuid
        AND "level" = ${input.level}::"sales"."ServiceChargePolicyLevel"
        AND "target_id" = ${input.targetId}::uuid
        AND "effective_from" <= ${input.at}::timestamptz
      ORDER BY "effective_from" DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      level: row.level,
      targetId: row.targetId,
      rules: parseServiceChargePolicyRules(row.rules),
      locked: row.locked,
      effectiveFrom: row.effectiveFrom,
      createdAt: row.createdAt,
    };
  }
}
