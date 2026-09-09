import { IsOptional, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../common/ids';

export class ResolveSettingsQueryDto {
  @Matches(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/, {
    message:
      'settingKey must be lower_snake dot-separated segments, e.g. "payments.cash_rounding_policy".',
  })
  settingKey!: string;

  /**
   * `@IsUUID()` would wrongly reject this repository's ULID-derived ids
   * (valid `uuid` shape, not RFC-4122) — see `UUID_PATTERN`'s own comment.
   */
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'brandId must be a UUID' })
  brandId?: string;

  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'branchId must be a UUID' })
  branchId?: string;

  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'terminalId must be a UUID' })
  terminalId?: string;
}
