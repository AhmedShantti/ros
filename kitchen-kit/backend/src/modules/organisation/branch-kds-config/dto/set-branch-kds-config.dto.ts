import { IsOptional, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class SetBranchKdsConfigDto {
  // Required-but-nullable, not a partial-update field: this DTO's one
  // property IS the whole payload, so "omitted" and "explicit null" mean the
  // same thing (no fallback) — `@IsOptional()`'s null/undefined skip is
  // exactly that, and lets a real UUID still be format-checked.
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'fallbackStationId must be a UUID' })
  fallbackStationId!: string | null;
}
