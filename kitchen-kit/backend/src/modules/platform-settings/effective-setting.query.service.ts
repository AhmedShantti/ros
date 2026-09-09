import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type {
  EffectiveSettingQuery,
  EffectiveSettingQueryInput,
  EffectiveSettingValue,
} from './contract/effective-setting.query';
import { SettingsResolverService } from './settings-resolver.service';

/** Private implementation of `EFFECTIVE_SETTING_QUERY` — see that contract file. */
@Injectable()
export class EffectiveSettingQueryService implements EffectiveSettingQuery {
  constructor(private readonly resolver: SettingsResolverService) {}

  async getEffectiveSetting(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: EffectiveSettingQueryInput,
  ): Promise<EffectiveSettingValue> {
    const breakdown = await this.resolver.fetchLevelBreakdownInTx(
      tx,
      tenantId,
      input,
    );
    return {
      hasEffectiveValue: breakdown.effective.hasEffectiveValue,
      effectiveValue: breakdown.effective.effectiveValue,
      effectiveSourceLevel: breakdown.effective.effectiveSourceLevel,
      isLocked: breakdown.effective.isLocked,
    };
  }
}
