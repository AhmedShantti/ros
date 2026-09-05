import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { UUID_PATTERN } from '../../../common/ids';

const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'casual',
  'contractor',
  'trainee',
] as const;

export class CreateEmployeeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @Matches(UUID_PATTERN)
  homeBranchId!: string;

  @IsIn(EMPLOYMENT_TYPES)
  employmentType!: (typeof EMPLOYMENT_TYPES)[number];

  @IsOptional()
  @Matches(UUID_PATTERN)
  userId?: string;

  @IsOptional()
  @IsArray()
  @Matches(UUID_PATTERN, { each: true })
  permittedBranchIds?: string[];

  @IsOptional()
  @IsObject()
  namesLocalized?: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  nationalId?: string;

  @IsOptional()
  @IsObject()
  contactDetails?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  emergencyContact?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  position?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: (typeof EMPLOYMENT_TYPES)[number];

  @IsOptional()
  @IsObject()
  namesLocalized?: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  nationalId?: string;

  @IsOptional()
  @IsObject()
  contactDetails?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  emergencyContact?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  position?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;
}

export class DeactivateEmployeeDto {
  @IsIn(['suspended', 'terminated'] as const)
  status!: 'suspended' | 'terminated';

  @IsOptional()
  @IsDateString()
  terminationDate?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AddPermittedBranchDto {
  @Matches(UUID_PATTERN)
  branchId!: string;
}

export class SetCompensationDto {
  @IsIn(['hourly', 'monthly_salary', 'per_shift'] as const)
  basis!: 'hourly' | 'monthly_salary' | 'per_shift';

  /** Exact non-negative integer minor units, as a string (never a float). */
  @Matches(/^\d{1,18}$/, {
    message:
      'amountMinorUnits must be a non-negative whole number of minor units expressed as a string',
  })
  amountMinorUnits!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency!: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class CreateScheduleDto {
  @Matches(UUID_PATTERN)
  branchId!: string;

  @IsDateString()
  weekStartDate!: string;
}

export class CreateScheduledShiftDto {
  @Matches(UUID_PATTERN)
  employeeId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  position?: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;
}

class GpsDto {
  @IsLatitude()
  @Type(() => Number)
  lat!: number;

  @IsLongitude()
  @Type(() => Number)
  lng!: number;
}

export class ClockInDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GpsDto)
  gps?: GpsDto;
}

export class ClockOutDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => GpsDto)
  gps?: GpsDto;
}

export class CorrectAttendanceDto {
  @IsIn(['clock_in_at', 'clock_out_at'] as const)
  field!: 'clock_in_at' | 'clock_out_at';

  @IsDateString()
  correctedValue!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

export class SetAttendanceSettingsDto {
  @Matches(UUID_PATTERN)
  branchId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  graceMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  earlyClockInMinutes?: number;

  @IsOptional()
  @IsLatitude()
  geofenceCenterLat?: number;

  @IsOptional()
  @IsLongitude()
  geofenceCenterLng?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  geofenceRadiusMeters?: number;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
