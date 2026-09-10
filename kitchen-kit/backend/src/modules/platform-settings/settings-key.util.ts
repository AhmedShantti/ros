import { BadRequestException } from '@nestjs/common';
import {
  SETTING_KEY_MAX_LENGTH,
  isValidSettingKeySyntax,
} from '../../common/settings-key';

/**
 * HTTP-shaped wrapper around the shared `isValidSettingKeySyntax` primitive
 * (P2A-R1 clause 2) — same external behaviour/exception shape as before,
 * delegating the actual syntax check to `src/common/settings-key.ts` so
 * Platform Settings and the Country Pack setting-key vocabulary validate
 * against exactly one pattern.
 */
export function assertValidSettingKey(settingKey: string): void {
  if (!isValidSettingKeySyntax(settingKey)) {
    throw new BadRequestException(
      `settingKey must be lower_snake dot-separated segments, e.g. "payments.cash_rounding_policy", at most ${SETTING_KEY_MAX_LENGTH} characters.`,
    );
  }
}
