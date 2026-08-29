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

/**
 * PAY_IN / PAY_OUT / SAFE_DROP request body — FR-POS-091 [M].
 *
 * ── `id` IS REQUIRED, NOT OPTIONAL ──────────────────────────────────────────
 * FR-OFF-015 governs this device-created "drawer event" (SRS §21.3 lists
 * "Shifts, cash sessions, drawer events" as synced Up/Continuous): the client
 * assigns the PERMANENT primary key, and the server SHALL NOT reassign it.
 * There is no server-generated movement-id fallback. Idempotency-Key alone
 * would only protect a single HTTP retry, not an offline-replayed record —
 * exactly the OrderPayment precedent (P1F-1's `input.id` permanent-id check).
 *
 * ── WHAT IS ABSENT, AND WHY THE ABSENCE IS THE CONTROL ─────────────────────
 * No `tenantId`, `branchId`, `cashSessionId` (it is the route param),
 * `employeeId`, `currency`, or `movementType` (the route decides it). All are
 * derived from the trusted POS session or the route itself, so a caller
 * cannot even express the substitution (mirrors `OpenCashSessionDto`).
 */
export class CashMovementDto {
  /** FR-OFF-015 — the device's permanent ULID for this movement. REQUIRED. */
  @Matches(UUID_PATTERN, {
    message: 'id must be a ULID rendered as a UUID.',
  })
  id!: string;

  /**
   * Positive integer minor units, as an exact string (ADR-008: money is never
   * a JSON number). The movement TYPE (the route) supplies the sign — a
   * client can never submit a negative amount.
   */
  @Matches(/^(?!0+$)\d{1,18}$/, {
    message:
      'amountMinor must be a positive (non-zero) whole number of minor units expressed as a string',
  })
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.amountMinor === 'string' ? obj.amountMinor : ' ',
  )
  amountMinor!: string;

  /** FR-POS-091 [M] — mandatory for ALL THREE movement types. Non-blank. */
  @Matches(/\S/, { message: 'reason must not be blank.' })
  @IsString()
  @MaxLength(500)
  reason!: string;

  /** Device-declared instant. Defaults to server receipt time if omitted. */
  @IsOptional()
  @IsString()
  occurredAt?: string;
}
