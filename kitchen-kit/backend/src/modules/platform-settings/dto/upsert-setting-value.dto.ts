import { IsBoolean, IsDefined, IsOptional } from 'class-validator';

/**
 * FR-PLT-025/026 write surface — set/upsert one setting value at a supported
 * level (tenant/brand/branch/terminal), optionally toggling its lock.
 *
 * `value` is intentionally typed as `unknown`: the whole point of a generic
 * settings store is that it does not know the shape of any particular
 * `settingKey`'s value ahead of time (§1 — "JSON-compatible value").
 * Size/shape policing beyond "is it JSON-serializable" belongs to whichever
 * future consumer defines a specific key's schema, not this substrate.
 */
export class UpsertSettingValueDto {
  @IsDefined({ message: 'value is required.' })
  value!: unknown;

  /** Omitted = leave the existing lock state unchanged (default `false` on create). */
  @IsOptional()
  @IsBoolean()
  locked?: boolean;
}
