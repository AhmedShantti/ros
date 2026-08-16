import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class CreateBranchDto {
  // Server validates the brand belongs to the acting tenant; the composite FK
  // (ADR 0008 D-09) makes a cross-tenant brand structurally impossible.
  @Matches(UUID_PATTERN, { message: 'brandId must be a UUID' })
  brandId!: string;

  // Immutable after creation — FR-POS-002 embeds it in offline order numbers.
  @IsString()
  @Length(1, 16)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  // IANA zone, e.g. "Africa/Cairo".
  @IsString()
  @Length(1, 48)
  timezone!: string;

  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, {
    message: 'baseCurrency must be ISO-4217 (e.g. EGP)',
  })
  baseCurrency!: string;

  @IsString()
  @Length(2, 2)
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode must be ISO-3166-1 alpha-2' })
  countryCode!: string;

  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  automaticAvailability?: boolean;
}
