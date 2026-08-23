import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  decimalStringSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import { JwtAuthGuard } from '../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../identity/context/tenant-context';
import { TenantContextGuard } from '../identity/context/tenant-context.guard';
import { CountsService } from './counts/counts.service';
import {
  ChangeBaseUnitDto,
  CreateReasonCodeDto,
  CreateStockItemDto,
  DispatchTransferDto,
  OpenCountDto,
  PostMovementDto,
  ReceiveTransferDto,
  RecordCountDto,
  RecordWasteDto,
  SetReorderConfigDto,
} from './inventory.dto';
import { INVENTORY_PERMISSIONS } from './inventory.permissions';
import { MovementsService } from './movements/movements.service';
import { TransfersService } from './movements/transfers.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { StockItemsService } from './stock-items/stock-items.service';
import { WasteService } from './waste/waste.service';

/**
 * Inventory API.
 *
 * Guard chain unchanged: JwtAuthGuard (401) -> TenantContextGuard (403) ->
 * PermissionGuard (403). Authorization is TENANT-scoped; ADR 0008 D-02's
 * deferral of branch-scoped RBAC still stands, so no handler reads
 * `TenantContext.branchId`.
 *
 * All ten permission codes are SRS-attested (§15.2). None invented.
 * `inventory.cost.view` gates the cost-bearing reads specifically.
 */

// Shapes verified against each service's actual return statement (`view()` in
// `stock-items.service.ts`, the mapped rows in `movements.service.ts`,
// `transfers.service.ts`, `counts.service.ts`, `waste.service.ts` and
// `reconciliation.service.ts`) — not against the Prisma schema or the SRS.

const stockItemSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    sku: { type: 'string' },
    names: {
      type: 'object',
      description: 'Opaque localized-name object (locale -> name).',
    },
    categoryId: nullable(uuidSchema()),
    baseUnitId: uuidSchema(),
    recipeUnitId: nullable(uuidSchema()),
    costingMethod: {
      type: 'string',
      enum: ['weighted_average', 'fifo', 'standard'],
    },
    standardCost: nullable(
      moneyStringSchema(
        'Cost per base unit as a decimal string of minor units.',
      ),
    ),
    isBatchTracked: { type: 'boolean' },
    expiryTracked: { type: 'boolean' },
    shelfLifeDays: nullable({ type: 'integer' }),
    batchStrategy: { type: 'string', enum: ['fifo', 'fefo'] },
    isActive: { type: 'boolean' },
  },
};

const reasonCodeSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    category: { type: 'string' },
    code: { type: 'string' },
    label: {
      type: 'object',
      description: 'Opaque localized-label object (locale -> label).',
    },
  },
};

const reorderConfigSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    stockItemId: uuidSchema(),
    locationId: uuidSchema(),
    reorderPoint: nullable(decimalStringSchema()),
    reorderQuantity: nullable(decimalStringSchema()),
  },
};

// `POST /inventory/movements` (postStandalone -> `MovementsService.post`).
// NOTE (documented as observed, not "fixed"): `balanceAfter` here is a plain
// JS number (`currentQty + input.quantity`, both already-converted numbers),
// whereas the SAME conceptual field on the ledger read below
// (`listForItem`) is a decimal STRING (`m.balanceAfter.toString()`). This is
// a real, pre-existing inconsistency between the two endpoints, not
// something this documentation pass changes.
const postedMovementSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    occurredAt: isoDateTimeSchema(),
    balanceAfter: {
      type: 'number',
      description:
        'Stock balance after this movement. A JS number here, not a string — see the schema-level note.',
    },
    unitCost: moneyStringSchema('Cost per base unit for this movement.'),
    totalCost: moneyStringSchema(),
    consumedBatches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { batchId: uuidSchema(), quantity: { type: 'number' } },
      },
    },
  },
};

const movementLedgerEntrySchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    occurredAt: isoDateTimeSchema(),
    locationId: uuidSchema(),
    movementType: {
      type: 'string',
      enum: [
        'purchase_receipt',
        'purchase_return',
        'sale_depletion',
        'sale_reversal',
        'transfer_out',
        'transfer_in',
        'production_input',
        'production_output',
        'waste',
        'count_adjustment',
        'manual_adjustment',
        'opening_balance',
        'expiry_writeoff',
      ],
    },
    quantity: decimalStringSchema('Signed: negative = out of stock.'),
    balanceAfter: decimalStringSchema(),
    batchId: nullable(uuidSchema()),
    referenceType: { type: 'string' },
    referenceId: uuidSchema(),
    counterpartMovementId: nullable(uuidSchema()),
  },
};

const transferDispatchSchema = {
  type: 'object',
  properties: {
    transferReferenceId: uuidSchema(),
    dispatchMovementId: uuidSchema(),
    quantityDispatched: { type: 'number' },
    unitCost: moneyStringSchema(),
  },
};

const transferReceiveSchema = {
  type: 'object',
  properties: {
    transferReferenceId: uuidSchema(),
    receiveMovementId: uuidSchema(),
    quantityDispatched: { type: 'number' },
    quantityReceived: { type: 'number' },
    discrepancy: { type: 'number' },
    adjustmentMovementId: nullable(
      uuidSchema(
        'The manual_adjustment movement written for the discrepancy, or null when none was needed.',
      ),
    ),
  },
};

const countSessionSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    scopeType: {
      type: 'string',
      enum: ['full_location', 'category', 'item_list'],
    },
    isBlindCount: { type: 'boolean' },
    status: { type: 'string', enum: ['in_progress', 'posted', 'cancelled'] },
    lineCount: { type: 'integer' },
  },
};

const countLineSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    stockItemId: uuidSchema(),
    expectedQuantity: nullable(
      decimalStringSchema(
        'Hidden (returned null) while the session is a blind count still in progress.',
      ),
    ),
    countedQuantity: nullable(decimalStringSchema()),
    variance: nullable(decimalStringSchema()),
  },
};

const recordCountResultSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    countedQuantity: nullable(decimalStringSchema()),
    variance: nullable(decimalStringSchema()),
  },
};

const postCountResultSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    status: { type: 'string', enum: ['posted'] },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { stockItemId: uuidSchema(), variance: { type: 'number' } },
      },
    },
    movementsDuringCountWindow: {
      type: 'integer',
      description:
        'FR-INV-044: reported, not folded into the variance — the expected quantity was frozen at open.',
    },
  },
};

const wasteRecordCreateSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    totalValue: moneyStringSchema(),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { stockItemId: uuidSchema(), movementId: uuidSchema() },
      },
    },
  },
};

const wasteRecordListEntrySchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    locationId: uuidSchema(),
    reasonCodeId: uuidSchema(),
    totalValue: moneyStringSchema(),
    requiresApproval: { type: 'boolean' },
    recordedAt: isoDateTimeSchema(),
  },
};

const levelSchema = {
  type: 'object',
  properties: {
    stockItemId: uuidSchema(),
    locationId: uuidSchema(),
    quantityOnHand: decimalStringSchema(),
    quantityReserved: decimalStringSchema(),
    lastReconciledAt: nullable(isoDateTimeSchema()),
  },
};

const reconcileResultSchema = {
  type: 'object',
  properties: {
    divergences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stockItemId: uuidSchema(),
          locationId: uuidSchema(),
          projected: decimalStringSchema('The stock_levels projection.'),
          ledger: decimalStringSchema('The sum of ledger movements.'),
        },
      },
    },
    reconciled: {
      type: 'boolean',
      description: 'True when divergences is empty.',
    },
    note: { type: 'string' },
  },
};

const negativeStockEntrySchema = {
  type: 'object',
  properties: {
    stockItemId: uuidSchema(),
    locationId: uuidSchema(),
    quantityOnHand: decimalStringSchema(),
  },
};

const expiringBatchSchema = {
  type: 'object',
  properties: {
    batchId: uuidSchema(),
    stockItemId: uuidSchema(),
    locationId: uuidSchema(),
    expiryDate: nullable(
      isoDateTimeSchema(
        'A DATE column returned as a full ISO instant (midnight UTC) — not truncated to YYYY-MM-DD in this response.',
      ),
    ),
    quantityRemaining: decimalStringSchema(),
  },
};

const lowStockEntrySchema = {
  type: 'object',
  properties: {
    stockItemId: uuidSchema(),
    locationId: uuidSchema(),
    reorderPoint: nullable(decimalStringSchema()),
    reorderQuantity: nullable(decimalStringSchema()),
    quantityOnHand: decimalStringSchema(),
  },
};

@ApiTags('inventory')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@ApiForbiddenResponse({
  description: 'No tenant context / insufficient permission.',
})
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly items: StockItemsService,
    private readonly movements: MovementsService,
    private readonly transfers: TransfersService,
    private readonly counts: CountsService,
    private readonly waste: WasteService,
    private readonly recon: ReconciliationService,
  ) {}

  // ------------------------------------------------------- stock item master --
  @Post('items')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  @ApiOperation({ summary: 'Create a stock item (FR-INV-001).' })
  @ApiCreatedResponse({
    description: 'The created stock item.',
    schema: stockItemSchema,
  })
  @ApiNotFoundResponse({ description: 'Unit, category or location not found.' })
  @ApiConflictResponse({
    description: 'A stock item with this SKU already exists in the tenant.',
  })
  createItem(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateStockItemDto,
  ) {
    return this.items.create(c.tenantId, c.userId, dto);
  }

  @Get('items')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: 'All stock items in the tenant.',
    schema: { type: 'array', items: stockItemSchema },
  })
  listItems(@CurrentTenantContext() c: TenantContext) {
    return this.items.list(c.tenantId);
  }

  @Get('items/:itemId')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({ description: 'The stock item.', schema: stockItemSchema })
  @ApiNotFoundResponse({ description: 'Stock item not found.' })
  getItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.findOne(c.tenantId, id);
  }

  /** FR-INV-002: rejected once any movement exists. */
  @Post('items/:itemId/base-unit')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  @ApiOkResponse({
    description: 'The updated stock item.',
    schema: stockItemSchema,
  })
  @ApiNotFoundResponse({ description: 'Stock item not found.' })
  @ApiConflictResponse({
    description:
      'Base unit is immutable once stock movements exist (FR-INV-002).',
  })
  changeBaseUnit(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: ChangeBaseUnitDto,
  ) {
    return this.items.changeBaseUnit(c.tenantId, c.userId, id, dto.baseUnitId);
  }

  /** FR-INV-065: per-location reorder configuration. */
  @Post('items/:itemId/reorder-config')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  @ApiOkResponse({
    description: 'The upserted reorder configuration.',
    schema: reorderConfigSchema,
  })
  @ApiNotFoundResponse({ description: 'Unit, category or location not found.' })
  setReorderConfig(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: SetReorderConfigDto,
  ) {
    return this.items.setReorderConfig(
      c.tenantId,
      c.userId,
      id,
      dto.locationId,
      dto.reorderPoint,
      dto.reorderQuantity,
    );
  }

  @Post('reason-codes')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  @ApiCreatedResponse({
    description: 'The created reason code.',
    schema: reasonCodeSchema,
  })
  @ApiNotFoundResponse({ description: 'Reason code parent not found.' })
  @ApiConflictResponse({
    description: 'A reason code with this category and code already exists.',
  })
  createReasonCode(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateReasonCodeDto,
  ) {
    return this.items.createReasonCode(
      c.tenantId,
      c.userId,
      dto.category,
      dto.code,
      dto.label,
    );
  }

  @Get('reason-codes')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: 'All reason codes in the tenant.',
    schema: { type: 'array', items: reasonCodeSchema },
  })
  listReasonCodes(@CurrentTenantContext() c: TenantContext) {
    return this.items.listReasonCodes(c.tenantId);
  }

  // ------------------------------------------------------------------ ledger --
  @Post('movements')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  @ApiOperation({
    summary:
      'Post a standalone movement (opening balance / manual adjustment) to the ledger.',
  })
  @ApiCreatedResponse({
    description: 'The posted movement.',
    schema: postedMovementSchema,
  })
  @ApiNotFoundResponse({ description: 'Stock item or location not found.' })
  postMovement(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: PostMovementDto,
  ) {
    return this.movements.postStandalone(c.tenantId, c.userId, {
      locationId: dto.locationId,
      stockItemId: dto.stockItemId,
      movementType: dto.movementType,
      quantity: Number(dto.quantity),
      referenceType: dto.referenceType,
      referenceId: dto.referenceId,
      reasonCodeId: dto.reasonCodeId,
      notes: dto.notes,
      ...(dto.unitCost !== undefined ? { unitCost: BigInt(dto.unitCost) } : {}),
    });
  }

  /** Cost-bearing read — gated by inventory.cost.view, not inventory.view. */
  @Get('items/:itemId/movements')
  @RequirePermission(INVENTORY_PERMISSIONS.COST_VIEW)
  @ApiOkResponse({
    description:
      'The most recent 200 ledger movements for this item, newest first.',
    schema: { type: 'array', items: movementLedgerEntrySchema },
  })
  listMovements(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') itemId: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.movements.listForItem(c.tenantId, itemId, locationId);
  }

  // --------------------------------------------------------------- transfers --
  @Post('transfers')
  @RequirePermission(INVENTORY_PERMISSIONS.TRANSFER_CREATE)
  @ApiOperation({
    summary: 'Dispatch a transfer (writes the transfer_out leg).',
  })
  @ApiCreatedResponse({
    description: 'The dispatched transfer.',
    schema: transferDispatchSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Quantity is not positive, or source and destination locations are the same.',
  })
  @ApiNotFoundResponse({ description: 'Stock item or location not found.' })
  dispatch(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: DispatchTransferDto,
  ) {
    return this.transfers.dispatch(c.tenantId, c.userId, {
      stockItemId: dto.stockItemId,
      fromLocationId: dto.fromLocationId,
      toLocationId: dto.toLocationId,
      quantity: Number(dto.quantity),
      reasonCodeId: dto.reasonCodeId,
      notes: dto.notes,
    });
  }

  @Post('transfers/receive')
  @RequirePermission(INVENTORY_PERMISSIONS.TRANSFER_RECEIVE)
  @ApiOperation({
    summary:
      'Receive a dispatched transfer (writes the transfer_in leg, plus a discrepancy adjustment if the received quantity differs).',
  })
  @ApiCreatedResponse({
    description: 'The received transfer.',
    schema: transferReceiveSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Transfer not found, already received, or a receiving discrepancy without a reason code.',
  })
  receive(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: ReceiveTransferDto,
  ) {
    return this.transfers.receive(c.tenantId, c.userId, dto.toLocationId, {
      transferReferenceId: dto.transferReferenceId,
      receivedQuantity: Number(dto.receivedQuantity),
      discrepancyReasonCodeId: dto.discrepancyReasonCodeId,
    });
  }

  // ------------------------------------------------------------------ counts --
  @Post('counts')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_PERFORM)
  @ApiOperation({
    summary:
      'Open a count session and freeze expected quantities for its scope.',
  })
  @ApiCreatedResponse({
    description: 'The opened count session.',
    schema: countSessionSchema,
  })
  @ApiBadRequestResponse({
    description:
      'scopeId/itemIds required-or-forbidden mismatch for the given scopeType.',
  })
  @ApiNotFoundResponse({ description: 'Location, category or item not found.' })
  openCount(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: OpenCountDto,
  ) {
    return this.counts.open(c.tenantId, c.userId, dto);
  }

  @Get('counts/:sessionId/lines')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_PERFORM)
  @ApiOkResponse({
    description:
      "This session's count lines. expectedQuantity/countedQuantity/variance are null while a blind count is still in_progress and not yet recorded.",
    schema: { type: 'array', items: countLineSchema },
  })
  @ApiNotFoundResponse({ description: 'Count session not found.' })
  countLines(
    @CurrentTenantContext() c: TenantContext,
    @Param('sessionId') id: string,
  ) {
    return this.counts.lines(c.tenantId, id);
  }

  @Post('count-lines/:lineId')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_PERFORM)
  @ApiOperation({ summary: 'Record a counted quantity for one count line.' })
  @ApiCreatedResponse({
    description: 'The updated count line.',
    schema: recordCountResultSchema,
  })
  @ApiNotFoundResponse({ description: 'Count line not found.' })
  @ApiBadRequestResponse({
    description: 'The count session is not in_progress.',
  })
  recordCount(
    @CurrentTenantContext() c: TenantContext,
    @Param('lineId') lineId: string,
    @Body() dto: RecordCountDto,
  ) {
    return this.counts.recordCount(
      c.tenantId,
      c.userId,
      lineId,
      Number(dto.countedQuantity),
    );
  }

  @Post('counts/:sessionId/post')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_POST)
  @ApiOperation({
    summary:
      'Post a count session: writes count_adjustment movements bringing recorded stock to counted stock.',
  })
  @ApiCreatedResponse({
    description: 'The posted count session.',
    schema: postCountResultSchema,
  })
  @ApiNotFoundResponse({ description: 'Count session not found.' })
  @ApiBadRequestResponse({
    description: 'The count session has already been posted.',
  })
  @ApiForbiddenResponse({
    description:
      'The session requires approval, which the Governance workflow does not yet implement — posting is refused rather than completed unapproved.',
  })
  postCount(
    @CurrentTenantContext() c: TenantContext,
    @Param('sessionId') id: string,
  ) {
    return this.counts.post(c.tenantId, c.userId, id);
  }

  // ------------------------------------------------------------------- waste --
  @Post('waste')
  @RequirePermission(INVENTORY_PERMISSIONS.WASTE_RECORD)
  @ApiOperation({
    summary:
      'Record waste (writes waste movements for each line; FR-INV-055…059).',
  })
  @ApiCreatedResponse({
    description: 'The recorded waste.',
    schema: wasteRecordCreateSchema,
  })
  @ApiNotFoundResponse({
    description: 'Location, reason code or stock item not found.',
  })
  @ApiForbiddenResponse({
    description:
      'requiresApproval was set — the Governance approval workflow is not implemented in this phase, so the posting is refused rather than completed unapproved.',
  })
  recordWaste(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: RecordWasteDto,
  ) {
    return this.waste.record(c.tenantId, c.userId, {
      locationId: dto.locationId,
      reasonCodeId: dto.reasonCodeId,
      lines: dto.lines.map((l) => ({
        stockItemId: l.stockItemId,
        quantity: Number(l.quantity),
      })),
      requiresApproval: dto.requiresApproval,
      notes: dto.notes,
    });
  }

  @Get('waste')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: 'The most recent 200 waste records, newest first.',
    schema: { type: 'array', items: wasteRecordListEntrySchema },
  })
  listWaste(@CurrentTenantContext() c: TenantContext) {
    return this.waste.list(c.tenantId);
  }

  // --------------------------------- levels / on-demand computations (D-INV-08) --
  @Get('levels')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: 'Current stock levels (FR-INV-010/015).',
    schema: { type: 'array', items: levelSchema },
  })
  levels(
    @CurrentTenantContext() c: TenantContext,
    @Query('locationId') locationId?: string,
  ) {
    return this.recon.levels(c.tenantId, locationId);
  }

  /** FR-INV-011/051 computation. Scheduling deferred (D-INV-08). */
  @Get('reconciliation')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description:
      'On-demand ledger-vs-projection reconciliation (FR-INV-011/051). Scheduling and alert delivery are deferred (D-INV-08).',
    schema: reconcileResultSchema,
  })
  reconcile(@CurrentTenantContext() c: TenantContext) {
    return this.recon.reconcile(c.tenantId);
  }

  /** FR-INV-014 computation. Alert delivery deferred. */
  @Get('negative-stock')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description:
      'Stock levels currently below zero (FR-INV-014; negative levels are permitted and recorded, this surfaces them).',
    schema: { type: 'array', items: negativeStockEntrySchema },
  })
  negativeStock(@CurrentTenantContext() c: TenantContext) {
    return this.recon.negativeStock(c.tenantId);
  }

  /** FR-INV-024 computation. Alert delivery deferred. */
  @Get('expiring')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: 'Batches expiring within `days` (default 7) (FR-INV-024).',
    schema: { type: 'array', items: expiringBatchSchema },
  })
  expiring(
    @CurrentTenantContext() c: TenantContext,
    @Query('days') days?: string,
  ) {
    return this.recon.expiring(c.tenantId, days ? Number(days) : 7);
  }

  /** FR-INV-066 computation against per-location reorder points. */
  @Get('low-stock')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description:
      'Levels below their per-location reorder point (FR-INV-066/065).',
    schema: { type: 'array', items: lowStockEntrySchema },
  })
  lowStock(@CurrentTenantContext() c: TenantContext) {
    return this.recon.lowStock(c.tenantId);
  }
}
