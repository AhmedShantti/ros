import { Type } from 'class-transformer';
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
