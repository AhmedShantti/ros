import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/**
 * Organisation-side routing CONFIGURATION only. Resolution precedence
 * (FR-KDS-010) is Kitchen Ops behaviour, implemented by the Kitchen module's
 * private resolver against the `organisation/contract` query — not here.
 *
 * `menuItemId` / `categoryId` / `modifierId` are tenant-safe composite FKs
 * (ADR 0008 D-09) to Catalogue. Exactly one of the three must be set — this
 * is a DB CHECK constraint (`ck_station_routing_rule_one_selector`); the
 * service validates it up front too, so a malformed request gets a 400
 * instead of an unmapped constraint-violation 500.
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
  @Matches(UUID_PATTERN, { message: 'modifierId must be a UUID' })
  modifierId?: string;

  @IsOptional()
  @IsInt()
  @Min(-32768)
  @Max(32767)
  priority?: number;
}
