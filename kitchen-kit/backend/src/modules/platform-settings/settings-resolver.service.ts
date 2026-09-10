import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { COUNTRY_PACK_SETTING_FACT_QUERY } from '../localisation/contract';
import type { CountryPackSettingFactQuery } from '../localisation/contract';
import { BRANCH_JURISDICTION_QUERY } from '../organisation/contract';
import type { BranchJurisdictionQuery } from '../organisation/contract';
import { SettingsScopeService } from './settings-scope.service';
import { assertValidSettingKey } from './settings-key.util';
import {
  SETTING_HIERARCHY_LEVELS,
  type EffectiveSettingResult,
  type RequestedSettingsScope,
  type ResolvedSettingsScope,
  type SettingHierarchyLevel,
  type SettingLevelBreakdown,
  type SettingLevelEntry,
  type StorableSettingLevel,
} from './settings-hierarchy.types';

export interface ResolveSettingInput extends Omit<
  RequestedSettingsScope,
  'tenantId'
> {
  readonly settingKey: string;
  /** Defaults to `now()`. Exposed for deterministic tests only. */
  readonly at?: Date;
}

function targetIdForStorableLevel(
  level: StorableSettingLevel,
  scope: ResolvedSettingsScope,
): string | null {
  switch (level) {
    case 'tenant':
      return scope.tenantId;
    case 'brand':
      return scope.brandId;
    case 'branch':
      return scope.branchId;
    case 'terminal':
      return scope.terminalId;
  }
}

/**
 * FR-PLT-025/026 — THE authoritative hierarchical settings resolver.
 *
 * "Create one authoritative resolver ... Do not make callers manually
 * reproduce precedence logic." This is that resolver: every other consumer
 * (the HTTP controller, the settings inspector, and the published
 * `EFFECTIVE_SETTING_QUERY` contract other modules use) calls into
 * `resolveEffective`/`fetchLevelBreakdown` rather than re-implementing the
 * SRS §6.4 precedence/FR-PLT-026 lock walk.
 */
@Injectable()
export class SettingsResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: SettingsScopeService,
    @Inject(COUNTRY_PACK_SETTING_FACT_QUERY)
    private readonly countryPackFacts: CountryPackSettingFactQuery,
    @Inject(BRANCH_JURISDICTION_QUERY)
    private readonly branchJurisdiction: BranchJurisdictionQuery,
  ) {}

  /** The FR-PLT-025 entrypoint: the single winning value, with lock metadata. */
  async resolveEffective(
    tenantId: string,
    input: ResolveSettingInput,
  ): Promise<EffectiveSettingResult> {
    const breakdown = await this.fetchLevelBreakdown(tenantId, input);
    return breakdown.effective;
  }

  /**
   * Every level's raw fetch result PLUS the computed effective value —
   * shared by `resolveEffective` and `SettingsInspectorService` so the
   * precedence/lock algorithm exists in exactly one place.
   */
  async fetchLevelBreakdown(
    tenantId: string,
    input: ResolveSettingInput,
  ): Promise<SettingLevelBreakdown> {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.fetchLevelBreakdownInTx(tx, tenantId, input),
    );
  }

  /**
   * Same as `fetchLevelBreakdown`, but inside a transaction the CALLER
   * already opened — the SRS §5.5.1 same-transaction pattern every other
   * DB-backed cross-module contract in this repository uses (e.g.
   * `BranchCurrencyQuery.find(tx, ...)`), for `EFFECTIVE_SETTING_QUERY`
   * consumers that need this resolution inside their own write transaction.
   * `PrismaService.withAuthContext` does not support nesting, so a consumer
   * already inside its own `withAuthContext({ tenantId })` MUST use this
   * method, never `fetchLevelBreakdown`/`resolveEffective`.
   */
  async fetchLevelBreakdownInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: ResolveSettingInput,
  ): Promise<SettingLevelBreakdown> {
    assertValidSettingKey(input.settingKey);
    const at = input.at ?? new Date();
    const scope = await this.scope.deriveScope(tx, tenantId, {
      brandId: input.brandId,
      branchId: input.branchId,
      terminalId: input.terminalId,
    });

    const entries: SettingLevelEntry[] = [];
    for (const level of SETTING_HIERARCHY_LEVELS) {
      entries.push(
        await this.fetchLevelEntry(tx, level, scope, input.settingKey, at),
      );
    }

    const effective = this.computeEffective(input.settingKey, scope, entries);
    return { settingKey: input.settingKey, scope, entries, effective };
  }

  private async fetchLevelEntry(
    tx: Prisma.TransactionClient,
    level: SettingHierarchyLevel,
    scope: ResolvedSettingsScope,
    settingKey: string,
    at: Date,
  ): Promise<SettingLevelEntry> {
    if (level === 'country_pack') {
      return this.fetchCountryPackEntry(tx, scope, settingKey, at);
    }

    // P2C1-R1: a PROVIDER-EXCLUSIVE key (e.g. `payments.cash_rounding_policy`)
    // is never eligible at any level OTHER than `country_pack` — Country
    // Pack is its sole authority (FR-POS-063), regardless of whether the
    // active pack declares a `settingsLocks` entry for it. This is a
    // STATIC, structural fact about the key itself, checked BEFORE any
    // database read and applied uniformly to `platform` and every storable
    // level below — never fabricated as `locked` (that stays sourced
    // exclusively from `country_pack`'s own entry, via `fetchCountryPackEntry`,
    // untouched by this check), and never a branch inside `computeEffective`
    // (unmodified — see that method's own docblock).
    if (this.countryPackFacts.isProviderExclusive(settingKey)) {
      return this.ineligibleEntry(level);
    }

    if (level === 'platform') {
      const row = await tx.platformDefaultSetting.findUnique({
        where: { settingKey },
        select: { value: true, locked: true },
      });
      return {
        level,
        eligible: true,
        targetId: null,
        hasConfiguredValue: row !== null,
        configuredValue: row?.value ?? null,
        locked: row?.locked ?? false,
      };
    }

    const targetId = targetIdForStorableLevel(level, scope);
    if (targetId === null) {
      return this.ineligibleEntry(level);
    }

    const row = await tx.settingValue.findUnique({
      where: {
        tenantId_level_targetId_settingKey: {
          tenantId: scope.tenantId,
          level: level,
          targetId,
          settingKey,
        },
      },
      select: { value: true, locked: true },
    });
    return {
      level,
      eligible: true,
      targetId,
      hasConfiguredValue: row !== null,
      configuredValue: row?.value ?? null,
      locked: row?.locked ?? false,
    };
  }

  /** The shared "not in play for this key" shape — an absent-id level, a
   * key country_pack has no representation for, and (P2C1-R1) a
   * provider-exclusive key at any level below `country_pack` all read
   * identically: eligible: false, nothing configured, never locked. */
  private ineligibleEntry(level: SettingHierarchyLevel): SettingLevelEntry {
    return {
      level,
      eligible: false,
      targetId: null,
      hasConfiguredValue: false,
      configuredValue: null,
      locked: false,
    };
  }

  /**
   * FULL-SRS-PLT-SETTINGS-DESIGN-CORRECTION-GATE-P1B §1 / -CORRECTION-P1C §2:
   * branch-accurate jurisdiction resolution. FR-BRN-003 requires two
   * branches of one tenant to be able to resolve to DIFFERENT Country
   * Packs, so — exactly mirroring `CountryPackService.resolveForBranch`'s
   * own reasoning ("`identity.tenants.country_pack_code` is deliberately
   * NOT used [for pricing] ... a tenant-wide default and cannot satisfy
   * FR-BRN-003") — a branch/terminal-scoped request resolves the pack
   * through the REQUESTED branch's own jurisdiction
   * (`BRANCH_JURISDICTION_QUERY`, Organisation-owned), never the tenant
   * default. `Tenant.countryPackCode` is used ONLY as the honest fallback
   * for a genuinely tenant/brand-only request, where no branch exists to
   * derive a jurisdiction from at all — not a workaround, the correct
   * answer at that narrower granularity.
   *
   * This does NOT create a Localisation<->Organisation dependency: the
   * CALLER (this resolver, already depending on both modules through their
   * own published contracts) resolves the jurisdiction code itself and
   * hands it to `COUNTRY_PACK_SETTING_FACT_QUERY` as an opaque input —
   * dependency inversion, not a new module-graph edge.
   */
  private async fetchCountryPackEntry(
    tx: Prisma.TransactionClient,
    scope: ResolvedSettingsScope,
    settingKey: string,
    at: Date,
  ): Promise<SettingLevelEntry> {
    const jurisdictionCode = await this.resolveJurisdictionCode(tx, scope);
    // Not reachable in practice (either the caller's own tenant, already
    // validated by TenantContextGuard, or a branch SettingsScopeService has
    // already proven visible) — fail closed rather than throw mid-resolve.
    if (jurisdictionCode === null) {
      return {
        level: 'country_pack',
        eligible: false,
        targetId: null,
        hasConfiguredValue: false,
        configuredValue: null,
        locked: false,
      };
    }
    const fact = this.countryPackFacts.getSettingFact({
      countryPackCode: jurisdictionCode,
      settingKey,
      at,
    });
    if (fact === undefined) {
      // No Country Pack representation for this key at all — honestly
      // ineligible, never fabricated (task instruction, §6).
      return {
        level: 'country_pack',
        eligible: false,
        targetId: jurisdictionCode,
        hasConfiguredValue: false,
        configuredValue: null,
        locked: false,
      };
    }
    return {
      level: 'country_pack',
      eligible: true,
      targetId: jurisdictionCode,
      // FR-PLT-026 / P2A-R1 clause 1: the fact is `{ value, locked }` — the
      // contributing pack's own signed `settingsLocks` decides `locked`, so
      // this resolver honours a Country-Pack lock exactly as it does for
      // every other level, through the SAME `computeEffective` walk below.
      hasConfiguredValue: fact !== null,
      configuredValue: fact?.value ?? null,
      locked: fact?.locked ?? false,
    };
  }

  private async resolveJurisdictionCode(
    tx: Prisma.TransactionClient,
    scope: ResolvedSettingsScope,
  ): Promise<string | null> {
    if (scope.branchId !== null) {
      const branch = await this.branchJurisdiction.find(tx, {
        tenantId: scope.tenantId,
        branchId: scope.branchId,
      });
      return branch?.countryCode ?? null;
    }
    const tenant = await tx.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { countryPackCode: true },
    });
    return tenant?.countryPackCode ?? null;
  }

  /**
   * SRS §6.4 / FR-PLT-026: walk HIGH -> LOW precedence. The first ELIGIBLE
   * level with a configured value becomes (so far) effective; a lower
   * eligible configured value overrides it; the walk STOPS the instant it
   * passes a configured, LOCKED level, because nothing lower may override a
   * lock.
   */
  private computeEffective(
    settingKey: string,
    scope: ResolvedSettingsScope,
    entries: readonly SettingLevelEntry[],
  ): EffectiveSettingResult {
    let effectiveValue: unknown = null;
    let effectiveSourceLevel: SettingHierarchyLevel | null = null;
    let effectiveSourceTargetId: string | null = null;
    let isLocked = false;

    for (const entry of entries) {
      if (!entry.eligible || !entry.hasConfiguredValue) continue;
      effectiveValue = entry.configuredValue;
      effectiveSourceLevel = entry.level;
      effectiveSourceTargetId = entry.targetId;
      isLocked = entry.locked;
      if (entry.locked) break;
    }

    return {
      settingKey,
      scope,
      hasEffectiveValue: effectiveSourceLevel !== null,
      effectiveValue,
      effectiveSourceLevel,
      effectiveSourceTargetId,
      isLocked,
      lockedAtLevel: isLocked ? effectiveSourceLevel : null,
      lockedByTargetId: isLocked ? effectiveSourceTargetId : null,
    };
  }
}
