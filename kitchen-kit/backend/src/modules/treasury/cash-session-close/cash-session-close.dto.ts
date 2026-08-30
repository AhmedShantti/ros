import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Ids are ULIDs stored as UUID. `@IsUUID()` rejects them (no RFC-4122
 * version nibble), so the project validates the shape directly — the same
 * pattern every other DTO in this repository uses.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DenominationCountDto {
  /** Positive integer minor units, as an exact string (never a JSON number). */
  @Matches(/^[1-9]\d{0,17}$/, {
    message:
      'denominationMinorUnits must be a positive whole number of minor units expressed as a string',
  })
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.denominationMinorUnits === 'string'
      ? obj.denominationMinorUnits
      : ' ',
  )
  denominationMinorUnits!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * Declare the physical cash count for a CashSession Close — FR-POS-094 [M].
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────
 * `reason`, `managerPin`, and `decision` do NOT appear here. The design
 * acceptance closure removed the above-tolerance one-request fast path
 * entirely: in blind mode (FR-POS-095 [M]) the authoritative expected cash
 * and variance MUST NOT be disclosed until the count is durably committed,
 * so a manager PIN supplied BEFORE that disclosure could not possibly be an
 * INFORMED decision against the actual `ApprovalRequest.value`. A reason is
 * collected at `finalize`, once the cashier can actually see what happened.
 *
 * ── `closeAttemptId` IS REQUIRED, NOT OPTIONAL ──────────────────────────
 * FR-OFF-015: this is a device-created "drawer event" declared by the
 * cashier's own terminal at physical count time (§21.3 lists "Shifts, cash
 * sessions, drawer events" as synced Up/Continuous). The client assigns the
 * PERMANENT primary key; the server SHALL NOT reassign it. There is no
 * server-generated fallback — exactly the `CashMovementDto.id` precedent.
 *
 * ── COUNT REPRESENTATION ─────────────────────────────────────────────────
 * At least one of `countedTotalMinorUnits` or `denominations` is required
 * (enforced in the service, not here — a cross-field "at least one of"
 * constraint reads more clearly as a single service-level message than as a
 * custom class-validator decorator). If both are supplied, the server
 * verifies the denomination sum equals the declared total; a mismatch is a
 * 400, never silently reconciled either way.
 */
export class DeclareCashSessionCloseDto {
  /** FR-OFF-015 — the device's permanent ULID for this close attempt. REQUIRED. */
  @Matches(UUID_PATTERN, {
    message: 'closeAttemptId must be a ULID rendered as a UUID.',
  })
  closeAttemptId!: string;

  /** Non-negative integer minor units, as an exact string. Zero is valid. */
  @IsOptional()
  @Matches(/^\d{1,18}$/, {
    message:
      'countedTotalMinorUnits must be a non-negative whole number of minor units expressed as a string',
  })
  countedTotalMinorUnits?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DenominationCountDto)
  denominations?: DenominationCountDto[];
}

/**
 * The manager's decision on a frozen (above-tolerance) CashSession Close —
 * FR-FIN-006 [M].
 *
 * ── WHY BOTH IDS ARE CLIENT-SUPPLIED ─────────────────────────────────────
 * Mirrors the Approval Runtime's own accepted contract exactly:
 * `CreateApprovalRequestCommand.id` / `DecideApprovalCommand.id` are both
 * FR-OFF-015-style client-generated permanent ids. A retry after an explicit
 * REJECTION (R-6(a)) supplies FRESH ids for both — that is what makes the
 * retry a genuinely new business act rather than a replay of the rejected one.
 *
 * ── WHY `decision` IS EXPLICIT ────────────────────────────────────────────
 * R-6(a) makes rejection a first-class, recorded, retryable outcome — a
 * route that could only ever express approval while the ratified design
 * requires rejection recovery would be incoherent.
 *
 * ── MANAGER PIN FIELDS ────────────────────────────────────────────────────
 * Mirrors `PinLoginDto` exactly: PIN authentication identifies by employee
 * code, not email. Verified OUTSIDE the business transaction via Identity's
 * `TERMINAL_PIN_VERIFIER` contract — failed-attempt/lockout counters must
 * survive a later business-transaction rollback.
 */
export class FinalizeCashSessionCloseDto {
  /** FR-OFF-015 — client-generated permanent id for THIS approval request. */
  @Matches(UUID_PATTERN, {
    message: 'approvalRequestId must be a ULID rendered as a UUID.',
  })
  approvalRequestId!: string;

  /** FR-OFF-015 — client-generated permanent id for THIS approval decision. */
  @Matches(UUID_PATTERN, {
    message: 'approvalDecisionId must be a ULID rendered as a UUID.',
  })
  approvalDecisionId!: string;

  @IsEnum(['approved', 'rejected'] as const, {
    message: "decision must be 'approved' or 'rejected'.",
  })
  decision!: 'approved' | 'rejected';

  /** FR-FIN-006 [M] — mandatory above tolerance. Non-blank. */
  @Matches(/\S/, { message: 'reason must not be blank.' })
  @IsString()
  @MaxLength(1000)
  reason!: string;

  /** The deciding manager's employee code — mirrors `PinLoginDto`. */
  @IsString()
  @MaxLength(32)
  managerEmployeeCode!: string;

  /** FR-SEC-020: 4-8 digits. Never logged, never echoed. */
  @Matches(/^\d{4,8}$/, { message: 'managerPin must be 4 to 8 digits.' })
  managerPin!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
