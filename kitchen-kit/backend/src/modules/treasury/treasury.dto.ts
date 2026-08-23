import { Transform } from 'class-transformer';
import { Matches, MaxLength, IsOptional, IsString } from 'class-validator';

/**
 * Ids are ULIDs stored as UUID. `@IsUUID()` rejects them (ULID-as-UUID carries
 * no RFC-4122 version nibble), so the project validates the shape.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Open a cashier shift and its cash session — FR-POS-090.
 *
 * Note what is ABSENT, and that the absence is the control: there is no
 * `tenantId`, `branchId`, `employeeId`, `terminalId`, `currency`, `status` or
 * `openedAt`. All of those are derived from the trusted POS session, and with
 * `forbidNonWhitelisted` the request is rejected at the edge before a handler
 * runs — a caller cannot even express the substitution.
 */
export class OpenCashSessionDto {
  /** FR-OFF-015 — the ULID the device assigned to the shift. Preserved exactly. */
  @Matches(UUID_PATTERN) shiftId!: string;

  /** FR-OFF-015 — the ULID the device assigned to the session. Preserved exactly. */
  @Matches(UUID_PATTERN) cashSessionId!: string;

  @Matches(UUID_PATTERN) drawerId!: string;

  /**
   * Declared opening float in MINOR UNITS, as an exact integer string.
   *
   * A string, not a number: a JSON number is IEEE-754 and money must never pass
   * through one (ADR-008). "50000" is 500.00 in a 2-decimal currency; the
   * currency itself comes from the branch, never from here.
   */
  @Matches(/^\d{1,18}$/, {
    message:
      'openingFloat must be a whole number of minor units expressed as a string',
  })
  /**
   * Rejects a JSON NUMBER before the global `enableImplicitConversion` can
   * quietly stringify it.
   *
   * This is not pedantry. `JSON.parse` mangles a large integer literal before
   * any validator sees it — `9007199254740993` arrives as `...992` — so by the
   * time implicit conversion produced `"9007199254740992"` the float would
   * already be wrong by one piastre, silently, with no error anywhere. The raw
   * value must have been a string.
   */
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.openingFloat === 'string' ? obj.openingFloat : '\u0000',
  )
  openingFloat!: string;

  /** Optional free-text note recorded with the opening. */
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
