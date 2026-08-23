import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/**
 * PIN authentication at a POS terminal — FR-SEC-020 / FR-SEC-021.
 *
 * The tenant is supplied explicitly because a PIN session is established before
 * any tenant context exists: unlike password login there is no prior token to
 * carry `tid`. The terminal must belong to that tenant, which RLS enforces.
 */
export class PinLoginDto {
  @Matches(UUID_PATTERN) tenantId!: string;

  @Matches(UUID_PATTERN) terminalId!: string;

  /** Employee code, not an email — a POS operator identifies by staff code. */
  @IsString() @MinLength(1) @MaxLength(32) employeeCode!: string;

  /** FR-SEC-020: 4–8 digits. Never logged, never echoed. */
  @Matches(/^\d{4,8}$/, { message: 'PIN must be 4 to 8 digits.' })
  pin!: string;
}
