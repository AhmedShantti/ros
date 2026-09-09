import { BadRequestException } from '@nestjs/common';

/**
 * `platform.setting_values.setting_key` / `platform_default_settings.setting_key`
 * are `VARCHAR(120)`. Lower-snake dotted segments (`payments.cash_rounding_policy`)
 * keep keys stable, greppable, and safe as a URL path segment without
 * encoding.
 */
const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export function assertValidSettingKey(settingKey: string): void {
  if (settingKey.length > 120 || !SETTING_KEY_PATTERN.test(settingKey)) {
    throw new BadRequestException(
      'settingKey must be lower_snake dot-separated segments, e.g. "payments.cash_rounding_policy", at most 120 characters.',
    );
  }
}
