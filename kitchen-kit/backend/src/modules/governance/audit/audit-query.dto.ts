import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { UUID_PATTERN } from '../../../common/ids';

const uuid = (f: string) =>
  Matches(UUID_PATTERN, { message: `${f} must be a UUID` });
/** A persisted `sequence_no` (BigInt), carried as a decimal string cursor. */
const SEQUENCE_NO_PATTERN = /^\d{1,20}$/;

export const AUDIT_QUERY_DEFAULT_LIMIT = 50;
export const AUDIT_QUERY_MAX_LIMIT = 200;
/**
 * Hard cap on one export response. FR-AUD-008 names no numeric bound; this is
 * an IMPLEMENTATION-level safety limit (documented, not hidden — the same
 * convention as `MAX_SAMPLED_DIVERGENCES` in the reconciliation job) that
 * keeps one export request from building an unbounded response. A caller
 * whose filters match more rows narrows `dateFrom`/`dateTo` and issues
 * multiple exports.
 */
export const AUDIT_EXPORT_MAX_RECORDS = 10_000;

/**
 * Filters common to search and export, EXCLUDING the date range — the two
 * routes disagree on whether that range is optional, and redeclaring a
 * property name across a class-validator subclass is a known footgun (BOTH
 * the parent's and the child's decorators would apply to the one property,
 * silently reinstating "optional"). Splitting the date fields out of the
 * shared base avoids that ambiguity entirely rather than relying on override
 * semantics to suppress it.
 *
 * The five fields below plus `dateFrom`/`dateTo` are exactly the six
 * FR-AUD-008 [M] names: *"searchable and filterable by actor, entity, action,
 * date range, branch, and correlation ID"*. `entity` is the requirement's own
 * field split into its two persisted columns (`entityType`, `entityId`); no
 * filter beyond these six is added.
 */
class AuditEntryFilterDto {
  @IsOptional() @uuid('branchId') branchId?: string;
  @IsOptional() @uuid('actorId') actorId?: string;
  @IsOptional() @IsString() @Length(1, 48) entityType?: string;
  @IsOptional() @uuid('entityId') entityId?: string;
  @IsOptional() @IsString() @Length(1, 80) action?: string;
  @IsOptional() @uuid('correlationId') correlationId?: string;
}

/** `GET /governance/audit/entries` — search/filter, keyset-paginated. */
export class AuditEntryQueryDto extends AuditEntryFilterDto {
  @IsOptional() @IsISO8601() dateFrom?: string;
  @IsOptional() @IsISO8601() dateTo?: string;

  /** Opaque continuation token: the `sequenceNo` of the last row already seen. */
  @IsOptional()
  @Matches(SEQUENCE_NO_PATTERN, { message: 'cursor must be a sequence number' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_QUERY_MAX_LIMIT)
  limit?: number;
}

/**
 * `GET /governance/audit/entries/export` — `dateFrom`/`dateTo` are REQUIRED
 * (not merely optional filters) so every export is bounded by construction,
 * independent of the `AUDIT_EXPORT_MAX_RECORDS` count guard.
 */
export class AuditEntryExportQueryDto extends AuditEntryFilterDto {
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
}
