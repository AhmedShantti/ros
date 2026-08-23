import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import {
  isoDateTimeSchema,
  moneyStringSchema,
  decimalStringSchema,
  businessDaySchema,
  uuidSchema,
  nullable,
} from '../../../common/openapi/schema-helpers';
import { CurrentPrincipal } from '../../identity/auth/decorators/current-principal.decorator';
import { AllowPosSession } from '../../identity/auth/decorators/pos-session.decorator';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../../identity/auth/auth.types';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import {
  AddOrderLineDto,
  CreateOrderDto,
  ListOrdersQueryDto,
  OrderLinePathParamsDto,
  OrderPathParamsDto,
  VoidOrderLineDto,
} from '../sales.dto';
import { SALES_PERMISSIONS } from '../sales.permissions';
import { orderETag, toOrderLineView, toOrderView } from '../sales.views';
import { OrderLinesService } from './order-lines.service';
import { OrdersService } from './orders.service';

/**
 * Order capture API.
 *
 * Route surface, following how `/inventory`, `/catalogue` and `/production`
 * map SRS §26.3 (the documented `/v1` prefix is applied at deployment, not in
 * the controller):
 *
 *   POST   /orders                                  open an order
 *   GET    /orders                                  list, cursor-paginated
 *   GET    /orders/:businessDay/:id                 one order, lines + ETag
 *   POST   /orders/:businessDay/:id/lines           capture a line
 *   DELETE /orders/:businessDay/:id/lines/:lineId   void a PRE-FIRE line
 *
 * ── DELIBERATELY ABSENT ─────────────────────────────────────────────────────
 *   POST   /orders/:id/fire       · Firing has real KDS/ticket consequences and
 *                                   no kitchen context exists. A state flip
 *                                   would be a lie about production.
 *   POST   /orders/:id/complete   · BR-POS-002 gates COMPLETED on payment, and
 *                                   completion must also drive fiscal documents,
 *                                   inventory depletion, COGS and drawer
 *                                   attribution. None of those exist.
 *
 * Guard chain: JwtAuthGuard (401) -> TenantContextGuard (403) ->
 * PermissionGuard (403). A cross-tenant id is invisible under RLS and yields
 * 404, never 403, so a response cannot disclose another tenant's data.
 *
 * `@AllowPosSession` opts these routes in for PIN-issued sessions (FR-SEC-021);
 * every other route in the system still refuses them by default.
 */

// Shapes verified against `toOrderView`/`toOrderLineView` in `sales.views.ts`,
// the only place these responses are actually built — not against the SRS or
// the Prisma schema.
const orderLineSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    sequence: { type: 'integer' },
    menuItemId: uuidSchema(),
    variantId: uuidSchema(),
    itemNameSnapshot: {
      type: 'object',
      description:
        'Opaque localized-name snapshot (locale -> name), persisted at capture time.',
    },
    quantity: decimalStringSchema(),
    unitPrice: moneyStringSchema(),
    modifierTotal: moneyStringSchema(),
    lineDiscount: moneyStringSchema(),
    lineSubtotal: moneyStringSchema(),
    taxClassId: nullable(uuidSchema()),
    taxAmount: moneyStringSchema(),
    lineTotal: moneyStringSchema(),
    unitCostSnapshot: nullable(decimalStringSchema()),
    recipeVersionId: nullable(uuidSchema()),
    priceListId: nullable(uuidSchema()),
    priceEntryId: nullable(uuidSchema()),
    priceRule: {
      type: 'object',
      description: 'Opaque pricing-rule provenance snapshot.',
    },
    course: nullable({ type: 'integer' }),
    seatNumber: nullable({ type: 'integer' }),
    state: {
      type: 'string',
      enum: [
        'pending',
        'fired',
        'preparing',
        'ready',
        'served',
        'voided',
        'comped',
      ],
    },
    firedAt: nullable(isoDateTimeSchema()),
    readyAt: nullable(isoDateTimeSchema()),
    isComp: { type: 'boolean' },
    notes: nullable({ type: 'string' }),
    createdAt: isoDateTimeSchema(),
  },
};

const orderSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    terminalId: nullable(uuidSchema()),
    orderNumber: { type: 'string' },
    businessDay: businessDaySchema(),
    orderType: {
      type: 'string',
      enum: [
        'dine_in',
        'takeaway',
        'delivery',
        'drive_thru',
        'pickup',
        'aggregator',
      ],
    },
    channel: {
      type: 'string',
      enum: ['pos', 'kiosk', 'qr', 'aggregator', 'phone', 'api'],
    },
    state: {
      type: 'string',
      enum: [
        'draft',
        'open',
        'held',
        'parked',
        'partially_paid',
        'completed',
        'cancelled',
        'partially_refunded',
        'refunded',
      ],
    },
    tableId: nullable(uuidSchema()),
    guestCount: nullable({ type: 'integer' }),
    openedBy: uuidSchema(),
    servedBy: nullable(uuidSchema()),
    closedBy: nullable(uuidSchema()),
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
    subtotal: moneyStringSchema(),
    discountTotal: moneyStringSchema(),
    serviceChargeTotal: moneyStringSchema(),
    taxTotal: moneyStringSchema(),
    roundingAdjustment: moneyStringSchema(),
    grandTotal: moneyStringSchema(),
    paidTotal: moneyStringSchema(),
    tipTotal: moneyStringSchema(),
    openedAt: isoDateTimeSchema(),
    firstFiredAt: nullable(isoDateTimeSchema()),
    completedAt: nullable(isoDateTimeSchema()),
    originDeviceTime: isoDateTimeSchema(),
    countryPackVersion: {
      type: 'integer',
      description:
        'FR-LOC-021 — the pack version this order was priced under, pinned.',
    },
    notes: nullable({ type: 'string' }),
    version: {
      type: 'integer',
      description:
        'Optimistic-concurrency version; also the ETag validator (§24.6.4).',
    },
    createdAt: isoDateTimeSchema(),
    updatedAt: isoDateTimeSchema(),
    lines: {
      type: 'array',
      items: orderLineSchema,
      description: 'Present only where the endpoint populates line snapshots.',
    },
  },
};

const etagHeader = {
  ETag: {
    description:
      'Weak validator W/"<orderId>.<version>" for this order — send back as If-Match on the next mutation.',
    schema: {
      type: 'string',
      example: 'W/"3fa85f64-5717-4562-b3fc-2c963f66afa6.4"',
    },
  },
};

@ApiTags('sales')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@ApiNotFoundResponse({ description: 'Unknown or cross-tenant resource.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@AllowPosSession()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly lines: OrderLinesService,
  ) {}

  /**
   * Open an order — FR-POS-001, FR-API-020.
   *
   * `Idempotency-Key` is MANDATORY: an order is a financially significant
   * record, and a retried request over a flaky connection must not open a second
   * one. The interceptor stores the response, so a replay returns the SAME order
   * with `Idempotent-Replay: true`.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(SALES_PERMISSIONS.ORDER_CREATE)
  @ApiOperation({ summary: 'Open an order.' })
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original order unchanged (Idempotent-Replay: true).',
  })
  @ApiCreatedResponse({
    description: 'The newly opened order.',
    schema: orderSchema,
    headers: etagHeader,
  })
  @ApiBadRequestResponse({
    description:
      'Missing/over-long Idempotency-Key, or an invalid request body.',
  })
  @ApiConflictResponse({
    description:
      'The Idempotency-Key was already used with a different request body, or is still in flight.',
  })
  async create(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const terminalId = this.resolveTerminal(principal, dto.terminalId);
    const employeeId = this.resolveEmployee(principal, dto.openedByEmployeeId);

    const order = await this.orders.create(context.tenantId, context.userId, {
      ...(dto.id ? { id: dto.id } : {}),
      terminalId,
      openedByEmployeeId: employeeId,
      orderType: dto.orderType,
      channel: dto.channel,
      tableId: dto.tableId ?? null,
      guestCount: dto.guestCount ?? null,
      originDeviceTime: new Date(dto.originDeviceTime),
      // `IdempotencyInterceptor` has already rejected a missing or over-long
      // header (FR-API-020), so the value is present and bounded here. It is
      // persisted on the row as well: `uq_orders_idempotency (tenant_id,
      // idempotency_key, business_day)` is the last line of defence beneath the
      // interceptor's store, so even a bypassed store cannot open two orders
      // under one key on one business day.
      idempotencyKey,
      notes: dto.notes ?? null,
    });

    response.setHeader('ETag', orderETag(order));
    return toOrderView(order);
  }

  @Get()
  @RequirePermission(SALES_PERMISSIONS.ORDER_CREATE)
  @ApiOperation({ summary: 'List orders, cursor-paginated.' })
  @ApiOkResponse({
    description:
      'A page of orders (no line snapshots) plus an opaque cursor for the next page.',
    schema: {
      type: 'object',
      properties: {
        orders: { type: 'array', items: orderSchema },
        nextCursor: nullable({
          type: 'object',
          description:
            'Pass businessDay as cursorBusinessDay and id as cursorId to fetch the next page. Null on the last page.',
          properties: { businessDay: businessDaySchema(), id: uuidSchema() },
        }),
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'A cursor was given with only one of cursorBusinessDay/cursorId.',
  })
  async list(
    @CurrentTenantContext() context: TenantContext,
    @Query() query: ListOrdersQueryDto,
  ) {
    if (
      (query.cursorId === undefined) !==
      (query.cursorBusinessDay === undefined)
    ) {
      throw new BadRequestException(
        'A cursor needs both cursorBusinessDay and cursorId.',
      );
    }
    const { orders, nextCursor } = await this.orders.list(context.tenantId, {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.cursorId && query.cursorBusinessDay
        ? {
            cursor: {
              businessDay: parseBusinessDay(query.cursorBusinessDay),
              id: query.cursorId,
            },
          }
        : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return { orders: orders.map((o) => toOrderView(o)), nextCursor };
  }

  /**
   * One order with its persisted line snapshots.
   *
   * The business day is part of the path because it is part of the primary key
   * of a partitioned table — reading by id alone would have to scan every
   * partition.
   */
  @Get(':businessDay/:id')
  @RequirePermission(SALES_PERMISSIONS.ORDER_CREATE)
  @ApiOperation({ summary: 'One order, with its persisted line snapshots.' })
  @ApiOkResponse({
    description: 'The order, including its lines.',
    schema: orderSchema,
    headers: etagHeader,
  })
  async findOne(
    @CurrentTenantContext() context: TenantContext,
    @Param() params: OrderPathParamsDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const order = await this.orders.findOne(
      context.tenantId,
      params.id,
      parseBusinessDay(params.businessDay),
    );
    if (!order) throw new NotFoundException('Order not found.');

    // §26: If-Match with ETag on updates. The validator is published now so a
    // client already holds one when line mutation becomes available.
    response.setHeader('ETag', orderETag(order));
    return toOrderView(order);
  }

  /**
   * Capture a line — BR-POS-004, FR-POS-040/041/042, FR-API-020.
   *
   * `Idempotency-Key` AND `If-Match` are both mandatory. The key stops a retried
   * request adding the item twice; the version stops a cashier's edit landing on
   * an order another terminal has already changed. Neither substitutes for the
   * other: a replay is the same request arriving twice, a stale If-Match is a
   * different request arriving late.
   */
  @Post(':businessDay/:id/lines')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(SALES_PERMISSIONS.ORDER_CREATE)
  @ApiOperation({ summary: 'Capture a line on an open order.' })
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiHeader({
    name: 'if-match',
    required: true,
    description:
      'The order\'s current ETag (W/"<orderId>.<version>") or a bare version integer. Not "*".',
  })
  @ApiCreatedResponse({
    description: 'The newly captured line and the order it now belongs to.',
    schema: {
      type: 'object',
      properties: { line: orderLineSchema, order: orderSchema },
    },
    headers: etagHeader,
  })
  @ApiBadRequestResponse({
    description:
      'Missing/malformed If-Match, missing/over-long Idempotency-Key, or an invalid request body.',
  })
  @ApiConflictResponse({
    description:
      'The If-Match version is stale (someone else changed the order first), or the Idempotency-Key was already used with a different request body / is still in flight.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The item/variant is not active, no active price applies, the item is priced in a different currency than the order, or a similar business-rule refusal.',
  })
  async addLine(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() params: OrderPathParamsDto,
    @Body() dto: AddOrderLineDto,
    @Headers('if-match') ifMatch: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.requireTerminal(principal);
    const { line, order } = await this.lines.addLine(
      context.tenantId,
      context.userId,
      params.id,
      parseBusinessDay(params.businessDay),
      {
        ...(dto.id ? { id: dto.id } : {}),
        menuItemId: dto.menuItemId,
        variantId: dto.variantId,
        quantity: dto.quantity,
        ...(dto.modifiers ? { modifiers: dto.modifiers } : {}),
        course: dto.course ?? null,
        seatNumber: dto.seatNumber ?? null,
        notes: dto.notes ?? null,
        expectedVersion: parseIfMatch(ifMatch, params.id),
      },
    );

    response.setHeader('ETag', orderETag(order));
    return { line: toOrderLineView(line), order: toOrderView(order) };
  }

  /**
   * Void a PRE-FIRE line — the cashier's ordinary correction (Clarification C).
   *
   * DELETE is the HTTP verb; the domain operation is a VOID. The row is retained
   * in state `voided`, because a deleted line leaves no evidence that an item was
   * rung up and removed. Once a line is fired this returns 422: the post-fire
   * path is privileged and no ratified permission authorises it, so it is not
   * implemented rather than approximated.
   */
  @Delete(':businessDay/:id/lines/:lineId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE)
  @ApiOperation({
    summary: 'Void a pre-fire line (the ordinary cashier correction).',
  })
  @ApiHeader({
    name: 'if-match',
    required: true,
    description:
      'The order\'s current ETag (W/"<orderId>.<version>") or a bare version integer. Not "*".',
  })
  @ApiOkResponse({
    description: 'The voided line and the order it belongs to.',
    schema: {
      type: 'object',
      properties: { line: orderLineSchema, order: orderSchema },
    },
    headers: etagHeader,
  })
  @ApiBadRequestResponse({
    description: 'Missing or malformed If-Match header.',
  })
  @ApiConflictResponse({
    description:
      'The If-Match version is stale — someone else changed the order first.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The line has already been fired; the post-fire path is privileged and not implemented here, or a similar business-rule refusal.',
  })
  async voidLine(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() params: OrderLinePathParamsDto,
    @Body() dto: VoidOrderLineDto,
    @Headers('if-match') ifMatch: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.requireTerminal(principal);
    const { line, order } = await this.lines.voidLinePreFire(
      context.tenantId,
      context.userId,
      params.id,
      parseBusinessDay(params.businessDay),
      params.lineId,
      {
        expectedVersion: parseIfMatch(ifMatch, params.id),
        reasonCodeId: dto.reasonCodeId,
      },
    );

    response.setHeader('ETag', orderETag(order));
    return { line: toOrderLineView(line), order: toOrderView(order) };
  }

  // ------------------------------------------------------------- internals

  /** Every Sales WRITE happens at a registered terminal (FR-SEC-028). */
  private requireTerminal(principal: AuthenticatedPrincipal): string {
    if (!principal.terminalId) {
      throw new ForbiddenException(
        'This operation requires a terminal-bound session.',
      );
    }
    return principal.terminalId;
  }

  /**
   * The terminal is taken from the SESSION, never from the body.
   *
   * A body value is accepted only as a redundant assertion and must match: a
   * terminal-bound token is the server's own statement about which device is
   * calling, and letting a request name a different one would let any terminal
   * book sales onto another branch.
   */
  private resolveTerminal(
    principal: AuthenticatedPrincipal,
    fromBody: string | undefined,
  ): string {
    if (!principal.terminalId) {
      throw new ForbiddenException(
        'Opening an order requires a terminal-bound session.',
      );
    }
    if (fromBody && fromBody !== principal.terminalId) {
      throw new ForbiddenException(
        'That terminal does not match the one this session is bound to.',
      );
    }
    return principal.terminalId;
  }

  /**
   * The acting employee comes from a PIN session's own claim.
   *
   * A non-PIN session has no employee identity, so it must name one; the service
   * then enforces the FR-SEC-021 permitted-branch rule on whatever it names, so
   * naming another employee cannot cross a branch boundary.
   */
  private resolveEmployee(
    principal: AuthenticatedPrincipal,
    fromBody: string | undefined,
  ): string {
    if (principal.employeeId) {
      if (fromBody && fromBody !== principal.employeeId) {
        throw new ForbiddenException(
          'A PIN session opens orders as the employee who signed in.',
        );
      }
      return principal.employeeId;
    }
    if (!fromBody) {
      throw new BadRequestException(
        'openedByEmployeeId is required for a session with no employee identity.',
      );
    }
    return fromBody;
  }
}

/**
 * Parse `If-Match` into the order version it asserts.
 *
 * Accepts the weak validator this API emits (`W/"<id>.<version>"`) and a bare
 * version number, which is what a hand-written client tends to send. `*` is
 * REFUSED: on a financial mutation "any version" is not a precondition, it is
 * the absence of one.
 */
function parseIfMatch(header: string | undefined, orderId: string): number {
  const raw = (header ?? '').trim();
  if (raw.length === 0) {
    throw new BadRequestException(
      'An If-Match header carrying the order version is required for this operation.',
    );
  }
  if (raw === '*') {
    throw new BadRequestException(
      'If-Match: * is not accepted on a financial mutation; send the order ETag.',
    );
  }
  const tagged = /^W\/"([0-9a-f-]{36})\.(\d{1,9})"$/i.exec(raw);
  if (tagged) {
    if (tagged[1].toLowerCase() !== orderId.toLowerCase()) {
      throw new BadRequestException('That ETag belongs to a different order.');
    }
    return Number.parseInt(tagged[2], 10);
  }
  if (/^\d{1,9}$/.test(raw)) return Number.parseInt(raw, 10);
  throw new BadRequestException('Malformed If-Match header.');
}

/** Parse a `YYYY-MM-DD` path/query value into the UTC midnight a DATE holds. */
function parseBusinessDay(value: string): Date {
  const [y, m, d] = value.split('-').map((p) => Number.parseInt(p, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new BadRequestException(`${value} is not a real calendar date.`);
  }
  return date;
}
