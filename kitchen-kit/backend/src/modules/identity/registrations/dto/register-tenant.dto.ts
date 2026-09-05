import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * SIGNUP-1 (FR-PLT-020) — public tenant self-service signup request.
 *
 * Shape matches the frontend's own documented intended contract
 * (`lib/api/registration.ts`'s `RegistrationRequest`) literally, so the
 * existing signup form needs no field changes. `roleKey` is accepted as an
 * open string here (the full 17-role catalog is a frontend-only concept) and
 * validated by business rule in `RegistrationsService`: this slice supports
 * only `"owner"` (new-tenant self-service signup) — any other role requires an
 * administrator invitation flow, which is out of scope for this slice.
 */
export class RegisterTenantDto {
  @IsString()
  @Length(1, 80)
  fullName!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[\d\s()-]{7,20}$/)
  phone?: string;

  @IsString()
  @Length(1, 64)
  roleKey!: string;

  /** New tenant's legal/business name. */
  @IsString()
  @Length(1, 120)
  organisation!: string;

  /** First branch name. Optional — defaults to "Main" when omitted. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  scopeName?: string;

  /** POS/KDS sign-on. Accepted for frontend contract parity; unused for the
   *  owner path (owner is not a terminal role in this slice). */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  employeeCode?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4,8}$/)
  pin?: string;

  /** FR-SEC-025 — signup requires a minimum of 10 characters. */
  @IsString()
  @Length(10, 128)
  password!: string;
}
