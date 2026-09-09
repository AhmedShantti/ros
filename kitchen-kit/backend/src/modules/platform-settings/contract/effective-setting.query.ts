import type { Prisma } from '../../../generated/prisma/client';

/**
 * platform-settings PUBLIC contract — FR-PLT-025.
 *
 * The narrow surface another module (a future Inventory approval-threshold
 * consumer, per `docs/reports/claude/
 * 2026-09-09_FULL-SRS-BACKEND-COMPLETION-AUDIT-V2.md`'s note that
 * `FR-INV-046`/`FR-INV-058` are blocked on exactly this substrate) uses to
 * ask for one effective setting value WITHOUT importing
 * `SettingsResolverService` or any other private implementation. SRS §5.4:
 * `contract/` is the only directory another module may import from.
 */
export const EFFECTIVE_SETTING_QUERY = Symbol('EFFECTIVE_SETTING_QUERY');

export interface EffectiveSettingQueryInput {
  readonly settingKey: string;
  readonly brandId?: string;
  readonly branchId?: string;
  readonly terminalId?: string;
}

export interface EffectiveSettingValue {
  readonly hasEffectiveValue: boolean;
  /** `null` when `hasEffectiveValue` is `false`. */
  readonly effectiveValue: unknown;
  readonly effectiveSourceLevel:
    | 'platform'
    | 'country_pack'
    | 'tenant'
    | 'brand'
    | 'branch'
    | 'terminal'
    | null;
  readonly isLocked: boolean;
}

export interface EffectiveSettingQuery {
  /**
   * The FR-PLT-025/026 resolved value for `tenantId` (the caller's own,
   * server-derived tenant — never accepted from the consumer). Throws the
   * same `NotFoundException` `SettingsScopeService` would for an
   * inconsistent/cross-tenant `brandId`/`branchId`/`terminalId` — a
   * consuming module MUST NOT catch this to widen its own scope, exactly as
   * it would not catch an Organisation `BRANCH_BRAND_QUERY` 404.
   */
  getEffectiveSetting(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: EffectiveSettingQueryInput,
  ): Promise<EffectiveSettingValue>;
}
