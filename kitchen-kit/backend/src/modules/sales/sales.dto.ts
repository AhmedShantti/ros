import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Ids are ULIDs stored as UUID. `@IsUUID()` rejects them (ULID-as-UUID carries
 * no RFC-4122 version nibble), so the project validates the shape.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `sales.order_type_enum`. */
const ORDER_TYPES = [
  'dine_in',
  'takeaway',
  'delivery',
  'drive_thru',
  'pickup',
  'aggregator',
] as const;

/** `sales.channel_enum`. */
const CHANNELS = ['pos', 'kiosk', 'qr', 'aggregator', 'phone', 'api'] as const;

/**
 * Open an order.
 *
 * Note what is ABSENT and why: no `branchId` (derived from the terminal's
 * registration), no `businessDay` (derived from the branch's FR-FIN-024
 * cutover), no `countryPackVersion` (derived from the branch's jurisdiction and
 * the transaction instant), no `currency`, and no totals. Accepting any of them
 * would let a device decide something financial.
 */
export class CreateOrderDto {
  /**
   * FR-OFF-015 — the ULID the device already assigned. Preserved exactly, so an
   * order created offline keeps one identity for its whole life.
   */
  @IsOptional() @Matches(UUID_PATTERN) id?: string;

  /**
   * The terminal the sale is on. Optional for a terminal-bound session, where
   * it is taken from the token; when supplied it must MATCH the bound terminal.
   */
  @IsOptional() @Matches(UUID_PATTERN) terminalId?: string;

  /** Optional for a PIN session, where the employee comes from the token. */
  @IsOptional() @Matches(UUID_PATTERN) openedByEmployeeId?: string;

  @IsIn(ORDER_TYPES) orderType!: (typeof ORDER_TYPES)[number];

  @IsIn(CHANNELS) channel!: (typeof CHANNELS)[number];

  @IsOptional() @Matches(UUID_PATTERN) tableId?: string;

  @IsOptional() @IsInt() @Min(1) @Max(32767) guestCount?: number;

  /**
   * FR-OFF-015 — the device's own clock reading for the sale. Recorded as
   * `origin_device_time`; it never decides the business day.
   */
  @IsISO8601() originDeviceTime!: string;

  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class ListOrdersQueryDto {
  @IsOptional() @Matches(UUID_PATTERN) branchId?: string;

  /**
   * Cursor pagination: the order id to continue after, within the same
   * business day ordering.
   */
  @IsOptional() @Matches(UUID_PATTERN) cursorId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cursorBusinessDay?: string;

  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}

/** One modifier selection. Carries no price: the server reads `price_delta`. */
export class AddLineModifierDto {
  @Matches(UUID_PATTERN) modifierId!: string;

  @IsOptional() @IsInt() @Min(1) @Max(999) quantity?: number;
}

/**
 * Add a line to an order.
 *
 * Note what is ABSENT: no `unitPrice`, no `taxAmount`, no `taxClassId`, no
 * `unitCost`, no `recipeVersionId`, no `lineTotal`, no `priceListId`. Every one
 * of those is derived server-side, and leaving them off the DTO means a client
 * cannot even express the attempt — `forbidNonWhitelisted` rejects the request
 * before a handler runs.
 */
export class AddOrderLineDto {
  /** FR-OFF-015 — the ULID the device assigned to this line. */
  @IsOptional() @Matches(UUID_PATTERN) id?: string;

  @Matches(UUID_PATTERN) menuItemId!: string;

  @Matches(UUID_PATTERN) variantId!: string;

  /**
   * DECIMAL(12,3) carried as an exact string end to end (BR-CORE-003). A JSON
   * number could not represent 0.001 exactly and must never price a sale.
   */
  @Matches(/^(?!0+(\.0+)?$)\d{1,9}(\.\d{1,3})?$/, {
    message:
      'quantity must be a positive decimal with at most 3 decimal places',
  })
  quantity!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AddLineModifierDto)
  modifiers?: AddLineModifierDto[];

  @IsOptional() @IsInt() @Min(1) @Max(99) course?: number;

  @IsOptional() @IsInt() @Min(1) @Max(999) seatNumber?: number;

  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** Void a pre-fire line. */
export class VoidOrderLineDto {
  /**
   * REQUIRED. FR-POS-013 demands a reason on a void, and the database agrees:
   * `ck_order_line_void_reason` refuses a voided row without one. Making it
   * optional here would only move the failure from a 400 to a 500.
   *
   * The reason catalogue is `inventory.reason_codes`; this references one by id
   * and the service checks it is visible to the tenant.
   */
  @Matches(UUID_PATTERN) reasonCodeId!: string;
}

export class OrderLinePathParamsDto {
  @Matches(UUID_PATTERN) id!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDay!: string;

  @Matches(UUID_PATTERN) lineId!: string;
}

export class OrderPathParamsDto {
  @Matches(UUID_PATTERN) id!: string;

  /**
   * `sales.orders` is partitioned by `business_day` and its primary key is
   * (id, business_day), so a read needs both. It is a locator, not a claim
   * about the order's content.
   */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDay!: string;
}

/** `sales.OrderPaymentTender` — P1F-1 MVP scope only. */
const PAYMENT_TENDERS = ['cash', 'manual_external_card'] as const;

/**
 * Capture a Payment (P1F-1).
 *
 * Note what is ABSENT and why: no `tenantId`, `branchId`, `employeeId`,
 * `terminalId`, `currency`, `processedAt`, `roundingAdjustment`,
 * `changeGiven`, order `paidTotal`, or Order state — every one of those is
 * derived server-side (the employee and terminal from the trusted PIN
 * session, the rest computed), and leaving them off the DTO means a client
 * cannot even express the attempt: `forbidNonWhitelisted` rejects the
 * request before a handler runs. No PAN/CVV/track field exists on this DTO
 * at all — not merely unvalidated, structurally unrepresentable
 * (FR-POS-066).
 *
 * `tenderedAmountMinor` (CASH) and `terminalReference`
 * (MANUAL_EXTERNAL_CARD) are cross-field REQUIRED depending on `tender` —
 * enforced in `SalesPaymentService`, the same layering `VoidOrderLineDto`'s
 * reason code and `AddOrderLineDto`'s modifier rules already use, rather
 * than a `@ValidateIf` DTO rule.
 */
export class CapturePaymentDto {
  /** FR-OFF-015 — the ULID the device assigned to this Payment. */
  @IsOptional() @Matches(UUID_PATTERN) id?: string;

  @IsIn(PAYMENT_TENDERS) tender!: (typeof PAYMENT_TENDERS)[number];

  /**
   * The amount this Payment applies toward the order, in MINOR units, as an
   * exact integer string (ADR-008 — never a JSON number). For CASH, the
   * EXACT amount being settled — never the cash-rounded figure, which the
   * server derives from `tenderedAmountMinor` and the order's pinned
   * country pack.
   */
  @Matches(/^\d{1,18}$/, {
    message:
      'amountMinor must be a whole number of minor units expressed as a string',
  })
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.amountMinor === 'string' ? obj.amountMinor : '\u0000',
  )
  amountMinor!: string;

  @Matches(UUID_PATTERN) cashSessionId!: string;

  /** REQUIRED for CASH; refused for MANUAL_EXTERNAL_CARD. */
  @IsOptional()
  @Matches(/^\d{1,18}$/, {
    message:
      'tenderedAmountMinor must be a whole number of minor units expressed as a string',
  })
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    obj.tenderedAmountMinor === undefined
      ? undefined
      : typeof obj.tenderedAmountMinor === 'string'
        ? obj.tenderedAmountMinor
        : '\u0000',
  )
  tenderedAmountMinor?: string;

  /**
   * REQUIRED for MANUAL_EXTERNAL_CARD; refused for CASH. The cashier's own
   * record of the already-completed EXTERNAL terminal transaction — never a
   * ROS-side integrated-terminal session id (FR-POS-064 is not implemented).
   */
  @IsOptional() @IsString() @MaxLength(64) terminalReference?: string;

  /** Optional, only when the cashier supplies it (FR-POS-066 permitted metadata). */
  @IsOptional() @IsString() @MaxLength(32) cardScheme?: string;

  /** Optional. Exactly 4 digits when present — never more (FR-POS-066). */
  @IsOptional() @Matches(/^\d{4}$/) last4?: string;

  /** Optional. */
  @IsOptional() @IsString() @MaxLength(32) authorizationCode?: string;
}

// ==================================================== POS-FIN-1 ==========

const DISCOUNT_TYPES = ['percentage', 'fixed'] as const;

/**
 * Manager-approval fields — shared shape across discount/comp/refund
 * routes. All four are optional at the DTO level (a discount below
 * threshold needs none of them); the service refuses with 403 if approval
 * turns out to be required and they were not supplied. Present ONLY as a
 * flat group — a client cannot express "half a manager decision".
 */
class ManagerApprovalFieldsDto {
  @IsOptional() @IsString() @MaxLength(32) managerEmployeeCode?: string;

  @IsOptional() @Matches(/^\d{4,8}$/) managerPin?: string;

  @IsOptional() @Matches(UUID_PATTERN) approvalRequestId?: string;

  @IsOptional() @Matches(UUID_PATTERN) approvalDecisionId?: string;
}

/** Apply a line-level or order-level discount (FR-POS-045/046/047/049). */
export class ApplyDiscountDto extends ManagerApprovalFieldsDto {
  /** FR-OFF-015 — the ULID the device assigned to this Discount. */
  @IsOptional() @Matches(UUID_PATTERN) id?: string;

  @IsIn(DISCOUNT_TYPES) type!: (typeof DISCOUNT_TYPES)[number];

  /**
   * `type: percentage` — exact decimal string, at most 2 decimal places,
   * `0 < value <= 100` (e.g. `"15.50"`). `type: fixed` — a whole number of
   * minor units expressed as a string (ADR-008).
   */
  @IsString() @MaxLength(24) value!: string;

  /** REQUIRED — FR-POS-046: selection from a configurable list, never free text. */
  @Matches(UUID_PATTERN) reasonCodeId!: string;
}

/** Give a complimentary item (FR-POS-050) — distinct from a discount. */
export class ApplyCompDto {
  @IsOptional() @Matches(UUID_PATTERN) id?: string;

  @Matches(UUID_PATTERN) reasonCodeId!: string;
}

const POST_FIRE_VOID_DISPOSITIONS = [
  'returned_to_stock',
  'wasted',
  'given_to_staff',
] as const;

/** Void a POST-fire line, with mandatory disposition (FR-POS-070/071). */
export class VoidOrderLinePostFireDto {
  @IsOptional() @Matches(UUID_PATTERN) id?: string;

  @Matches(UUID_PATTERN) reasonCodeId!: string;

  @IsIn(POST_FIRE_VOID_DISPOSITIONS)
  disposition!: (typeof POST_FIRE_VOID_DISPOSITIONS)[number];
}

/** Issue a refund against a completed order (FR-POS-072/073/074/075). */
export class IssueRefundDto extends ManagerApprovalFieldsDto {
  @IsOptional() @Matches(UUID_PATTERN) id?: string;

  /** REQUIRED — the exact Payment this refund is issued against. */
  @Matches(UUID_PATTERN) originalPaymentId!: string;

  @IsIn(PAYMENT_TENDERS) tender!: (typeof PAYMENT_TENDERS)[number];

  /** Minor units, exact integer string (ADR-008). */
  @Matches(/^\d{1,18}$/, {
    message:
      'amountMinor must be a whole number of minor units expressed as a string',
  })
  amountMinor!: string;

  @Matches(UUID_PATTERN) reasonCodeId!: string;

  /** REQUIRED for a `cash` refund; refused for `manual_external_card`. */
  @IsOptional() @Matches(UUID_PATTERN) cashSessionId?: string;
}
