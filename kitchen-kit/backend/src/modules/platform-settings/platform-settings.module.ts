import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { LocalisationModule } from '../localisation/localisation.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { EFFECTIVE_SETTING_QUERY } from './contract';
import { EffectiveSettingQueryService } from './effective-setting.query.service';
import {
  PLATFORM_SETTINGS_SCOPE_TARGET_RESOLVER,
  PlatformSettingsScopeTargetResolver,
} from './platform-settings-scope-target.resolver';
import { PlatformSettingsController } from './platform-settings.controller';
import { SettingsAdminService } from './settings-admin.service';
import { SettingsInspectorService } from './settings-inspector.service';
import { SettingsResolverService } from './settings-resolver.service';
import { SettingsScopeService } from './settings-scope.service';

/**
 * FR-PLT-025/026/027 — the hierarchical settings resolver bounded context.
 *
 * A NEW module rather than an addition to `PlatformModule`:
 * `platform.module.ts`'s own docblock states, as a deliberate architectural
 * invariant, "This module still imports zero domain modules, and always
 * will" — reaching Organisation/Identity/Localisation for the hierarchy
 * validation and Country-Pack tier this resolver requires would directly
 * contradict that documented guarantee. See
 * `docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md`
 * OWNERSHIP_DECISION for the full reasoning.
 *
 * Storage lives in the `platform` schema (SRS §25.1 names it for exactly
 * this kind of cross-cutting substrate), but module OWNERSHIP is this
 * dedicated module, not `PlatformModule`'s job/partitioning code.
 */
@Module({
  imports: [IdentityModule, OrganisationModule, LocalisationModule],
  controllers: [PlatformSettingsController],
  providers: [
    SettingsScopeService,
    SettingsResolverService,
    SettingsInspectorService,
    SettingsAdminService,
    PlatformSettingsScopeTargetResolver,
    {
      provide: PLATFORM_SETTINGS_SCOPE_TARGET_RESOLVER,
      useExisting: PlatformSettingsScopeTargetResolver,
    },
    EffectiveSettingQueryService,
    {
      provide: EFFECTIVE_SETTING_QUERY,
      useExisting: EffectiveSettingQueryService,
    },
  ],
  exports: [EFFECTIVE_SETTING_QUERY],
})
export class PlatformSettingsModule {}
