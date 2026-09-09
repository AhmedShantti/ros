import { Injectable } from '@nestjs/common';
import { SettingsResolverService } from './settings-resolver.service';
import type { ResolveSettingInput } from './settings-resolver.service';
import { SETTING_HIERARCHY_LEVELS } from './settings-hierarchy.types';
import type {
  SettingsInspectorLevelView,
  SettingsInspectorResult,
} from './settings-hierarchy.types';

/**
 * FR-PLT-027 — settings inspector.
 *
 * "For an effective value, shows: which level supplied the effective value;
 * what value exists at each level." Delegates the actual precedence/lock
 * walk to `SettingsResolverService.fetchLevelBreakdown` (the ONE
 * authoritative resolver, FR-PLT-025) and adds the shadowed/blocked
 * annotations that walk does not itself need.
 */
@Injectable()
export class SettingsInspectorService {
  constructor(private readonly resolver: SettingsResolverService) {}

  async inspect(
    tenantId: string,
    input: ResolveSettingInput,
  ): Promise<SettingsInspectorResult> {
    const breakdown = await this.resolver.fetchLevelBreakdown(tenantId, input);

    const effectiveIndex = breakdown.effective.effectiveSourceLevel
      ? SETTING_HIERARCHY_LEVELS.indexOf(
          breakdown.effective.effectiveSourceLevel,
        )
      : -1;
    // The walk stops the instant it passes a locked, configured level — so
    // "blocked by a higher lock" applies to every eligible, configured entry
    // AFTER that level, exactly the entries the resolver never let win.
    const lockStopIndex = breakdown.effective.isLocked ? effectiveIndex : -1;

    const levels: SettingsInspectorLevelView[] = breakdown.entries.map(
      (entry) => {
        const index = SETTING_HIERARCHY_LEVELS.indexOf(entry.level);
        const blockedByHigherLock =
          entry.eligible &&
          entry.hasConfiguredValue &&
          lockStopIndex !== -1 &&
          index > lockStopIndex;
        const isEffectiveSource =
          entry.eligible &&
          entry.hasConfiguredValue &&
          index === effectiveIndex;
        const shadowedByLowerOverride =
          entry.eligible &&
          entry.hasConfiguredValue &&
          !blockedByHigherLock &&
          !isEffectiveSource;

        return {
          level: entry.level,
          eligible: entry.eligible,
          targetId: entry.targetId,
          configuredValue: entry.hasConfiguredValue
            ? entry.configuredValue
            : null,
          locked: entry.locked,
          isEffectiveSource,
          shadowedByLowerOverride,
          blockedByHigherLock,
        };
      },
    );

    return {
      settingKey: breakdown.settingKey,
      scope: breakdown.scope,
      effective: breakdown.effective,
      levels,
    };
  }
}
