import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { TIME_OF_DAY_PATTERN } from '../time-of-day';

/**
 * ADR 0008 D-04: `dayOfWeek` is 0 = Sunday … 6 = Saturday (aligned with
 * PostgreSQL `EXTRACT(DOW)`), matching the approved SQL's CHECK 0..6.
 * `closesAt` earlier than or equal to `opensAt` denotes an overnight interval.
 */
export class CreateOperatingHoursDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Matches(TIME_OF_DAY_PATTERN, {
    message: 'opensAt must be HH:MM or HH:MM:SS',
  })
  opensAt!: string;

  @Matches(TIME_OF_DAY_PATTERN, {
    message: 'closesAt must be HH:MM or HH:MM:SS',
  })
  closesAt!: string;

  @IsOptional()
  @Matches(TIME_OF_DAY_PATTERN, {
    message: 'businessDayCutover must be HH:MM or HH:MM:SS',
  })
  businessDayCutover?: string;
}
