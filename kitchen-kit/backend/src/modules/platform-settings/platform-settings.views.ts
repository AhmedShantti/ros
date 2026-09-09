import type { SettingValueRecord } from './settings-admin.service';
import type {
  EffectiveSettingResult,
  ResolvedSettingsScope,
  SettingsInspectorResult,
} from './settings-hierarchy.types';

function toScopeView(scope: ResolvedSettingsScope) {
  return {
    tenantId: scope.tenantId,
    brandId: scope.brandId,
    branchId: scope.branchId,
    terminalId: scope.terminalId,
  };
}

export function toEffectiveSettingView(result: EffectiveSettingResult) {
  return {
    settingKey: result.settingKey,
    scope: toScopeView(result.scope),
    hasEffectiveValue: result.hasEffectiveValue,
    effectiveValue: result.effectiveValue,
    effectiveSourceLevel: result.effectiveSourceLevel,
    effectiveSourceTargetId: result.effectiveSourceTargetId,
    isLocked: result.isLocked,
    lockedAtLevel: result.lockedAtLevel,
    lockedByTargetId: result.lockedByTargetId,
  };
}

export function toInspectorView(result: SettingsInspectorResult) {
  return {
    settingKey: result.settingKey,
    scope: toScopeView(result.scope),
    effective: toEffectiveSettingView(result.effective),
    levels: result.levels.map((level) => ({
      level: level.level,
      eligible: level.eligible,
      targetId: level.targetId,
      configuredValue: level.configuredValue,
      locked: level.locked,
      isEffectiveSource: level.isEffectiveSource,
      shadowedByLowerOverride: level.shadowedByLowerOverride,
      blockedByHigherLock: level.blockedByHigherLock,
    })),
  };
}

export function toSettingValueView(record: SettingValueRecord) {
  return {
    id: record.id,
    level: record.level,
    targetId: record.targetId,
    settingKey: record.settingKey,
    value: record.value,
    locked: record.locked,
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
