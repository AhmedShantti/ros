import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/**
 * `code` is intentionally absent: it is immutable after creation (FR-POS-002
 * embeds `<branch_code>` in offline-generated order numbers). `brandId` is also
 * absent — reassignment is a dedicated operation (ADR 0008 D-13), never a
 * generic PATCH field. `tenantId` is never accepted anywhere.
 */
export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 48)
  timezone?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'baseCurrency must be ISO-4217 (e.g. EGP)',
  })
  baseCurrency?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode must be ISO-3166-1 alpha-2' })
  countryCode?: string;

  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  automaticAvailability?: boolean;
}
