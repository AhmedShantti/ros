import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Min,
} from 'class-validator';

/**
 * Create a new immutable cash-close policy VERSION for one branch — P1G-1
 * migration 33, ratification R-1(a)/R-4(a)/R-5.
 *
 * WHAT IS ABSENT, AND WHY THE ABSENCE IS THE CONTROL:
 * No `tenantId` (from `TenantContext`), no `branchId` in the body (the route
 * param), no `createdBy` (from the authenticated principal), and no
 * `currency` — the branch's own base currency is used, server-side, inside
 * the same transaction (design gate section 17/21). A caller cannot express
 * any of these substitutions (mirrors `OpenCashSessionDto` / `CashMovementDto`).
 */
export class CreateCashClosePolicyDto {
  /**
   * R-1(a): absolute non-negative minor units, as an exact integer string.
   * A JSON number is IEEE-754 and money must never pass through one
   * (ADR-008) - mirrors `OpenCashSessionDto.openingFloat` exactly, including
   * zero being a VALID tolerance (unlike a positive-amount field).
   */
  @Matches(/^\d{1,18}$/, {
    message:
      'varianceToleranceMinorUnits must be a non-negative whole number of ' +
      'minor units expressed as a string',
  })
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.varianceToleranceMinorUnits === 'string'
      ? obj.varianceToleranceMinorUnits
      : ' ',
  )
  varianceToleranceMinorUnits!: string;

  /** R-4(a): configured positive duration. No default exists anywhere. */
  @IsInt()
  @Min(1)
  varianceApprovalExpirySeconds!: number;

  /** FR-POS-094/095. Omitted = the source-stated default, `blind`. */
  @IsOptional()
  @IsEnum(['blind', 'open'] as const)
  countMode?: 'blind' | 'open';

  /**
   * R-3(a)/C-2. Omitted = effective immediately (resolved to DATABASE time,
   * never this process's clock). Supplied = an explicit future activation
   * instant; a past instant is rejected (C-2 - enforced by the DB CHECK, not
   * merely this validator).
   */
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;
}
