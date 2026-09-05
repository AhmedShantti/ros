import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/**
 * D4-1B — `POST /v1/sync/recovery/grants` body.
 *
 * `reason` is required, never optional: an unaccountable recovery grant is
 * not auditable (D1-1 §21.3 invariant 3). `ttlMinutes` bounds the window a
 * committed backlog upload stays possible — the grant is not open-ended.
 */
export class IssueRecoveryGrantDto {
  @Matches(UUID_PATTERN, { message: 'terminalId must be a UUID.' })
  terminalId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  /** Default and cap enforced server-side in `SyncRecoveryService`. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  ttlMinutes?: number;
}
