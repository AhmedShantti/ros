/**
 * FR-PLT-025/026/027 — shared hierarchy types for the settings resolver.
 *
 * SRS §6.4's six-level cascade, in precedence order (a lower level overrides
 * a higher one, unless a higher level is locked):
 *
 *   Platform Default -> Country Pack -> Tenant -> Brand -> Branch -> Terminal
 *
 * Only FOUR of these are rows in `platform.setting_values`
 * (tenant/brand/branch/terminal, see `SettingLevel` in `schema.prisma`) — see
 * that model's own comment, and `docs/reports/claude/
 * 2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md`, for why `platform` and
 * `country_pack` are resolved from elsewhere instead.
 */
export const SETTING_HIERARCHY_LEVELS = [
  'platform',
  'country_pack',
  'tenant',
  'brand',
  'branch',
  'terminal',
] as const;

export type SettingHierarchyLevel = (typeof SETTING_HIERARCHY_LEVELS)[number];

/** The four levels that are real `platform.setting_values` rows. */
export type StorableSettingLevel = Extract<
  SettingHierarchyLevel,
  'tenant' | 'brand' | 'branch' | 'terminal'
>;

/**
 * A tenant-anchored request context. `tenantId` is ALWAYS the caller's own,
 * server-derived tenant (never a client-supplied cross-tenant id — see
 * `PlatformSettingsController`). `brandId`/`branchId`/`terminalId` are
 * caller-supplied narrowing ids, validated and made internally consistent by
 * `SettingsScopeService.deriveScope` before any resolution happens.
 */
export interface RequestedSettingsScope {
  readonly tenantId: string;
  readonly brandId?: string;
  readonly branchId?: string;
  readonly terminalId?: string;
}

/**
 * The SAME scope after `SettingsScopeService.deriveScope` has validated every
 * supplied id and DERIVED any implied parents (a supplied `branchId` derives
 * its `brandId`; a supplied `terminalId` derives its `branchId` and, through
 * it, its `brandId`). Every id present here is confirmed to exist, to be
 * visible in `tenantId`'s own RLS context, and to be internally consistent
 * (a supplied id that contradicts a derived one is rejected before this type
 * is ever constructed — see `SettingsScopeService`).
 */
export interface ResolvedSettingsScope {
  readonly tenantId: string;
  readonly brandId: string | null;
  readonly branchId: string | null;
  readonly terminalId: string | null;
}

/** One level's raw fetch result, before precedence/lock computation. */
export interface SettingLevelEntry {
  readonly level: SettingHierarchyLevel;
  /**
   * Whether this level is even IN PLAY for this request — `false` when the
   * caller did not supply/derive an id deep enough to reach this level (a
   * request naming only `tenantId` makes `brand`/`branch`/`terminal`
   * ineligible), or, for `country_pack`, when `settingKey` has no Country
   * Pack representation at all (see
   * `COUNTRY_PACK_SETTING_FACT_QUERY.supportedSettingKeys`).
   */
  readonly eligible: boolean;
  /**
   * The identity this level's row (if any) is keyed to — `tenantId` for
   * `tenant`, the pack code for `country_pack`, `null` for `platform`, and
   * the caller's own brand/branch/terminal id otherwise. `null` when
   * `eligible` is `false`.
   */
  readonly targetId: string | null;
  readonly hasConfiguredValue: boolean;
  /** `null` when `hasConfiguredValue` is `false`. */
  readonly configuredValue: unknown;
  /** `false` when `hasConfiguredValue` is `false` — a lock needs a value. */
  readonly locked: boolean;
}

/** The FR-PLT-025/026 authoritative resolution outcome for one setting. */
export interface EffectiveSettingResult {
  readonly settingKey: string;
  readonly scope: ResolvedSettingsScope;
  readonly hasEffectiveValue: boolean;
  /** `null` when `hasEffectiveValue` is `false`. */
  readonly effectiveValue: unknown;
  readonly effectiveSourceLevel: SettingHierarchyLevel | null;
  readonly effectiveSourceTargetId: string | null;
  readonly isLocked: boolean;
  readonly lockedAtLevel: SettingHierarchyLevel | null;
  readonly lockedByTargetId: string | null;
}

/** The full per-level walk `computeEffective` folds into `EffectiveSettingResult`. */
export interface SettingLevelBreakdown {
  readonly settingKey: string;
  readonly scope: ResolvedSettingsScope;
  readonly entries: readonly SettingLevelEntry[];
  readonly effective: EffectiveSettingResult;
}

/** FR-PLT-027 — one row of the settings inspector's level-by-level view. */
export interface SettingsInspectorLevelView {
  readonly level: SettingHierarchyLevel;
  readonly eligible: boolean;
  readonly targetId: string | null;
  readonly configuredValue: unknown;
  readonly locked: boolean;
  readonly isEffectiveSource: boolean;
  readonly shadowedByLowerOverride: boolean;
  readonly blockedByHigherLock: boolean;
}

export interface SettingsInspectorResult {
  readonly settingKey: string;
  readonly scope: ResolvedSettingsScope;
  readonly effective: EffectiveSettingResult;
  readonly levels: readonly SettingsInspectorLevelView[];
}
