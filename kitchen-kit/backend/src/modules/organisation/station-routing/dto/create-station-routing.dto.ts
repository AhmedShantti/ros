import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/**
 * Organisation-side routing CONFIGURATION only. Resolution precedence
 * (FR-KDS-010) is Kitchen Ops behaviour and is not implemented in Phase 15.
 *
 * `menuItemId` / `categoryId` carry no foreign key because Catalogue does not
 * exist yet — exactly as the approved SQL defines them. Neither source states
 * what "both set" or "both null" means, so no rule is invented.
 */
export class CreateStationRoutingRuleDto {
  @Matches(UUID_PATTERN, { message: 'stationId must be a UUID' })
  stationId!: string;

  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'menuItemId must be a UUID' })
  menuItemId?: string;

  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'categoryId must be a UUID' })
  categoryId?: string;

  @IsOptional()
  @IsInt()
  @Min(-32768)
  @Max(32767)
  priority?: number;
}
