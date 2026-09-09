import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { COUNTRY_PACK_SETTING_FACT_QUERY } from '../localisation/contract';
import type { CountryPackSettingFactQuery } from '../localisation/contract';
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

    if (level === 'country_pack') {
      return this.fetchCountryPackEntry(tx, scope, settingKey, at);
    }

    const targetId = targetIdForStorableLevel(level, scope);
    if (targetId === null) {
      return {
        level,
        eligible: false,
        targetId: null,
        hasConfiguredValue: false,
        configuredValue: null,
        locked: false,
      };
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

  private async fetchCountryPackEntry(
    tx: Prisma.TransactionClient,
    scope: ResolvedSettingsScope,
    settingKey: string,
    at: Date,
  ): Promise<SettingLevelEntry> {
    const tenant = await tx.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { countryPackCode: true },
    });
    // Not reachable in practice (the caller's own tenant, already validated
    // by TenantContextGuard) — fail closed rather than throw mid-resolve.
    if (!tenant) {
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
      countryPackCode: tenant.countryPackCode,
      settingKey,
      at,
    });
    if (fact === undefined) {
      // No Country Pack representation for this key at all — honestly
      // ineligible, never fabricated (task instruction, §6).
      return {
        level: 'country_pack',
        eligible: false,
        targetId: tenant.countryPackCode,
        hasConfiguredValue: false,
        configuredValue: null,
        locked: false,
      };
    }
    return {
      level: 'country_pack',
      eligible: true,
      targetId: tenant.countryPackCode,
      hasConfiguredValue: fact !== null,
      configuredValue: fact,
      // Country Pack facts are Localisation's own authoritative data, never
      // an app-writable row here, so FR-PLT-026 locking does not apply to
      // them — a Country Pack value can still be overridden by Tenant and
      // below, exactly like any other unlocked higher level.
      locked: false,
    };
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
