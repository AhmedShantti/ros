import { Type } from 'class-transformer';
import {
  IsDateString,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  Matches,
  ValidateNested,
} from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/**
 * The scope an assignment carries — FR-SEC-002 [M].
 *
 * EXACTLY the three ratified types. A "set of branches" is several
 * `branch`-scoped assignments, never an array here (amendment clause 4).
 */
export class AssignmentScopeDto {
  @IsIn(['tenant', 'brand', 'branch'], {
    message: 'scope.type must be one of: tenant, brand, branch',
  })
  type!: 'tenant' | 'brand' | 'branch';

  /** Required iff `type = brand`. */
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'scope.brandId must be a UUID' })
  brandId?: string;

  /** Required iff `type = branch`. */
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'scope.branchId must be a UUID' })
  branchId?: string;
}

/**
 * Create ONE scoped role assignment.
 *
 * `scope` is MANDATORY: amendment clause 18 of the B1-2 brief forbids silently
 * defaulting a new assignment to TENANT, because that would quietly re-create
 * the pre-B1-2 unscoped world one assignment at a time.
 */
export class AssignRoleDto {
  @Matches(UUID_PATTERN, { message: 'roleId must be a UUID' })
  roleId!: string;

  // `@ValidateNested` alone does not reject an ABSENT object, so an omitted
  // scope would reach the handler as `undefined`. `@IsDefined`/`@IsObject` make
  // "no scope" a 400 at the edge rather than a 500 in the mapper — an omitted
  // scope must never be a server error, and must certainly never default.
  @IsDefined({ message: 'scope is required (tenant, brand or branch)' })
  @IsObject({ message: 'scope must be an object' })
  @ValidateNested()
  @Type(() => AssignmentScopeDto)
  scope!: AssignmentScopeDto;

  /** FR-SEC-005 — defaults to now when omitted. */
  @IsOptional()
  @IsDateString({}, { message: 'validFrom must be an ISO-8601 date-time' })
  validFrom?: string;

  /** FR-SEC-005 — omit or null for an open-ended assignment. */
  @IsOptional()
  @IsDateString({}, { message: 'validTo must be an ISO-8601 date-time' })
  validTo?: string | null;
}

/** Re-scope and/or re-date ONE assignment, addressed by its stable id. */
export class UpdateAssignmentDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AssignmentScopeDto)
  scope?: AssignmentScopeDto;

  @IsOptional()
  @IsDateString({}, { message: 'validFrom must be an ISO-8601 date-time' })
  validFrom?: string;

  @IsOptional()
  @IsDateString({}, { message: 'validTo must be an ISO-8601 date-time' })
  validTo?: string | null;
}
